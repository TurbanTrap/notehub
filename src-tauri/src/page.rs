//! Reading and writing a single page: YAML frontmatter followed by Markdown body.
//!
//! The frontmatter values are written as JSON scalars. Every JSON string is also a
//! valid YAML double-quoted scalar, and every JSON array of strings is a valid YAML
//! flow sequence, so we get correct escaping of titles containing colons, quotes or
//! newlines without pulling in a YAML parser. Files stay readable in any editor and
//! are understood by other Markdown tools.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub title: String,
    pub created: String,
    pub updated: String,
    pub tags: Vec<String>,
    pub body: String,
}

impl Page {
    pub fn new(title: &str) -> Self {
        let now = now_iso();
        Page {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.to_string(),
            created: now.clone(),
            updated: now,
            tags: Vec::new(),
            body: String::new(),
        }
    }

    pub fn to_file_string(&self) -> String {
        let tags = serde_json::to_string(&self.tags).unwrap_or_else(|_| "[]".into());
        format!(
            "---\nid: {}\ntitle: {}\ncreated: {}\nupdated: {}\ntags: {}\n---\n\n{}",
            json_scalar(&self.id),
            json_scalar(&self.title),
            json_scalar(&self.created),
            json_scalar(&self.updated),
            tags,
            self.body.trim_start_matches('\n')
        )
    }

    /// Parse a page file. Markdown without frontmatter is still accepted, so that
    /// documents copied into the vault by hand open rather than erroring.
    pub fn from_file_string(raw: &str, fallback_title: &str) -> Self {
        // Tolerate a UTF-8 BOM and CRLF, both of which arrive via Windows sync.
        let text = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");

        let Some(rest) = text.strip_prefix("---\n") else {
            return Self::without_frontmatter(&text, fallback_title);
        };
        let Some(end) = rest.find("\n---") else {
            return Self::without_frontmatter(&text, fallback_title);
        };

        let header = &rest[..end];
        let body = rest[end + 4..].trim_start_matches('\n').to_string();

        let mut page = Page::new(fallback_title);
        page.body = body;

        for line in header.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            match key.trim() {
                "id" => {
                    if let Some(v) = parse_scalar(value) {
                        page.id = v;
                    }
                }
                "title" => {
                    if let Some(v) = parse_scalar(value) {
                        page.title = v;
                    }
                }
                "created" => {
                    if let Some(v) = parse_scalar(value) {
                        page.created = v;
                    }
                }
                "updated" => {
                    if let Some(v) = parse_scalar(value) {
                        page.updated = v;
                    }
                }
                "tags" => {
                    if let Ok(v) = serde_json::from_str::<Vec<String>>(value) {
                        page.tags = v;
                    }
                }
                _ => {}
            }
        }

        page
    }

    fn without_frontmatter(text: &str, fallback_title: &str) -> Self {
        let mut page = Page::new(fallback_title);
        // A leading `# Heading` is the best title guess for a hand-written file.
        if let Some(first) = text.lines().next() {
            if let Some(heading) = first.strip_prefix("# ") {
                if !heading.trim().is_empty() {
                    page.title = heading.trim().to_string();
                }
            }
        }
        page.body = text.to_string();
        page
    }
}

/// A page as it was on disk at one moment: the parsed page, the exact text it came
/// from, and the fingerprint of the bytes that were read.
pub struct Loaded {
    pub page: Page,
    pub raw: String,
    pub hash: String,
}

/// Read a page from disk, falling back to the filename for the title.
pub fn read(path: &Path) -> Result<Page, String> {
    load(path).map(|loaded| loaded.page)
}

/// Read a page together with its fingerprint and its original text.
///
/// One read, not three: a save needs the parsed page to keep its id and tags, the raw
/// text to keep a copy of in history, and the fingerprint to check that the file has
/// not moved on since the editor loaded it. Reading separately for each would leave a
/// window in which a sync client could write between them, and the save would then
/// mix two versions of the file together.
pub fn load(path: &Path) -> Result<Loaded, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("could not read page: {e}"))?;
    let hash = crate::fingerprint::of_bytes(&bytes);
    // Lossy rather than an error: a note mangled by some other tool should still open
    // so its text can be rescued, instead of becoming unreachable from the app.
    let raw = String::from_utf8_lossy(&bytes).to_string();
    let fallback = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".into());

    Ok(Loaded {
        page: Page::from_file_string(&raw, &fallback),
        raw,
        hash,
    })
}

/// Write a page to disk atomically.
///
/// The content goes to a temporary file in the same directory first and is then
/// renamed over the target, so a crash or a sync client reading mid-write can never
/// observe a half-written note.
pub fn write(path: &Path, page: &Page) -> Result<(), String> {
    write_text(path, &page.to_file_string())
}

/// Write already-serialised page text.
///
/// Callers that need to know the fingerprint of what landed on disk serialise once and
/// hash the same string they pass here, rather than reading the file back and hoping
/// nothing wrote to it in between.
pub fn write_text(path: &Path, text: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "page path has no parent directory".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create folder: {e}"))?;

    let tmp = dir.join(format!(".{}.tmp", crate::paths::short_id()));
    std::fs::write(&tmp, text).map_err(|e| format!("could not write page: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not save page: {e}")
    })
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn json_scalar(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// Accept both the quoted form we write and the bare form a person may have typed.
fn parse_scalar(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<String>(value) {
        return Some(v);
    }
    Some(value.trim_matches('\'').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_difficult_title() {
        let mut page = Page::new(r#"Ghidra: "xrefs" & stack frames"#);
        page.body = "## Notes\n\nSome text.".into();

        let parsed = Page::from_file_string(&page.to_file_string(), "fallback");

        assert_eq!(parsed.title, r#"Ghidra: "xrefs" & stack frames"#);
        assert_eq!(parsed.body, "## Notes\n\nSome text.");
        assert_eq!(parsed.id, page.id);
    }

    #[test]
    fn round_trips_tags() {
        let mut page = Page::new("Tagged");
        page.tags = vec!["packing".into(), "anti-debug".into()];
        let parsed = Page::from_file_string(&page.to_file_string(), "fallback");
        assert_eq!(parsed.tags, vec!["packing", "anti-debug"]);
    }

    #[test]
    fn reads_plain_markdown_without_frontmatter() {
        let parsed = Page::from_file_string("# Imported Note\n\nBody here.", "fallback");
        assert_eq!(parsed.title, "Imported Note");
        assert_eq!(parsed.body, "# Imported Note\n\nBody here.");
    }

    #[test]
    fn survives_crlf_from_windows() {
        let parsed = Page::from_file_string(
            "---\r\nid: \"abc\"\r\ntitle: \"Windows\"\r\n---\r\n\r\nBody",
            "fallback",
        );
        assert_eq!(parsed.title, "Windows");
        assert_eq!(parsed.body, "Body");
    }

    #[test]
    fn body_containing_a_divider_is_not_truncated() {
        let mut page = Page::new("Dividers");
        page.body = "Before\n\n---\n\nAfter".into();
        let parsed = Page::from_file_string(&page.to_file_string(), "fallback");
        assert_eq!(parsed.body, "Before\n\n---\n\nAfter");
    }
}
