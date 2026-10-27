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
}
