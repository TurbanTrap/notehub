//! Snapshots of a page's earlier text, so that a save is never the end of a version.
//!
//! Two deliberate choices about where these live.
//!
//! **Not in the vault.** The vault is meant to sit in iCloud Drive or Dropbox. A
//! snapshot per save, on two machines, would multiply the sync traffic and hand the
//! sync client its own pile of files to conflict over — and the machine that needs an
//! old version is the machine that has it already.
//!
//! **Not in the cache folder either**, where the search index lives. The index can be
//! rebuilt from the notes at any time, so the operating system is welcome to delete it
//! when the disk fills up. A version somebody wants back cannot be rebuilt from
//! anything, so it belongs in the app's data folder, which is not cleared.
//!
//! Snapshots are keyed on the page's id from its frontmatter rather than its path, so
//! renaming a page keeps its history.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

/// Enough to cover a few days of real work on one page without the folder growing
/// without limit.
const MAX_VERSIONS: usize = 40;

/// Autosave fires every time typing pauses. Without a floor, one afternoon on a page
/// would be thousands of snapshots a second apart, which is not a history anybody can
/// read. A clash arriving from the other machine ignores this and snapshots anyway.
const MIN_GAP: Duration = Duration::from_secs(120);

const STAMP_FORMAT: &str = "%Y%m%dT%H%M%SZ";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    /// The snapshot's file stem, and the handle used to read or restore it.
    pub stamp: String,
    /// When it was taken, as RFC 3339, for the interface to show in local time.
    pub saved: String,
    pub bytes: u64,
}

/// Where this vault's history lives, inside the app's data folder.
pub fn root(data_dir: &Path, vault: &Path) -> PathBuf {
    data_dir
        .join("history")
        .join(crate::paths::vault_key(vault))
}

/// Keep a copy of a page's text as it was before it is overwritten.
///
/// `previous` is the whole file, frontmatter included, so a snapshot can be read on
/// its own. Returns quietly when there is nothing worth keeping: history is a
/// convenience, and a failure here must never turn a successful save into an error.
///
/// `force` skips the rate limit, for the moments that are worth capturing whatever the
/// clock says — a version arriving from another machine, or the text being replaced by
/// a restore.
pub fn snapshot(root: &Path, page_id: &str, previous: &str, force: bool) -> Result<(), String> {
    if previous.trim().is_empty() {
        return Ok(());
    }

    let dir = page_dir(root, page_id);
    let existing = stamps(&dir);

    if let Some(newest) = existing.last() {
        // An autosave that changed nothing on disk, or a change the person undid
        // before the next snapshot was due, should not take up a slot.
        let newest_text = std::fs::read_to_string(dir.join(format!("{newest}.md"))).ok();
        if newest_text.as_deref() == Some(previous) {
            return Ok(());
        }
        if !force && age_of(newest).is_some_and(|age| age < MIN_GAP) {
            return Ok(());
        }
    }

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not make room for earlier versions: {e}"))?;

    let stamp = free_stamp(&dir);
    std::fs::write(dir.join(format!("{stamp}.md")), previous)
        .map_err(|e| format!("could not keep a copy of the earlier text: {e}"))?;

    prune(&dir);
    Ok(())
}

/// Every kept version of a page, newest first.
pub fn versions(root: &Path, page_id: &str) -> Vec<Version> {
    let dir = page_dir(root, page_id);
    let mut out: Vec<Version> = stamps(&dir)
        .into_iter()
        .map(|stamp| {
            let bytes = std::fs::metadata(dir.join(format!("{stamp}.md")))
                .map(|m| m.len())
                .unwrap_or(0);
            Version {
                saved: saved_at(&stamp).unwrap_or_else(|| stamp.clone()),
                stamp,
                bytes,
            }
        })
        .collect();
    out.reverse();
    out
}

/// The text of one kept version.
pub fn read_version(root: &Path, page_id: &str, stamp: &str) -> Result<String, String> {
    // The stamp comes back from the interface, so it is checked against the shape we
    // write rather than being joined onto a path as given.
    if !is_stamp(stamp) {
        return Err("that is not a version of this page".into());
    }
    std::fs::read_to_string(page_dir(root, page_id).join(format!("{stamp}.md")))
        .map_err(|e| format!("could not read that version: {e}"))
}

fn page_dir(root: &Path, page_id: &str) -> PathBuf {
    // Slugified, not used as given: the id is read from a file's frontmatter, which
    // anybody may have edited by hand, and it must not be able to name a folder
    // outside this one.
    root.join(crate::paths::slugify(page_id))
}

/// The stamps present in a page's history folder, oldest first.
///
/// The stamp format sorts correctly as text, so this needs no date parsing.
fn stamps(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(".md")?;
            is_stamp(stem).then(|| stem.to_string())
        })
        .collect();
    out.sort();
    out
}

fn prune(dir: &Path) {
    let all = stamps(dir);
    if all.len() <= MAX_VERSIONS {
        return;
    }
    for stamp in &all[..all.len() - MAX_VERSIONS] {
        let _ = std::fs::remove_file(dir.join(format!("{stamp}.md")));
    }
}

/// A stamp that is not already taken. Two snapshots inside one second only happen when
/// `force` is in play, but the suffix keeps it from silently replacing the first.
fn free_stamp(dir: &Path) -> String {
    let base = chrono::Utc::now().format(STAMP_FORMAT).to_string();
    if !dir.join(format!("{base}.md")).exists() {
        return base;
    }
    for n in 2..100 {
        let candidate = format!("{base}-{n}");
        if !dir.join(format!("{candidate}.md")).exists() {
            return candidate;
        }
    }
    base
}

fn parse_stamp(stamp: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    // Tolerate the `-2` suffix free_stamp may have added.
    let core = stamp.split('-').next().unwrap_or(stamp);
    chrono::NaiveDateTime::parse_from_str(core, STAMP_FORMAT)
        .ok()
        .map(|naive| naive.and_utc())
}

fn saved_at(stamp: &str) -> Option<String> {
    parse_stamp(stamp).map(|when| when.to_rfc3339())
}

fn age_of(stamp: &str) -> Option<Duration> {
    let when: SystemTime = parse_stamp(stamp)?.into();
    SystemTime::now().duration_since(when).ok()
}

fn is_stamp(value: &str) -> bool {
    parse_stamp(value).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("notehub-history-{}", crate::paths::short_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Place a snapshot as though it had been taken `seconds` ago.
    fn backdate(root: &Path, id: &str, seconds: i64, text: &str) -> String {
        let when = chrono::Utc::now() - chrono::Duration::seconds(seconds);
        let stamp = when.format(STAMP_FORMAT).to_string();
        let dir = page_dir(root, id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{stamp}.md")), text).unwrap();
        stamp
    }

    #[test]
    fn keeps_the_first_version_of_a_page() {
        let root = temp();
        snapshot(&root, "page-1", "first text", false).unwrap();

        let kept = versions(&root, "page-1");
        assert_eq!(kept.len(), 1);
        assert_eq!(
            read_version(&root, "page-1", &kept[0].stamp).unwrap(),
            "first text"
        );
    }

    #[test]
    fn does_not_snapshot_again_within_the_rate_limit() {
        let root = temp();
        backdate(&root, "page-1", 5, "five seconds ago");

        snapshot(&root, "page-1", "typed since", false).unwrap();

        // The point of the limit: autosave fires constantly and must not fill the
        // folder with near-identical copies.
        assert_eq!(versions(&root, "page-1").len(), 1);
    }

    #[test]
    fn snapshots_again_once_the_gap_has_passed() {
        let root = temp();
        backdate(&root, "page-1", MIN_GAP.as_secs() as i64 + 30, "long ago");

        snapshot(&root, "page-1", "typed since", false).unwrap();

        assert_eq!(versions(&root, "page-1").len(), 2);
    }

    #[test]
    fn force_ignores_the_rate_limit() {
        let root = temp();
        backdate(&root, "page-1", 5, "five seconds ago");

        // What happens when a clash arrives from the other machine: worth keeping
        // whatever the clock says.
        snapshot(&root, "page-1", "their version", true).unwrap();

        assert_eq!(versions(&root, "page-1").len(), 2);
    }

    #[test]
    fn identical_text_is_not_kept_twice() {
        let root = temp();
        backdate(&root, "page-1", 5, "same text");

        snapshot(&root, "page-1", "same text", true).unwrap();

        assert_eq!(versions(&root, "page-1").len(), 1);
    }

    #[test]
    fn newest_version_comes_first() {
        let root = temp();
        backdate(&root, "page-1", 600, "older");
        backdate(&root, "page-1", 60, "newer");

        let kept = versions(&root, "page-1");
        assert_eq!(read_version(&root, "page-1", &kept[0].stamp).unwrap(), "newer");
        assert_eq!(read_version(&root, "page-1", &kept[1].stamp).unwrap(), "older");
    }

    #[test]
    fn prunes_down_to_the_cap() {
        let root = temp();
        for n in 0..MAX_VERSIONS + 10 {
            backdate(&root, "page-1", (MAX_VERSIONS + 20 - n) as i64 * 10, &format!("v{n}"));
        }

        snapshot(&root, "page-1", "newest of all", true).unwrap();

        let kept = versions(&root, "page-1");
        assert_eq!(kept.len(), MAX_VERSIONS);
        assert_eq!(
            read_version(&root, "page-1", &kept[0].stamp).unwrap(),
            "newest of all"
        );
    }

    #[test]
    fn an_empty_page_is_not_worth_a_snapshot() {
        let root = temp();
        snapshot(&root, "page-1", "   \n  ", false).unwrap();
        assert!(versions(&root, "page-1").is_empty());
    }

    #[test]
    fn a_page_with_no_history_has_no_versions() {
        let root = temp();
        assert!(versions(&root, "never-saved").is_empty());
    }

    #[test]
    fn refuses_a_stamp_that_is_not_one() {
        let root = temp();
        snapshot(&root, "page-1", "text", false).unwrap();

        // The stamp arrives from the interface, so it must not be able to walk out of
        // the history folder.
        assert!(read_version(&root, "page-1", "../../../etc/passwd").is_err());
        assert!(read_version(&root, "page-1", "notastamp").is_err());
    }

    #[test]
    fn history_follows_the_page_id_not_its_path() {
        let root = temp();
        snapshot(&root, "stable-id", "written under one filename", false).unwrap();

        // A rename changes the file's name but not its frontmatter id, so the history
        // is still found afterwards.
        assert_eq!(versions(&root, "stable-id").len(), 1);
    }

    #[test]
    fn an_id_cannot_name_a_folder_outside_the_history_root() {
        let root = temp();
        snapshot(&root, "../escape", "text", false).unwrap();

        // Slugified on the way in, so it stays a child of the root.
        assert!(root.join("-escape").is_dir() || root.join("escape").is_dir());
        assert!(!root.parent().unwrap().join("escape").exists());
    }

    #[test]
    fn two_vaults_do_not_share_a_history_folder() {
        let data = temp();
        assert_ne!(
            root(&data, Path::new("/Users/a/Notes")),
            root(&data, Path::new("/Users/a/Other"))
        );
    }
}
