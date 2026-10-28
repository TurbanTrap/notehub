mod fingerprint;
mod history;
mod import;
mod index;
mod page;
mod paths;
mod vault;
mod watch;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use history::Version;
use index::{LinkRef, SearchHit, TagCount};
use page::Page;
use vault::TreeNode;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Config {
    last_vault: Option<String>,
}

/// A vault that opened, along with anything that went wrong while opening it but did
/// not stop the notes from being usable.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenResult {
    tree: Vec<TreeNode>,
    warnings: Vec<String>,
}

/// A page as it is on disk, with the fingerprint of the exact bytes that were read.
///
/// The interface holds on to the fingerprint and hands it back when saving, which is
/// how a save can tell that the file has changed underneath it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageRead {
    page: Page,
    hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    page: Page,
    hash: String,
    /// Where the person's text went when the file on disk had already moved on. When
    /// this is set, the page itself was left exactly as it was found.
    conflict_path: Option<String>,
}

/// Ask the person to choose a folder for their notes.
///
/// `async` is not decoration. A command without it runs on the main thread, and
/// `blocking_pick_folder` waits there for a result that only the main thread can
/// deliver — so the window locks up the moment a folder is chosen. The `async` form
/// runs the body on a worker thread instead, which is what the plugin's own
/// documentation asks for.
#[tauri::command(async)]
fn pick_vault(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose a folder for your notes")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// Ask the person for a folder of existing Markdown to bring in.
///
/// `async` for the same reason as `pick_vault`: on the main thread this deadlocks.
#[tauri::command(async)]
fn pick_import_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose a folder of Markdown files to import")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// Copy a folder of Markdown into the vault as a new notebook.
///
/// Nothing in the source folder is changed; it is read and copied. When no title is
/// given the folder's own name is used, which is almost always what was meant.
#[tauri::command(async)]
fn import_folder(
    app: tauri::AppHandle,
    vault_path: String,
    source: String,
    title: Option<String>,
) -> Result<import::ImportSummary, String> {
    let source_path = PathBuf::from(&source);
    let fallback = source_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "Imported".into());
    let title = clean_title(title.as_deref().unwrap_or_default(), &fallback);

    let summary = import::import_folder(Path::new(&vault_path), &source_path, &title)?;

    // A whole notebook at once, so the index is rebuilt rather than nudged.
    if let Ok(db) = index_db(&app, &vault_path) {
        let _ = index::reindex(&db, Path::new(&vault_path));
    }

    Ok(summary)
}

// Everything below that reads or writes files, or touches the search index, is marked
// `#[tauri::command(async)]`. A plain command runs on the main thread, which is also
// the thread drawing the window: a slow one freezes the app. Only the three commands
// that hand work straight to the system — reading the stored vault path, revealing a
// folder, opening a link — stay on it, and none of them waits for anything.

/// The vault opened last time, if it is still on disk. A folder that has gone away —
/// an unmounted drive, a sync folder not yet downloaded — is reported as absent so the
/// app falls back to the welcome screen instead of erroring on every call.
#[tauri::command]
fn last_vault(app: tauri::AppHandle) -> Option<String> {
    let path = read_config(&app).last_vault?;
    Path::new(&path).is_dir().then_some(path)
}

#[tauri::command(async)]
fn open_vault(app: tauri::AppHandle, path: String) -> Result<OpenResult, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("that folder does not exist".into());
    }

    vault::ensure(&root)?;

    let mut warnings = Vec::new();

    // Images are shown straight from the vault folder, which the webview may not read
    // until the folder is let through the asset protocol scope. The vault is chosen at
    // runtime, so this cannot be a static entry in tauri.conf.json.
    //
    // A warning rather than an error: when this fails the notes are perfectly usable
    // and only the images render as broken boxes, so refusing to open the vault at all
    // would be the worse outcome — and would contradict what the message says.
    if let Err(e) = app.asset_protocol_scope().allow_directory(&root, true) {
        warnings.push(format!(
            "Your notes opened, but images cannot be shown from this folder: {e}"
        ));
    }

    // Also a warning: without the watcher the app simply finds out about an incoming
    // change when it next saves instead of straight away, and the fingerprint check in
    // `save_page` still stops anything being overwritten.
    if let Err(e) = watch::start(&app, &root) {
        warnings.push(format!(
            "{e}. Notes arriving from your other machine will show up when you reopen a page."
        ));
    }

    write_config(&app, &Config { last_vault: Some(path) });

    Ok(OpenResult {
        tree: vault::read_tree(&root)?,
        warnings,
    })
}

/// Store a pasted or dropped file next to the page, returning the relative path to
/// write into the Markdown. `data_base64` carries the bytes, since that survives the
/// JavaScript bridge without the cost of sending a large array of numbers.
#[tauri::command(async)]
fn save_asset(page_path: String, filename: String, data_base64: String) -> Result<String, String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("that file could not be read: {e}"))?;

    vault::save_asset(Path::new(&page_path), &filename, &bytes)
}

/// The image formats a dropped file is allowed to be.
///
/// An allowlist rather than "whatever the webview might render": a drop is the one
/// place a file arrives by its path alone, and copying an arbitrary file into the
/// notes because it was dragged over the window is not something to do quietly.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|ext| IMAGE_EXTENSIONS.contains(&ext.as_str()))
}

/// Copy a file that is already on disk into the page's assets folder.
///
/// Dragging a file in gives us its path, not its bytes. Reading it in the web layer
/// only to encode it as base64 and send it back across the bridge would be a long way
/// round for a screenshot, so the copy happens here.
#[tauri::command(async)]
fn add_asset_from_path(page_path: String, source: String) -> Result<String, String> {
    let source = Path::new(&source);
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "that file has no name".to_string())?;

    if !source.is_file() {
        return Err(format!("{name} is not a file"));
    }

    if !is_image_path(source) {
        return Err(format!("{name} is not an image NoteHub can show"));
    }

    let bytes = std::fs::read(source).map_err(|e| format!("could not read {name}: {e}"))?;
    vault::save_asset(Path::new(&page_path), &name, &bytes)
}

/// Where this vault's search index lives — outside the vault, in the app's cache.
fn index_db(app: &tauri::AppHandle, vault_path: &str) -> Result<PathBuf, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not find the cache folder: {e}"))?;
    Ok(index::db_path(&cache, Path::new(vault_path)))
}

/// Bring the search index in line with the vault.
///
/// Also catches notes that arrived from the other machine through iCloud or Dropbox,
/// since those change on disk without this app ever touching them.
#[tauri::command(async)]
fn reindex(app: tauri::AppHandle, vault_path: String) -> Result<usize, String> {
    let db = index_db(&app, &vault_path)?;
    index::reindex(&db, Path::new(&vault_path))
}

#[tauri::command(async)]
fn search(
    app: tauri::AppHandle,
    vault_path: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SearchHit>, String> {
    let db = index_db(&app, &vault_path)?;
    index::search(&db, &query, limit.unwrap_or(60))
}

#[tauri::command(async)]
fn backlinks(
    app: tauri::AppHandle,
    vault_path: String,
    title: String,
) -> Result<Vec<LinkRef>, String> {
    let db = index_db(&app, &vault_path)?;
    index::backlinks(&db, &title)
}

#[tauri::command(async)]
fn all_tags(app: tauri::AppHandle, vault_path: String) -> Result<Vec<TagCount>, String> {
    let db = index_db(&app, &vault_path)?;
    index::all_tags(&db)
}

#[tauri::command(async)]
fn pages_with_tag(
    app: tauri::AppHandle,
    vault_path: String,
    tag: String,
) -> Result<Vec<LinkRef>, String> {
    let db = index_db(&app, &vault_path)?;
    index::pages_with_tag(&db, &tag)
}

/// Replace a page's tags, keeping its body untouched.
#[tauri::command(async)]
fn set_tags(
    app: tauri::AppHandle,
    vault_path: String,
    path: String,
    tags: Vec<String>,
    base_hash: Option<String>,
) -> Result<PageRead, String> {
    let target = Path::new(&path);
    let loaded = page::load(target)?;
    let mut existing = loaded.page;

    // Writing tags means writing the whole file, body included — so if the file has
    // changed since it was loaded, this would put the old body back over the one that
    // arrived. Refused rather than diverted: the interface reloads the page and the
    // person can add the tag again, which costs a keystroke instead of a note.
    if base_hash.as_deref().is_some_and(|base| base != loaded.hash) {
        return Err("this page just changed on disk, so the tags were not written. It has been reloaded — try again.".into());
    }

    // Normalised here rather than in the interface, so tags typed on two different
    // days with different capitalisation still group together.
    let mut cleaned: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().trim_start_matches('#').trim().to_string();
        if tag.is_empty() || cleaned.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
            continue;
        }
        cleaned.push(tag);
    }

    existing.tags = cleaned;
    existing.updated = page::now_iso();

    let text = existing.to_file_string();
    page::write_text(target, &text)?;
    let hash = fingerprint::of_bytes(text.as_bytes());
    app.state::<watch::Writes>().record(target, hash.clone());

    let db = index_db(&app, &vault_path)?;
    index::index_one(&db, target)?;

    Ok(PageRead {
        page: existing,
        hash,
    })
}

/// Open a link in the person's own browser.
///
/// Without this, following a link inside the editor would replace the app's own window
/// with the web page and leave no way back.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    // Anything that is not plainly a web link is refused rather than handed to the
    // system opener, which would otherwise act on file: or custom schemes.
    let lowered = url.trim().to_ascii_lowercase();
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return Err("only http and https links can be opened".into());
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open the link: {e}"))
}

#[tauri::command(async)]
fn read_tree(vault_path: String) -> Result<Vec<TreeNode>, String> {
    vault::read_tree(Path::new(&vault_path))
}

#[tauri::command(async)]
fn create_notebook(vault_path: String, title: String) -> Result<TreeNode, String> {
    vault::create_notebook(Path::new(&vault_path), &clean_title(&title, "New Notebook"))
}

#[tauri::command(async)]
fn create_section(parent_path: String, title: String) -> Result<TreeNode, String> {
    vault::create_section(Path::new(&parent_path), &clean_title(&title, "New Section"))
}

#[tauri::command(async)]
fn create_page(parent_path: String, title: String) -> Result<TreeNode, String> {
    vault::create_page(Path::new(&parent_path), &clean_title(&title, "Untitled Page"))
}

#[tauri::command(async)]
fn read_page(path: String) -> Result<PageRead, String> {
    let loaded = page::load(Path::new(&path))?;
    Ok(PageRead {
        page: loaded.page,
        hash: loaded.hash,
    })
}

/// Save the body of a page, leaving its id, title and creation time alone.
///
/// `base_hash` is the fingerprint the editor was given when it loaded the page. If the
/// file on disk no longer matches it, something else has written to the file since —
/// in practice a sync client putting the other machine's copy there. In that case the
/// file is left exactly as it was found and this text is written to a new page beside
/// it, so neither version is lost and both are visible in the sidebar.
///
/// Passing no `base_hash` skips that check and writes unconditionally. Only callers
/// that have just written the file themselves should do that.
#[tauri::command(async)]
fn save_page(
    app: tauri::AppHandle,
    vault_path: String,
    path: String,
    body: String,
    base_hash: Option<String>,
) -> Result<SaveResult, String> {
    let target = Path::new(&path);
    let loaded = page::load(target)?;
    let mut existing = loaded.page;

    if existing.body == body {
        // Autosave fires on a timer; skip the write when nothing actually changed so
        // we don't churn the file's timestamp and wake every sync client.
        return Ok(SaveResult {
            page: existing,
            hash: loaded.hash,
            conflict_path: None,
        });
    }

    let diverged = base_hash
        .as_deref()
        .is_some_and(|base| base != loaded.hash);

    if diverged {
        return divert_to_conflict(&app, &vault_path, target, &existing, &loaded.raw, body);
    }

    // Keep what is about to be replaced. History is a convenience and its failures are
    // not worth interrupting a save for, so the result is deliberately dropped.
    if let Ok(root) = history_root(&app, &vault_path) {
        let _ = history::snapshot(&root, &existing.id, &loaded.raw, false);
    }

    existing.body = body;
    existing.updated = page::now_iso();

    let text = existing.to_file_string();
    page::write_text(target, &text)?;
    let hash = fingerprint::of_bytes(text.as_bytes());

    // So the folder watcher recognises this write as ours and does not report it back
    // to the interface as a change arriving from somewhere else.
    app.state::<watch::Writes>().record(target, hash.clone());

    // Just this page, not the whole vault: this runs every time typing pauses.
    // A failure here costs a stale search result, never the note itself, so it must
    // not turn a successful save into an error.
    if let Ok(db) = index_db(&app, &vault_path) {
        let _ = index::index_one(&db, target);
    }

    Ok(SaveResult {
        page: existing,
        hash,
        conflict_path: None,
    })
}

/// Put this machine's text in a page of its own, leaving the arriving version alone.
///
/// Both versions survive, which is the whole point: merging them automatically would
/// mean guessing, and overwriting either would mean losing work nobody agreed to lose.
fn divert_to_conflict(
    app: &tauri::AppHandle,
    vault_path: &str,
    target: &Path,
    arrived: &Page,
    arrived_raw: &str,
    body: String,
) -> Result<SaveResult, String> {
    let (dest, dest_hash) = write_conflict_copy(target, arrived, body)?;

    app.state::<watch::Writes>().record(&dest, dest_hash);

    if let Ok(root) = history_root(app, vault_path) {
        // The version that arrived is worth a snapshot whatever the clock says: from
        // here on it is the only copy of the file under its own name.
        let _ = history::snapshot(&root, &arrived.id, arrived_raw, true);
    }

    if let Ok(db) = index_db(app, vault_path) {
        let _ = index::index_one(&db, &dest);
    }

    Ok(SaveResult {
        page: arrived.clone(),
        hash: fingerprint::of_file(target).unwrap_or_default(),
        conflict_path: Some(dest.to_string_lossy().to_string()),
    })
}

/// Write `body` to a new page beside `target`, without touching `target` itself.
///
/// Returns where it went and the fingerprint of what was written. Separated from the
/// bookkeeping around it so the part that matters — that the file which arrived is
/// left exactly as it was found — can be tested on its own.
fn write_conflict_copy(
    target: &Path,
    arrived: &Page,
    body: String,
) -> Result<(PathBuf, String), String> {
    let now = chrono::Local::now();
    let dest = paths::conflict_path(target, &now.format("%Y-%m-%d-%H%M%S").to_string());

    let mut mine = arrived.clone();
    // Its own id, or the two files would share a version history.
    mine.id = uuid::Uuid::new_v4().to_string();
    mine.title = format!("{} (conflict {})", arrived.title, now.format("%d %b %H:%M"));
    mine.body = body;
    mine.updated = page::now_iso();

    let text = mine.to_file_string();
    page::write_text(&dest, &text)?;

    Ok((dest, fingerprint::of_bytes(text.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_page(body: &str) -> (PathBuf, Page) {
        let dir = std::env::temp_dir().join(format!("notehub-save-{}", paths::short_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("upx-unpacking.md");

        let mut arrived = Page::new("UPX unpacking");
        arrived.tags = vec!["packing".into()];
        arrived.body = body.into();
        page::write(&path, &arrived).unwrap();

        (path, arrived)
    }

    #[test]
    fn only_images_can_be_dropped_into_a_page() {
        // A drop is the one place a file arrives by its path alone, so what counts as
        // an image is decided here rather than by whatever the webview would render.
        assert!(is_image_path(Path::new("/tmp/shot.PNG")));
        assert!(is_image_path(Path::new("/tmp/diagram.svg")));
        assert!(is_image_path(Path::new("/tmp/photo.jpeg")));

        assert!(!is_image_path(Path::new("/tmp/notes.md")));
        assert!(!is_image_path(Path::new("/etc/passwd")));
        assert!(!is_image_path(Path::new("/tmp/installer.dmg")));
        assert!(!is_image_path(Path::new("/tmp/no-extension")));
        // A name that only looks like one.
        assert!(!is_image_path(Path::new("/tmp/png")));
        assert!(!is_image_path(Path::new("/tmp/shot.png.exe")));
    }

    #[test]
    fn a_conflict_copy_does_not_touch_the_file_that_arrived() {
        let (path, arrived) = temp_page("their text, from the other machine");
        let before = std::fs::read_to_string(&path).unwrap();

        let (dest, _) = write_conflict_copy(&path, &arrived, "my text".into()).unwrap();

        // The whole promise of the conflict path: nothing was overwritten.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        assert!(dest.exists());
    }

    #[test]
    fn a_conflict_copy_holds_this_machines_text() {
        let (path, arrived) = temp_page("their text");

        let (dest, hash) = write_conflict_copy(&path, &arrived, "my text".into()).unwrap();
        let copy = page::load(&dest).unwrap();

        assert_eq!(copy.page.body, "my text");
        assert_eq!(copy.hash, hash, "the reported fingerprint must match the file");
        // Tags are carried over: it is the same note, saved twice over.
        assert_eq!(copy.page.tags, vec!["packing"]);
    }

    #[test]
    fn a_conflict_copy_gets_its_own_id_and_a_title_saying_what_it_is() {
        let (path, arrived) = temp_page("their text");

        let (dest, _) = write_conflict_copy(&path, &arrived, "my text".into()).unwrap();
        let copy = page::read(&dest).unwrap();

        // Sharing the id would mean sharing a version history with the original.
        assert_ne!(copy.id, arrived.id);
        assert!(
            copy.title.starts_with("UPX unpacking (conflict "),
            "unhelpful title: {}",
            copy.title
        );
    }

    #[test]
    fn a_conflict_copy_is_a_page_in_the_same_folder() {
        let (path, arrived) = temp_page("their text");

        let (dest, _) = write_conflict_copy(&path, &arrived, "my text".into()).unwrap();

        // A plain .md beside the page, so it shows up in the sidebar by itself rather
        // than somewhere the person would have to be told about.
        assert_eq!(dest.parent(), path.parent());
        assert_eq!(dest.extension().unwrap(), "md");
        assert!(dest.file_name().unwrap().to_string_lossy().contains(".conflict-"));
    }
}

/// Where this vault's version history lives.
///
/// The app's data folder, not its cache: the search index can be rebuilt from the
/// notes whenever it is missing, so the system is welcome to clear it, but an earlier
/// version of a note cannot be rebuilt from anything.
fn history_root(app: &tauri::AppHandle, vault_path: &str) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not find the app's data folder: {e}"))?;
    Ok(history::root(&data, Path::new(vault_path)))
}

/// Earlier versions of a page that are still kept, newest first.
#[tauri::command(async)]
fn page_versions(
    app: tauri::AppHandle,
    vault_path: String,
    path: String,
) -> Result<Vec<Version>, String> {
    let id = page::read(Path::new(&path))?.id;
    Ok(history::versions(&history_root(&app, &vault_path)?, &id))
}

/// The text of one earlier version, for previewing before restoring it.
#[tauri::command(async)]
fn read_version(
    app: tauri::AppHandle,
    vault_path: String,
    path: String,
    stamp: String,
) -> Result<String, String> {
    let id = page::read(Path::new(&path))?.id;
    let raw = history::read_version(&history_root(&app, &vault_path)?, &id, &stamp)?;
    // Just the text: the frontmatter is this app's bookkeeping, not something anybody
    // wants to read in a preview.
    Ok(Page::from_file_string(&raw, "Untitled").body)
}

/// Put an earlier version's text back into the page.
///
/// Only the text. Restoring the whole file would also revert the title — which would
/// no longer match the filename — and the tags, neither of which is what "go back to
/// how this read yesterday" means. The text being replaced is snapshotted first, so a
/// restore is itself undoable.
#[tauri::command(async)]
fn restore_version(
    app: tauri::AppHandle,
    vault_path: String,
    path: String,
    stamp: String,
) -> Result<PageRead, String> {
    let target = Path::new(&path);
    let loaded = page::load(target)?;
    let root = history_root(&app, &vault_path)?;

    let earlier = Page::from_file_string(&history::read_version(&root, &loaded.page.id, &stamp)?, "Untitled");
    let _ = history::snapshot(&root, &loaded.page.id, &loaded.raw, true);

    let mut next = loaded.page;
    next.body = earlier.body;
    next.updated = page::now_iso();

    let text = next.to_file_string();
    page::write_text(target, &text)?;
    let hash = fingerprint::of_bytes(text.as_bytes());
    app.state::<watch::Writes>().record(target, hash.clone());

    if let Ok(db) = index_db(&app, &vault_path) {
        let _ = index::index_one(&db, target);
    }

    Ok(PageRead { page: next, hash })
}

#[tauri::command(async)]
fn rename_item(path: String, new_title: String) -> Result<TreeNode, String> {
    vault::rename(Path::new(&path), &new_title)
}

/// Colour a notebook or section. `color` is `None` to clear it.
#[tauri::command(async)]
fn set_color(
    vault_path: String,
    path: String,
    color: Option<String>,
) -> Result<TreeNode, String> {
    vault::set_color(Path::new(&vault_path), Path::new(&path), color.as_deref())
}

/// The colour names the app offers, so the picker and the vault cannot drift apart.
#[tauri::command(async)]
fn colors() -> Vec<String> {
    vault::COLORS.iter().map(|c| c.to_string()).collect()
}

#[tauri::command(async)]
fn delete_item(vault_path: String, path: String) -> Result<(), String> {
    vault::delete(Path::new(&vault_path), Path::new(&path))
}

/// Open the vault folder in Finder or Explorer — the quickest way to show someone
/// that their notes are really just files.
#[tauri::command]
fn reveal_vault(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("could not open the folder: {e}"))
}

fn clean_title(title: &str, fallback: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn config_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("config.json"))
}

fn read_config(app: &tauri::AppHandle) -> Config {
    config_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Losing this file only costs the "reopen last vault" convenience, so a failure here
/// is not worth surfacing to the person mid-edit.
fn write_config(app: &tauri::AppHandle, config: &Config) {
    if let Some(path) = config_file(app) {
        if let Ok(json) = serde_json::to_string_pretty(config) {
            let _ = std::fs::write(path, json);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Both outlive any one command: the watcher stops the moment it is dropped,
        // and the write table is what lets it tell our saves from everyone else's.
        .manage(watch::Writes::default())
        .manage(watch::Watcher::default())
        .invoke_handler(tauri::generate_handler![
            pick_vault,
            last_vault,
            open_vault,
            read_tree,
            create_notebook,
            create_section,
            create_page,
            read_page,
            save_page,
            rename_item,
            set_color,
            colors,
            delete_item,
            reveal_vault,
            save_asset,
            add_asset_from_path,
            open_external,
            reindex,
            search,
            backlinks,
            all_tags,
            pages_with_tag,
            set_tags,
            page_versions,
            read_version,
            restore_version,
            pick_import_folder,
            import_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
