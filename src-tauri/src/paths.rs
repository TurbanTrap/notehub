//! Filename safety for a vault that has to open on both macOS and Windows.
//!
//! The same vault folder gets synced between the two, so every name we write has to
//! survive the stricter of the two filesystems. Slugs are therefore ASCII-only: that
//! sidesteps the NFC/NFD normalisation mismatch between macOS and Windows, which
//! otherwise shows up as duplicated folders after a sync. The human-readable title
//! keeps its full Unicode and lives in the file's frontmatter instead.

use std::path::{Path, PathBuf};

/// Names Windows refuses to create, whatever the extension, in any case.
const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
    "com8", "com9", "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Leaves room for the vault path in front of it before Windows' ~260 char limit.
const MAX_SLUG_LEN: usize = 80;

/// Turn a user-facing title into a filename that is legal on macOS, Windows and Linux.
pub fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = false;

    for ch in title.chars() {
        let keep = match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' => Some(ch),
            '-' | '_' => Some(ch),
            _ => None,
        };

        match keep {
            Some(c) => {
                out.push(c);
                last_dash = false;
            }
            None => {
                // Collapse any run of unsupported characters into a single dash.
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            }
        }
    }

    // Windows silently strips trailing dots and spaces, which would desync the name
    // we think we wrote from the one on disk.
    let mut slug: String = out.trim_matches(|c| c == '-' || c == '.' || c == ' ').to_string();

    if slug.len() > MAX_SLUG_LEN {
        slug.truncate(MAX_SLUG_LEN);
        slug = slug.trim_end_matches('-').to_string();
    }

    if slug.is_empty() {
        // Titles made entirely of non-ASCII characters land here.
        slug = format!("note-{}", short_id());
    }

    if RESERVED.contains(&slug.to_ascii_lowercase().as_str()) {
        slug.push('_');
    }

    slug
}

/// A short random suffix, used when a title gives us nothing to work with.
pub fn short_id() -> String {
    uuid::Uuid::new_v4().to_string()[..8].to_string()
}

/// A short, stable name for a vault, derived from its path.
///
/// Used for the per-vault folders this app keeps *outside* the vault — its search
/// index and its version history — so that two vaults never share either, and moving
/// a vault simply starts fresh rather than showing another vault's contents.
pub fn vault_key(vault: &Path) -> String {
    // FNV-1a. This one only has to separate two folder paths, never to tell two
    // versions of a note apart, so it does not need to be a strong hash.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in vault.to_string_lossy().as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Where a page's text goes when the file on disk turned out to have changed
/// underneath us.
///
/// Deliberately a plain `.md` file beside the page: it then shows up in the sidebar
/// by itself, instead of being hidden somewhere the person would have to be told
/// about. `stamp` is a human-readable date so the name says when it happened.
pub fn conflict_path(page: &Path, stamp: &str) -> PathBuf {
    let dir = page.parent().unwrap_or_else(|| Path::new("."));
    let stem = page
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "page".to_string());
    unique_path(dir, &format!("{stem}.conflict-{stamp}"), "md")
}

/// Whether `candidate` already exists in `dir`, comparing case-insensitively.
///
/// macOS and Windows both treat `Notes.md` and `notes.md` as the same file while Linux
/// does not, so we take the strict view everywhere and refuse the collision.
fn exists_case_insensitive(dir: &Path, candidate: &str) -> bool {
    let needle = candidate.to_ascii_lowercase();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.filter_map(|e| e.ok()).any(|e| {
        e.file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            == needle
    })
}

/// Build a path inside `dir` that does not collide with anything already there,
/// appending `-2`, `-3` and so on until it is free.
///
/// `ext` is the extension without the dot, or an empty string for a directory.
pub fn unique_path(dir: &Path, slug: &str, ext: &str) -> PathBuf {
    let name = |n: u32| -> String {
        let stem = if n == 1 {
            slug.to_string()
        } else {
            format!("{slug}-{n}")
        };
        if ext.is_empty() {
            stem
        } else {
            format!("{stem}.{ext}")
        }
    };

    let mut n = 1;
    loop {
        let candidate = name(n);
        if !exists_case_insensitive(dir, &candidate) {
            return dir.join(candidate);
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_characters_windows_rejects() {
        assert_eq!(slugify(r#"Ghidra: what *is* a "xref"?"#), "Ghidra-what-is-a-xref");
    }

    #[test]
    fn collapses_runs_and_trims_edges() {
        assert_eq!(slugify("  heap   //  spray  "), "heap-spray");
    }

    #[test]
    fn escapes_reserved_device_names() {
        assert_eq!(slugify("con"), "con_");
        assert_eq!(slugify("COM1"), "COM1_");
    }

    #[test]
    fn falls_back_when_nothing_ascii_survives() {
        assert!(slugify("日本語").starts_with("note-"));
    }

    #[test]
    fn truncates_without_leaving_a_trailing_dash() {
        let slug = slugify(&"word ".repeat(40));
        assert!(slug.len() <= MAX_SLUG_LEN);
        assert!(!slug.ends_with('-'));
    }

    #[test]
    fn a_conflict_copy_sits_beside_the_page_as_a_page() {
        let page = Path::new("/vault/notebooks/RE/upx-unpacking.md");
        let dest = conflict_path(page, "2026-10-28-143055");

        assert_eq!(dest.parent(), page.parent());
        assert_eq!(
            dest.file_name().unwrap(),
            "upx-unpacking.conflict-2026-10-28-143055.md"
        );
    }

    #[test]
    fn two_conflicts_in_the_same_second_do_not_overwrite_each_other() {
        let dir = std::env::temp_dir().join(format!("notehub-conflict-{}", short_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let page = dir.join("note.md");
        std::fs::write(&page, "x").unwrap();

        let first = conflict_path(&page, "2026-10-28-143055");
        std::fs::write(&first, "mine").unwrap();
        let second = conflict_path(&page, "2026-10-28-143055");

        assert_ne!(first, second);
        assert_eq!(second.file_name().unwrap(), "note.conflict-2026-10-28-143055-2.md");
    }

    #[test]
    fn two_vaults_get_different_keys_and_one_vault_keeps_its_own() {
        let a = vault_key(Path::new("/Users/jds/Notes"));
        let b = vault_key(Path::new("/Users/jds/Other"));

        assert_ne!(a, b);
        assert_eq!(a, vault_key(Path::new("/Users/jds/Notes")));
        assert_eq!(a.len(), 16);
    }
}
