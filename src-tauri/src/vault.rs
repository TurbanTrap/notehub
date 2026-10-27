//! The vault: a plain folder of Markdown files that the app reads and writes.
//!
//! Layout on disk:
//!
//! ```text
//! <vault>/
//!   notebooks/
//!     Reverse-Engineering/
//!       notebook.json            { "title": "Reverse Engineering" }
//!       Static-Analysis/
//!         section.json           { "title": "Static Analysis" }
//!         Nested-Subsection/     sections nest to any depth
//!         ghidra-basics.md
//!         assets/                images belonging to this section's pages
//!   .notehub/
//!     trash/                     deleted items, kept rather than destroyed
//! ```
//!
//! Nothing here is authoritative except the files themselves. The folder opens in any
//! editor, syncs through iCloud or Dropbox, and survives the app being uninstalled.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::page::{self, Page};
use crate::paths;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    /// "notebook", "section" or "page".
    pub kind: String,
    pub title: String,
    pub path: String,
    pub children: Vec<TreeNode>,
}

#[derive(Serialize, Deserialize, Default)]
struct Meta {
    title: String,
}

const NOTEBOOKS_DIR: &str = "notebooks";
const INTERNAL_DIR: &str = ".notehub";
const NOTEBOOK_META: &str = "notebook.json";
const SECTION_META: &str = "section.json";
const ASSETS_DIR: &str = "assets";

/// Create the vault skeleton if it is missing, and seed a first notebook so the app
/// never opens onto an empty window with nothing to click.
pub fn ensure(root: &Path) -> Result<(), String> {
    let notebooks = root.join(NOTEBOOKS_DIR);
    std::fs::create_dir_all(&notebooks).map_err(|e| format!("could not create vault: {e}"))?;
    std::fs::create_dir_all(root.join(INTERNAL_DIR).join("trash"))
        .map_err(|e| format!("could not create vault: {e}"))?;

    if has_any_notebook(&notebooks) {
        return Ok(());
    }

    let notebook = create_notebook(root, "My Notes")?;
    let section = create_section(Path::new(&notebook.path), "Getting Started")?;
    let welcome = create_page(Path::new(&section.path), "Welcome to NoteHub")?;

    let mut page = page::read(Path::new(&welcome.path))?;
    page.body = WELCOME_BODY.to_string();
    page::write(Path::new(&welcome.path), &page)?;

    Ok(())
}

fn has_any_notebook(notebooks: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(notebooks) else {
        return false;
    };
    entries
        .filter_map(|e| e.ok())
        .any(|e| e.path().is_dir() && !is_hidden(&e.path()))
}

/// Read the whole vault into a tree for the sidebar.
pub fn read_tree(root: &Path) -> Result<Vec<TreeNode>, String> {
    let notebooks = root.join(NOTEBOOKS_DIR);
    if !notebooks.exists() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for entry in read_dir_sorted(&notebooks)? {
        if !entry.is_dir() || is_hidden(&entry) {
            continue;
        }
        out.push(TreeNode {
            kind: "notebook".into(),
            title: read_meta_title(&entry, NOTEBOOK_META),
            path: path_string(&entry),
            children: scan_children(&entry)?,
        });
    }

    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(out)
}

/// Sections and pages inside a notebook or another section.
fn scan_children(dir: &Path) -> Result<Vec<TreeNode>, String> {
    let mut sections = Vec::new();
    // Pages carry their creation time so they can be listed in the order they were
    // written, the way a paper notebook reads — not alphabetically.
    let mut pages: Vec<(String, TreeNode)> = Vec::new();

    for entry in read_dir_sorted(dir)? {
        if is_hidden(&entry) {
            continue;
        }

        if entry.is_dir() {
            if entry.file_name().is_some_and(|n| n == ASSETS_DIR) {
                continue;
            }
            sections.push(TreeNode {
                kind: "section".into(),
                title: read_meta_title(&entry, SECTION_META),
                path: path_string(&entry),
                children: scan_children(&entry)?,
            });
        } else if entry.extension().is_some_and(|e| e == "md") {
            let parsed = page::read(&entry)?;
            pages.push((
                parsed.created.clone(),
                TreeNode {
                    kind: "page".into(),
                    title: parsed.title,
                    path: path_string(&entry),
                    children: Vec::new(),
                },
            ));
        }
    }

    sections.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    pages.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out = sections;
    out.extend(pages.into_iter().map(|(_, node)| node));
    Ok(out)
}

pub fn create_notebook(root: &Path, title: &str) -> Result<TreeNode, String> {
    let notebooks = root.join(NOTEBOOKS_DIR);
    std::fs::create_dir_all(&notebooks).map_err(|e| format!("could not create notebook: {e}"))?;

    let dir = paths::unique_path(&notebooks, &paths::slugify(title), "");
    std::fs::create_dir(&dir).map_err(|e| format!("could not create notebook: {e}"))?;
    write_meta(&dir, NOTEBOOK_META, title)?;

    Ok(TreeNode {
        kind: "notebook".into(),
        title: title.to_string(),
        path: path_string(&dir),
        children: Vec::new(),
    })
}

/// Create a section inside a notebook, or a subsection inside another section —
/// the two are the same thing on disk, which is what lets them nest.
pub fn create_section(parent: &Path, title: &str) -> Result<TreeNode, String> {
    if !parent.is_dir() {
        return Err("the parent folder no longer exists".into());
    }

    let dir = paths::unique_path(parent, &paths::slugify(title), "");
    std::fs::create_dir(&dir).map_err(|e| format!("could not create section: {e}"))?;
    write_meta(&dir, SECTION_META, title)?;

    Ok(TreeNode {
        kind: "section".into(),
        title: title.to_string(),
        path: path_string(&dir),
        children: Vec::new(),
    })
}

/// Make a section folder at an exact path, rather than at one derived from a title.
///
/// `create_section` chooses its own folder name and renumbers it to avoid collisions,
/// which is right when somebody types a name but wrong for the importer: that has
/// already worked out the whole tree it is mirroring, and the paths inside it have to
/// be the ones it decided on. Idempotent, so a parent can be ensured twice.
pub fn ensure_section(dir: &Path, title: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create section: {e}"))?;
    write_meta(dir, SECTION_META, title)
}

pub fn create_page(parent: &Path, title: &str) -> Result<TreeNode, String> {
    if !parent.is_dir() {
        return Err("the parent folder no longer exists".into());
    }

    let file = paths::unique_path(parent, &paths::slugify(title), "md");
    let new_page = Page::new(title);
    page::write(&file, &new_page)?;

    Ok(TreeNode {
        kind: "page".into(),
        title: title.to_string(),
        path: path_string(&file),
        children: Vec::new(),
    })
}

/// Rename an item, moving the file or folder so the vault stays browsable in Finder
/// and Explorer rather than drifting from the titles shown in the app.
pub fn rename(target: &Path, new_title: &str) -> Result<TreeNode, String> {
    let trimmed = new_title.trim();
    if trimmed.is_empty() {
        return Err("a name cannot be empty".into());
    }
    if !target.exists() {
        return Err("that item no longer exists".into());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "that item has no parent folder".to_string())?;

    if target.is_dir() {
        let meta_name = if parent.file_name().is_some_and(|n| n == NOTEBOOKS_DIR) {
            NOTEBOOK_META
        } else {
            SECTION_META
        };

        let dest = paths::unique_path(parent, &paths::slugify(trimmed), "");
        let dest = if dest == target { target.to_path_buf() } else { dest };
        if dest != target {
            std::fs::rename(target, &dest).map_err(|e| format!("could not rename: {e}"))?;
        }
        write_meta(&dest, meta_name, trimmed)?;

        return Ok(TreeNode {
            kind: if meta_name == NOTEBOOK_META { "notebook".into() } else { "section".into() },
            title: trimmed.to_string(),
            path: path_string(&dest),
            children: scan_children(&dest)?,
        });
    }

    let mut parsed = page::read(target)?;
    parsed.title = trimmed.to_string();
    parsed.updated = page::now_iso();

    let dest = paths::unique_path(parent, &paths::slugify(trimmed), "md");
    let dest = if dest == target { target.to_path_buf() } else { dest };
    page::write(target, &parsed)?;
    if dest != target {
        std::fs::rename(target, &dest).map_err(|e| format!("could not rename: {e}"))?;
    }

    Ok(TreeNode {
        kind: "page".into(),
        title: trimmed.to_string(),
        path: path_string(&dest),
        children: Vec::new(),
    })
}

/// Move an item into the vault's trash folder.
///
/// Deliberately not a real delete: notes are the thing this app exists to keep, and a
/// misclick should be recoverable from Finder without a backup.
pub fn delete(root: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return Err("that item no longer exists".into());
    }

    // Refuse anything outside the vault, in case a stale path reaches us.
    let root_real = std::fs::canonicalize(root).map_err(|e| format!("bad vault path: {e}"))?;
    let target_real = std::fs::canonicalize(target).map_err(|e| format!("bad path: {e}"))?;
    if !target_real.starts_with(&root_real) {
        return Err("that item is outside the vault".into());
    }
    if target_real == root_real || target_real == root_real.join(NOTEBOOKS_DIR) {
        return Err("the vault itself cannot be deleted".into());
    }

    let trash = root_real.join(INTERNAL_DIR).join("trash");
    std::fs::create_dir_all(&trash).map_err(|e| format!("could not open trash: {e}"))?;

    let name = target_real
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "item".into());
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let dest = paths::unique_path(&trash, &format!("{stamp}-{name}"), "");

    std::fs::rename(&target_real, &dest).map_err(|e| format!("could not delete: {e}"))
}

/// Store a pasted or dropped file beside the page that references it, and return the
/// path to write into the Markdown.
///
/// The returned path is relative to the page's own folder, never absolute: the whole
/// point of the vault is that it can be moved, synced or copied to another machine
/// and still resolve its own images.
pub fn save_asset(page_path: &Path, filename: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = page_path
        .parent()
        .ok_or_else(|| "that page has no folder".to_string())?;
    if !dir.is_dir() {
        return Err("that page's folder no longer exists".into());
    }

    let assets = dir.join(ASSETS_DIR);
    std::fs::create_dir_all(&assets).map_err(|e| format!("could not create assets folder: {e}"))?;

    let (stem, ext) = split_filename(filename);
    let file = paths::unique_path(&assets, &paths::slugify(&stem), &ext);
    std::fs::write(&file, bytes).map_err(|e| format!("could not save the file: {e}"))?;

    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // Always a forward slash: Markdown paths are URLs, and this file may well be read
    // on the other operating system tomorrow.
    Ok(format!("{ASSETS_DIR}/{name}"))
}

/// Split an incoming filename into a stem and a safe extension.
fn split_filename(filename: &str) -> (String, String) {
    let trimmed = filename.trim();
    let (stem, ext) = match trimmed.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), e.to_string()),
        _ => (trimmed.to_string(), String::new()),
    };

    let ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(10)
        .collect::<String>()
        .to_ascii_lowercase();

    let stem = if stem.trim().is_empty() {
        "file".to_string()
    } else {
        stem
    };

    (stem, ext)
}

fn write_meta(dir: &Path, file: &str, title: &str) -> Result<(), String> {
    let meta = Meta { title: title.to_string() };
    let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(file), json).map_err(|e| format!("could not write metadata: {e}"))
}

/// The display title for a folder, falling back to the folder name when the metadata
/// file is missing — which is what happens for folders a person created by hand.
fn read_meta_title(dir: &Path, file: &str) -> String {
    let fallback = || {
        dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Untitled".into())
    };

    let Ok(raw) = std::fs::read_to_string(dir.join(file)) else {
        return fallback();
    };
    match serde_json::from_str::<Meta>(&raw) {
        Ok(meta) if !meta.title.trim().is_empty() => meta.title,
        _ => fallback(),
    }
}

fn read_dir_sorted(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("could not read folder: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    out.sort();
    Ok(out)
}

/// Skip dotfiles, and the `.DS_Store` and `Thumbs.db` droppings the two platforms
/// leave in synced folders.
fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .map(|n| n.to_string_lossy().starts_with('.'))
        .unwrap_or(true)
        || path.file_name().is_some_and(|n| n == "Thumbs.db")
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

// No leading `# ` heading: the page title lives in the frontmatter and is edited in
// the title field, so repeating it in the body would show it twice.
const WELCOME_BODY: &str = r#"Your notes are plain Markdown files in the folder you picked. Open that folder in
Finder or Explorer and you will see every note as a readable `.md` file — nothing is
locked inside a database, and nothing needs a subscription to sync.

## How it is organised

- **Notebooks** hold sections
- **Sections** hold pages, and can contain subsections as deep as you like
- **Pages** are documents, written top to bottom

## Inside a page

Use headings to break a long note into sections and subsections:

### A subsection

Code blocks keep their formatting, which matters for disassembly and hex dumps:

```
push    rbp
mov     rbp, rsp
sub     rsp, 0x20
```

## Syncing to another machine

Put this vault folder inside iCloud Drive, Dropbox or Syncthing. Install NoteHub on
the other machine, point it at the same folder, and the notes are there.
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("notehub-test-{}", paths::short_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ensure_seeds_a_usable_vault() {
        let root = temp_root();
        ensure(&root).unwrap();

        let tree = read_tree(&root).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].title, "My Notes");

        let section = &tree[0].children[0];
        assert_eq!(section.kind, "section");
        assert_eq!(section.children[0].title, "Welcome to NoteHub");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_is_idempotent() {
        let root = temp_root();
        ensure(&root).unwrap();
        ensure(&root).unwrap();
        assert_eq!(read_tree(&root).unwrap().len(), 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sections_nest_and_pages_keep_creation_order() {
        let root = temp_root();
        ensure(&root).unwrap();
        let notebook = create_notebook(&root, "RE").unwrap();
        let section = create_section(Path::new(&notebook.path), "Static").unwrap();
        let sub = create_section(Path::new(&section.path), "Ghidra").unwrap();

        create_page(Path::new(&sub.path), "Zebra").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        create_page(Path::new(&sub.path), "Apple").unwrap();

        let tree = read_tree(&root).unwrap();
        let re = tree.iter().find(|n| n.title == "RE").unwrap();
        let found_sub = &re.children[0].children[0];

        assert_eq!(found_sub.title, "Ghidra");
        let titles: Vec<&str> = found_sub.children.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["Zebra", "Apple"], "pages list in creation order");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn two_pages_with_one_title_do_not_collide() {
        let root = temp_root();
        ensure(&root).unwrap();
        let nb = create_notebook(&root, "NB").unwrap();
        let sec = create_section(Path::new(&nb.path), "S").unwrap();

        let a = create_page(Path::new(&sec.path), "Same Name").unwrap();
        let b = create_page(Path::new(&sec.path), "Same Name").unwrap();

        assert_ne!(a.path, b.path);
        assert!(Path::new(&a.path).exists() && Path::new(&b.path).exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_moves_to_trash_instead_of_destroying() {
        let root = temp_root();
        ensure(&root).unwrap();
        let nb = create_notebook(&root, "Throwaway").unwrap();

        delete(&root, Path::new(&nb.path)).unwrap();

        assert!(!Path::new(&nb.path).exists());
        let trash: Vec<_> = std::fs::read_dir(root.join(INTERNAL_DIR).join("trash"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(trash.len(), 1, "the notebook is recoverable from trash");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_refuses_a_path_outside_the_vault() {
        let root = temp_root();
        ensure(&root).unwrap();
        let outside = std::env::temp_dir().join(format!("notehub-outside-{}", paths::short_id()));
        std::fs::write(&outside, "do not touch").unwrap();

        assert!(delete(&root, &outside).is_err());
        assert!(outside.exists(), "the file outside the vault is untouched");

        std::fs::remove_file(&outside).ok();
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn assets_land_beside_the_page_with_a_relative_path() {
        let root = temp_root();
        ensure(&root).unwrap();
        let nb = create_notebook(&root, "NB").unwrap();
        let sec = create_section(Path::new(&nb.path), "S").unwrap();
        let p = create_page(Path::new(&sec.path), "Page").unwrap();

        let rel = save_asset(Path::new(&p.path), "Screen Shot 2026.png", b"fake png").unwrap();

        assert!(rel.starts_with("assets/"), "path stays relative: {rel}");
        assert!(rel.ends_with(".png"), "extension survives: {rel}");
        assert!(Path::new(&sec.path).join(&rel).exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn two_assets_with_one_name_do_not_overwrite() {
        let root = temp_root();
        ensure(&root).unwrap();
        let nb = create_notebook(&root, "NB").unwrap();
        let sec = create_section(Path::new(&nb.path), "S").unwrap();
        let p = create_page(Path::new(&sec.path), "Page").unwrap();

        let a = save_asset(Path::new(&p.path), "image.png", b"first").unwrap();
        let b = save_asset(Path::new(&p.path), "image.png", b"second").unwrap();

        assert_ne!(a, b);
        assert_eq!(std::fs::read(Path::new(&sec.path).join(&a)).unwrap(), b"first");
        assert_eq!(std::fs::read(Path::new(&sec.path).join(&b)).unwrap(), b"second");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_asset_cannot_escape_its_folder_through_its_name() {
        let root = temp_root();
        ensure(&root).unwrap();
        let nb = create_notebook(&root, "NB").unwrap();
        let sec = create_section(Path::new(&nb.path), "S").unwrap();
        let p = create_page(Path::new(&sec.path), "Page").unwrap();

        let rel = save_asset(Path::new(&p.path), "../../../etc/passwd", b"nope").unwrap();

        assert!(!rel.contains(".."), "traversal is slugified away: {rel}");
        assert!(Path::new(&sec.path).join(&rel).exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_assets_folder_is_not_listed_as_a_section() {
        let root = temp_root();
        ensure(&root).unwrap();
        let nb = create_notebook(&root, "NB").unwrap();
        let sec = create_section(Path::new(&nb.path), "S").unwrap();
        let p = create_page(Path::new(&sec.path), "Page").unwrap();
        save_asset(Path::new(&p.path), "shot.png", b"x").unwrap();

        let tree = read_tree(&root).unwrap();
        let found = tree.iter().find(|n| n.title == "NB").unwrap();
        let kinds: Vec<&str> = found.children[0]
            .children
            .iter()
            .map(|c| c.kind.as_str())
            .collect();

        assert_eq!(kinds, vec!["page"], "assets/ stays out of the sidebar");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn renaming_a_page_keeps_its_body() {
        let root = temp_root();
        ensure(&root).unwrap();
        let nb = create_notebook(&root, "NB").unwrap();
        let sec = create_section(Path::new(&nb.path), "S").unwrap();
        let p = create_page(Path::new(&sec.path), "Before").unwrap();

        let mut body = page::read(Path::new(&p.path)).unwrap();
        body.body = "important findings".into();
        page::write(Path::new(&p.path), &body).unwrap();

        let renamed = rename(Path::new(&p.path), "After").unwrap();
        let reread = page::read(Path::new(&renamed.path)).unwrap();

        assert_eq!(reread.title, "After");
        assert_eq!(reread.body, "important findings");
        assert_eq!(reread.id, body.id, "the page keeps its identity across a rename");

        std::fs::remove_dir_all(&root).ok();
    }
}
