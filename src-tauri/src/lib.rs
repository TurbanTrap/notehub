mod index;
mod page;
mod paths;
mod vault;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use index::{LinkRef, SearchHit, TagCount};
use page::Page;
use vault::TreeNode;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Config {
    last_vault: Option<String>,
}

/// Ask the person to choose a folder for their notes.
#[tauri::command]
fn pick_vault(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose a folder for your notes")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// The vault opened last time, if it is still on disk. A folder that has gone away —
/// an unmounted drive, a sync folder not yet downloaded — is reported as absent so the
/// app falls back to the welcome screen instead of erroring on every call.
#[tauri::command]
fn last_vault(app: tauri::AppHandle) -> Option<String> {
    let path = read_config(&app).last_vault?;
    Path::new(&path).is_dir().then_some(path)
}

#[tauri::command]
fn open_vault(app: tauri::AppHandle, path: String) -> Result<Vec<TreeNode>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("that folder does not exist".into());
    }

    vault::ensure(&root)?;

    // Images are shown straight from the vault folder, which the webview may not read
    // until the folder is let through the asset protocol scope. The vault is chosen at
    // runtime, so this cannot be a static entry in tauri.conf.json.
    //
    // Reported rather than ignored: if this fails the notes still open, but every
    // image in them renders as a broken box, which is otherwise baffling.
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| format!("notes opened, but images cannot be shown from this folder: {e}"))?;

    write_config(&app, &Config { last_vault: Some(path) });
    vault::read_tree(&root)
}

/// Store a pasted or dropped file next to the page, returning the relative path to
/// write into the Markdown. `data_base64` carries the bytes, since that survives the
/// JavaScript bridge without the cost of sending a large array of numbers.
#[tauri::command]
fn save_asset(page_path: String, filename: String, data_base64: String) -> Result<String, String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("that file could not be read: {e}"))?;

    vault::save_asset(Path::new(&page_path), &filename, &bytes)
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
#[tauri::command]
fn reindex(app: tauri::AppHandle, vault_path: String) -> Result<usize, String> {
    let db = index_db(&app, &vault_path)?;
    index::reindex(&db, Path::new(&vault_path))
}

#[tauri::command]
fn search(
    app: tauri::AppHandle,
    vault_path: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SearchHit>, String> {
    let db = index_db(&app, &vault_path)?;
    index::search(&db, &query, limit.unwrap_or(60))
}

#[tauri::command]
fn backlinks(
    app: tauri::AppHandle,
    vault_path: String,
    title: String,
) -> Result<Vec<LinkRef>, String> {
    let db = index_db(&app, &vault_path)?;
    index::backlinks(&db, &title)
}

#[tauri::command]
fn all_tags(app: tauri::AppHandle, vault_path: String) -> Result<Vec<TagCount>, String> {
    let db = index_db(&app, &vault_path)?;
    index::all_tags(&db)
}

#[tauri::command]
fn pages_with_tag(
    app: tauri::AppHandle,
    vault_path: String,
    tag: String,
) -> Result<Vec<LinkRef>, String> {
    let db = index_db(&app, &vault_path)?;
    index::pages_with_tag(&db, &tag)
}

/// Replace a page's tags, keeping its body untouched.
#[tauri::command]
fn set_tags(
    app: tauri::AppHandle,
    vault_path: String,
    path: String,
    tags: Vec<String>,
) -> Result<Page, String> {
    let target = Path::new(&path);
    let mut existing = page::read(target)?;

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
    page::write(target, &existing)?;

    let db = index_db(&app, &vault_path)?;
    index::index_one(&db, target)?;

    Ok(existing)
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

#[tauri::command]
fn read_tree(vault_path: String) -> Result<Vec<TreeNode>, String> {
    vault::read_tree(Path::new(&vault_path))
}

#[tauri::command]
fn create_notebook(vault_path: String, title: String) -> Result<TreeNode, String> {
    vault::create_notebook(Path::new(&vault_path), &clean_title(&title, "New Notebook"))
}

#[tauri::command]
fn create_section(parent_path: String, title: String) -> Result<TreeNode, String> {
    vault::create_section(Path::new(&parent_path), &clean_title(&title, "New Section"))
}

#[tauri::command]
fn create_page(parent_path: String, title: String) -> Result<TreeNode, String> {
    vault::create_page(Path::new(&parent_path), &clean_title(&title, "Untitled Page"))
}

#[tauri::command]
fn read_page(path: String) -> Result<Page, String> {
    page::read(Path::new(&path))
}

/// Save the body of a page, leaving its id, title and creation time alone.
#[tauri::command]
fn save_page(
    app: tauri::AppHandle,
    vault_path: String,
    path: String,
    body: String,
) -> Result<Page, String> {
    let target = Path::new(&path);
    let mut existing = page::read(target)?;

    if existing.body == body {
        // Autosave fires on a timer; skip the write when nothing actually changed so
        // we don't churn the file's timestamp and wake every sync client.
        return Ok(existing);
    }

    existing.body = body;
    existing.updated = page::now_iso();
    page::write(target, &existing)?;

    // Just this page, not the whole vault: this runs every time typing pauses.
    // A failure here costs a stale search result, never the note itself, so it must
    // not turn a successful save into an error.
    if let Ok(db) = index_db(&app, &vault_path) {
        let _ = index::index_one(&db, target);
    }

    Ok(existing)
}

#[tauri::command]
fn rename_item(path: String, new_title: String) -> Result<TreeNode, String> {
    vault::rename(Path::new(&path), &new_title)
}

#[tauri::command]
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
            delete_item,
            reveal_vault,
            save_asset,
            open_external,
            reindex,
            search,
            backlinks,
            all_tags,
            pages_with_tag,
            set_tags,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
