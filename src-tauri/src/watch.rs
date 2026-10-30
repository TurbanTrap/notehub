//! Noticing changes to the vault that this app did not make.
//!
//! The vault is meant to live in a synced folder, so a page can change while it is
//! open: iCloud or Dropbox writes the other machine's version straight over the file.
//! Without this the app would carry on showing the stale text and the next autosave
//! would quietly put it back, losing the edit that arrived.
//!
//! Two things keep the noise down. Events are debounced, because one incoming file
//! arrives as a create, several writes and sometimes a rename. And a changed file is
//! fingerprinted and compared with what this app last wrote there, so our own saves
//! do not come back to us as external changes.
//!
//! The watcher is a convenience, not the safety net. If it fails to start, or the
//! platform drops an event, a clash is still caught at save time by the fingerprint
//! check in `save_page` — the watcher only makes the app notice sooner.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The event the interface listens for.
pub const EVENT: &str = "vault-changed";

/// Long enough that a sync client's burst of writes arrives as one change, short
/// enough that the page in front of the person updates while they are still looking.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// A cap on the self-write table. A vault has far fewer pages open in a session than
/// this; exceeding it costs one spurious reload, never a wrong save.
const MAX_REMEMBERED_WRITES: usize = 512;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultChange {
    /// Page files that changed on disk, as absolute paths.
    pub paths: Vec<String>,
    /// Whether anything appeared, vanished or was renamed, which makes the sidebar
    /// stale as well as the page.
    pub structural: bool,
}

/// What this app last wrote to each page, so the watcher can recognise its own work.
#[derive(Default)]
pub struct Writes(Mutex<HashMap<PathBuf, String>>);

impl Writes {
    /// Record the fingerprint of what we just put on disk.
    pub fn record(&self, path: &Path, hash: String) {
        let Ok(mut map) = self.0.lock() else { return };
        if map.len() >= MAX_REMEMBERED_WRITES {
            map.clear();
        }
        map.insert(path.to_path_buf(), hash);
    }

    /// Whether the file at `path` currently holds exactly what we last wrote there.
    ///
    /// The entry is kept rather than consumed: the platform may report one write
    /// several times, and every one of those is still ours.
    fn is_ours(&self, path: &Path, hash: &str) -> bool {
        self.0
            .lock()
            .map(|map| map.get(path).is_some_and(|known| known == hash))
            .unwrap_or(false)
    }

    pub fn forget_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            map.clear();
        }
    }
}

/// Holds the live watcher. Dropping a debouncer stops it, so it has to be kept
/// somewhere for as long as the vault is open — hence Tauri's managed state.
#[derive(Default)]
pub struct Watcher(Mutex<Option<Debouncer<notify::RecommendedWatcher, RecommendedCache>>>);

/// Start watching `root`, replacing any folder watched before.
pub fn start(app: &AppHandle, root: &Path) -> Result<(), String> {
    let handle = app.clone();
    let base = root.to_path_buf();

    let mut debouncer = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
        // Errors here are the platform telling us it dropped events. There is nothing
        // useful to say about that, and the save-time check still holds, so the batch
        // is skipped rather than reported.
        let Ok(events) = result else { return };

        let mut change = VaultChange::default();
        let writes = handle.state::<Writes>();

        for event in events {
            let structural = matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))
            );

            for path in event.paths.iter() {
                if ignored(&base, path) {
                    continue;
                }

                // Anything appearing, vanishing or being renamed can change the shape
                // of the sidebar, including a whole section folder arriving at once.
                // Rebuilding the tree is cheap, so this errs towards doing it.
                //
                // A metadata file counts even when it is only edited in place: the
                // title and colour the sidebar draws live inside it, so a notebook
                // renamed or recoloured on the other machine arrives as nothing but a
                // write to one of these.
                if structural || is_meta(path) {
                    change.structural = true;
                }

                if !is_page(path) {
                    continue;
                }

                // Our own save comes back to us as a change to the file. A missing
                // fingerprint means the file is gone, which is never ours to skip.
                if let Some(hash) = crate::fingerprint::of_file(path) {
                    if writes.is_ours(path, &hash) {
                        continue;
                    }
                }

                let key = path.to_string_lossy().to_string();
                if !change.paths.contains(&key) {
                    change.paths.push(key);
                }
            }
        }

        if change.paths.is_empty() && !change.structural {
            return;
        }
        let _ = handle.emit(EVENT, change);
    })
    .map_err(|e| format!("could not watch the notes folder: {e}"))?;

    debouncer
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("could not watch the notes folder: {e}"))?;

    // Swapping vaults: the previous watcher is dropped here, which stops it, and the
    // self-write table is cleared because its paths belong to the old folder.
    app.state::<Writes>().forget_all();
    if let Ok(mut slot) = app.state::<Watcher>().0.lock() {
        *slot = Some(debouncer);
    }

    Ok(())
}

fn is_page(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

/// A notebook's or section's own record: its title and colour.
fn is_meta(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|n| n == "notebook.json" || n == "section.json")
}

/// Whether a path is none of our business.
///
/// Everything with a leading dot below the vault root is skipped: the app's own
/// `.notehub` folder, the temporary files its atomic writes go through, `.DS_Store`,
/// and the scratch files sync clients leave about. The check is made on the path
/// *relative to the root*, because the vault itself may well sit inside a dotted
/// folder and every path would otherwise look hidden.
fn ignored(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        // Not under the vault at all.
        return true;
    };
    relative
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/Users/a/Notes";

    fn under(relative: &str) -> PathBuf {
        Path::new(ROOT).join(relative)
    }

    #[test]
    fn a_page_is_watched() {
        assert!(!ignored(Path::new(ROOT), &under("notebooks/RE/Packers/upx.md")));
        assert!(is_page(&under("notebooks/RE/Packers/upx.md")));
    }

    #[test]
    fn a_notebooks_own_record_counts_as_a_change_to_the_sidebar() {
        // Renaming or recolouring a notebook on another machine arrives as a write
        // to one of these and nothing else — no file appears, and no page changes —
        // so without this the sidebar would keep showing the old name until restart.
        assert!(is_meta(&under("notebooks/RE/notebook.json")));
        assert!(is_meta(&under("notebooks/RE/Packers/section.json")));
        assert!(!is_meta(&under("notebooks/RE/Packers/upx.md")));
        assert!(!is_meta(&under("notebooks/RE/assets/notes.json")));
    }

    #[test]
    fn the_apps_own_folder_is_ignored() {
        assert!(ignored(Path::new(ROOT), &under(".notehub/trash/gone.md")));
    }

    #[test]
    fn the_temporary_file_an_atomic_write_goes_through_is_ignored() {
        // Left unignored, every single save would announce itself twice.
        assert!(ignored(Path::new(ROOT), &under("notebooks/RE/.a1b2c3d4.tmp")));
    }

    #[test]
    fn sync_and_finder_litter_is_ignored() {
        assert!(ignored(Path::new(ROOT), &under("notebooks/.DS_Store")));
        assert!(ignored(Path::new(ROOT), &under(".stfolder/x")));
    }

    #[test]
    fn a_vault_inside_a_dotted_folder_is_still_watched() {
        // The reason the check is made on the relative path: every path under this
        // root contains a dotted component.
        let root = Path::new("/Users/a/.config/notes");
        assert!(!ignored(root, &root.join("notebooks/RE/upx.md")));
    }

    #[test]
    fn anything_outside_the_vault_is_ignored() {
        assert!(ignored(Path::new(ROOT), Path::new("/etc/passwd")));
    }

    #[test]
    fn images_are_not_pages() {
        assert!(!is_page(&under("notebooks/RE/assets/screenshot.png")));
        assert!(is_page(&under("notebooks/RE/NOTE.MD")));
    }

    #[test]
    fn our_own_write_is_recognised() {
        let writes = Writes::default();
        let path = under("notebooks/RE/upx.md");
        writes.record(&path, "abc".into());

        assert!(writes.is_ours(&path, "abc"));
        // Somebody else's write to the same file has different content.
        assert!(!writes.is_ours(&path, "def"));
        // And a file we never wrote is never ours.
        assert!(!writes.is_ours(&under("other.md"), "abc"));
    }

    #[test]
    fn switching_vaults_forgets_the_old_paths() {
        let writes = Writes::default();
        let path = under("notebooks/RE/upx.md");
        writes.record(&path, "abc".into());
        writes.forget_all();
        assert!(!writes.is_ours(&path, "abc"));
    }

    #[test]
    fn the_write_table_stays_bounded() {
        let writes = Writes::default();
        for n in 0..MAX_REMEMBERED_WRITES + 5 {
            writes.record(&under(&format!("page-{n}.md")), format!("hash-{n}"));
        }
        let size = writes.0.lock().unwrap().len();
        assert!(size <= MAX_REMEMBERED_WRITES, "grew to {size}");
    }
}
