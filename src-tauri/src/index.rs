//! Full-text search, tags and backlinks, over a SQLite FTS5 index.
//!
//! The index is a cache and nothing else: every fact in it is derived from the
//! Markdown files, and deleting it costs only the time to build it again. It
//! deliberately lives outside the vault, in the app's cache folder, because a binary
//! database inside a folder synced by iCloud or Dropbox is a corruption waiting to
//! happen — and because each machine can rebuild its own in a second.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::page;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// A fragment of the body around the match. The matched words are wrapped in the
    /// control characters \u{1} and \u{2} rather than HTML tags, so the interface can
    /// render them as elements instead of injecting note content as markup.
    pub snippet: String,
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    pub path: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

/// Where this vault's index lives, inside `cache_dir`.
///
/// Named after the vault's path so that two vaults never share an index, and so that
/// moving a vault simply starts a new one rather than showing stale results.
pub fn db_path(cache_dir: &Path, vault: &Path) -> PathBuf {
    let key = vault.to_string_lossy();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    cache_dir.join(format!("index-{hash:016x}.sqlite"))
}

fn open(db: &Path) -> Result<Connection, String> {
    if let Some(parent) = db.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not open the index: {e}"))?;
    }
    let conn = Connection::open(db).map_err(|e| format!("could not open the index: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(
             path UNINDEXED, title, body, tags, tokenize = 'unicode61'
         );
         CREATE TABLE IF NOT EXISTS file_meta (
             path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, target TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS links_target ON links(target);
         CREATE TABLE IF NOT EXISTS page_tags (path TEXT NOT NULL, tag TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS page_tags_tag ON page_tags(tag);",
    )
    .map_err(|e| format!("could not prepare the index: {e}"))?;
    Ok(conn)
}

/// Bring the index in line with the vault, touching only what changed.
///
/// Returns how many pages were written. Files are compared on modification time and
/// size, so a sync client pulling in notes from the other machine is picked up without
/// rereading everything.
pub fn reindex(db: &Path, vault: &Path) -> Result<usize, String> {
    let conn = open(db)?;
    let files = collect_pages(vault);

    let mut known: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT path, mtime, size FROM file_meta")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            known.insert(row.0, row.1);
        }
    }

    let mut written = 0usize;
    let mut seen = std::collections::HashSet::new();

    for file in &files {
        let key = file.to_string_lossy().to_string();
        seen.insert(key.clone());

        let Ok(meta) = std::fs::metadata(file) else { continue };
        let stamp = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;

        if known.get(&key) == Some(&(stamp, size)) {
            continue;
        }

        write_page(&conn, file, stamp, size)?;
        written += 1;
    }

    // Pages deleted or moved since the last pass.
    for gone in known.keys().filter(|k| !seen.contains(*k)) {
        forget(&conn, gone)?;
    }

    Ok(written)
}

/// Re-read a single page. Used after a save, where scanning the whole vault would be
/// wasted work on every keystroke pause.
pub fn index_one(db: &Path, file: &Path) -> Result<(), String> {
    let conn = open(db)?;
    let Ok(meta) = std::fs::metadata(file) else {
        return forget(&conn, &file.to_string_lossy());
    };
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    write_page(&conn, file, stamp, meta.len() as i64)
}

fn write_page(conn: &Connection, file: &Path, mtime: i64, size: i64) -> Result<(), String> {
    let parsed = page::read(file)?;
    let key = file.to_string_lossy().to_string();

    forget(conn, &key)?;

    conn.execute(
        "INSERT INTO pages (path, title, body, tags) VALUES (?1, ?2, ?3, ?4)",
        params![key, parsed.title, parsed.body, parsed.tags.join(" ")],
    )
    .map_err(|e| format!("could not index a page: {e}"))?;

    conn.execute(
        "INSERT INTO file_meta (path, mtime, size) VALUES (?1, ?2, ?3)",
        params![key, mtime, size],
    )
    .map_err(|e| e.to_string())?;

    for target in extract_wiki_targets(&parsed.body) {
        conn.execute(
            "INSERT INTO links (src, target) VALUES (?1, ?2)",
            params![key, target.to_lowercase()],
        )
        .map_err(|e| e.to_string())?;
    }

    for tag in &parsed.tags {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT INTO page_tags (path, tag) VALUES (?1, ?2)",
            params![key, tag.to_lowercase()],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn forget(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM pages WHERE path = ?1", params![key])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM file_meta WHERE path = ?1", params![key])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM links WHERE src = ?1", params![key])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM page_tags WHERE path = ?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn search(db: &Path, query: &str, limit: u32) -> Result<Vec<SearchHit>, String> {
    let expression = to_fts_query(query);
    if expression.is_empty() {
        return Ok(Vec::new());
    }

    let conn = open(db)?;
    let mut stmt = conn
        .prepare(
            "SELECT path, title, snippet(pages, 2, char(1), char(2), '…', 14), tags
             FROM pages
             WHERE pages MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )
        .map_err(|e| format!("could not search: {e}"))?;

    let rows = stmt
        .query_map(params![expression, limit], |row| {
            Ok(SearchHit {
                path: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                tags: row
                    .get::<_, String>(3)?
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
            })
        })
        .map_err(|e| format!("could not search: {e}"))?;

    Ok(rows.flatten().collect())
}

/// Pages whose body contains a `[[link]]` to `title`.
pub fn backlinks(db: &Path, title: &str) -> Result<Vec<LinkRef>, String> {
    let conn = open(db)?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT p.path, p.title
             FROM links l JOIN pages p ON p.path = l.src
             WHERE l.target = ?1
             ORDER BY p.title COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![title.trim().to_lowercase()], |row| {
            Ok(LinkRef { path: row.get(0)?, title: row.get(1)? })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}

pub fn all_tags(db: &Path) -> Result<Vec<TagCount>, String> {
    let conn = open(db)?;
    let mut stmt = conn
        .prepare(
            "SELECT tag, COUNT(DISTINCT path) FROM page_tags
             GROUP BY tag ORDER BY COUNT(DISTINCT path) DESC, tag",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| Ok(TagCount { tag: row.get(0)?, count: row.get(1)? }))
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}

pub fn pages_with_tag(db: &Path, tag: &str) -> Result<Vec<LinkRef>, String> {
    let conn = open(db)?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT t.path, p.title
             FROM page_tags t JOIN pages p ON p.path = t.path
             WHERE t.tag = ?1
             ORDER BY p.title COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![tag.trim().to_lowercase()], |row| {
            Ok(LinkRef { path: row.get(0)?, title: row.get(1)? })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}

/// Turn what someone typed into an FTS5 expression.
///
/// Every term is stripped to letters and digits and then quoted, so that a query
/// containing `*`, `"`, `OR` or `NEAR` is searched for literally instead of being
/// read as query syntax — or failing outright, which is how a search box that errors
/// on an apostrophe happens. A trailing `*` makes the last term match as a prefix, so
/// results appear while still typing.
fn to_fts_query(input: &str) -> String {
    let mut terms: Vec<String> = Vec::new();

    for raw in input.split_whitespace() {
        let cleaned: String = raw
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if !cleaned.is_empty() {
            terms.push(format!("\"{cleaned}\"*"));
        }
    }

    terms.join(" ")
}

/// Every `[[target]]` in a body, ignoring those inside code.
///
/// A code sample containing `matrix[[0]]` must not register as a link, or backlinks
/// fill up with things nobody linked.
fn extract_wiki_targets(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut in_fence = false;

    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }

        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        let mut in_code_span = false;

        while i < chars.len() {
            if chars[i] == '`' {
                in_code_span = !in_code_span;
                i += 1;
                continue;
            }

            if !in_code_span && chars[i] == '[' && i + 1 < chars.len() && chars[i + 1] == '[' {
                if let Some(end) = find_closing(&chars, i + 2) {
                    let target: String = chars[i + 2..end].iter().collect();
                    let target = target.trim();
                    if !target.is_empty() {
                        found.push(target.to_string());
                    }
                    i = end + 2;
                    continue;
                }
            }

            i += 1;
        }
    }

    found
}

fn find_closing(chars: &[char], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 1 < chars.len() {
        if chars[i] == ']' && chars[i + 1] == ']' {
            return Some(i);
        }
        if chars[i] == ']' {
            return None;
        }
        i += 1;
    }
    None
}

/// Every `.md` file under the vault's notebooks folder.
fn collect_pages(vault: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(&vault.join("notebooks"), &mut out);
    out
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let hidden = path
            .file_name()
            .map(|n| n.to_string_lossy().starts_with('.'))
            .unwrap_or(true);
        if hidden {
            continue;
        }
        if path.is_dir() {
            walk(&path, out);
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault;

    fn fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("notehub-idx-{}", crate::paths::short_id()));
        std::fs::create_dir_all(&root).unwrap();
        vault::ensure(&root).unwrap();
        let db = root.join("index.sqlite");
        (root, db)
    }

    fn add_page(root: &Path, title: &str, body: &str) -> PathBuf {
        let tree = vault::read_tree(root).unwrap();
        let section = &tree[0].children[0];
        let node = vault::create_page(Path::new(&section.path), title).unwrap();
        let path = PathBuf::from(&node.path);
        let mut p = page::read(&path).unwrap();
        p.body = body.to_string();
        page::write(&path, &p).unwrap();
        path
    }

    #[test]
    fn finds_a_page_by_its_body() {
        let (root, db) = fixture();
        add_page(&root, "Anti Debugging", "The binary calls ptrace with PT_DENY_ATTACH.");
        reindex(&db, &root).unwrap();

        let hits = search(&db, "ptrace", 10).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Anti Debugging");
        assert!(hits[0].snippet.contains('\u{1}'), "match is marked");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_snippet_never_carries_markup_from_the_note() {
        // Rendering a snippet as HTML would otherwise run whatever a note contains.
        let (root, db) = fixture();
        add_page(&root, "Hostile", "before <script>alert(1)</script> ptrace after");
        reindex(&db, &root).unwrap();

        let hits = search(&db, "ptrace", 10).unwrap();

        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("<script>"), "text is returned verbatim");
        assert!(!hits[0].snippet.contains("<mark>"), "and no markup is added to it");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn matches_a_prefix_so_results_appear_while_typing() {
        let (root, db) = fixture();
        add_page(&root, "Packing", "This sample is packed with UPX.");
        reindex(&db, &root).unwrap();

        assert_eq!(search(&db, "pack", 10).unwrap().len(), 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_query_full_of_syntax_characters_does_not_error() {
        let (root, db) = fixture();
        add_page(&root, "Notes", "ordinary text");
        reindex(&db, &root).unwrap();

        // Each of these is FTS5 syntax and would otherwise fail the query.
        for query in ["\"", "*", "OR", "NEAR(", "a AND", "it's", "^$%"] {
            assert!(search(&db, query, 10).is_ok(), "query {query:?} should not error");
        }

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reindex_skips_files_that_have_not_changed() {
        let (root, db) = fixture();
        add_page(&root, "One", "first");

        assert_eq!(reindex(&db, &root).unwrap(), 2, "welcome page and the new one");
        assert_eq!(reindex(&db, &root).unwrap(), 0, "nothing re-read on a second pass");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_deleted_page_leaves_the_index() {
        let (root, db) = fixture();
        let path = add_page(&root, "Temporary", "soon gone");
        reindex(&db, &root).unwrap();
        assert_eq!(search(&db, "gone", 10).unwrap().len(), 1);

        vault::delete(&root, &path).unwrap();
        reindex(&db, &root).unwrap();

        assert_eq!(search(&db, "gone", 10).unwrap().len(), 0);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn backlinks_find_the_pages_that_point_here() {
        let (root, db) = fixture();
        add_page(&root, "Ghidra Basics", "Nothing links out from here.");
        add_page(&root, "Static Analysis", "Start with [[Ghidra Basics]] first.");
        add_page(&root, "Unrelated", "No links at all.");
        reindex(&db, &root).unwrap();

        let back = backlinks(&db, "ghidra basics").unwrap();

        assert_eq!(back.len(), 1);
        assert_eq!(back[0].title, "Static Analysis");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_link_inside_code_is_not_a_backlink() {
        let (root, db) = fixture();
        add_page(&root, "Target", "x");
        add_page(
            &root,
            "Sample",
            "Fenced:\n\n```\nmatrix[[Target]] = 1\n```\n\nInline: `arr[[Target]]`",
        );
        reindex(&db, &root).unwrap();

        assert!(
            backlinks(&db, "target").unwrap().is_empty(),
            "brackets in code are not links"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn tags_are_counted_and_searchable() {
        let (root, db) = fixture();
        let a = add_page(&root, "First", "body");
        let b = add_page(&root, "Second", "body");

        for path in [&a, &b] {
            let mut p = page::read(path).unwrap();
            p.tags = vec!["packing".into()];
            page::write(path, &p).unwrap();
        }
        reindex(&db, &root).unwrap();

        let tags = all_tags(&db).unwrap();
        let packing = tags.iter().find(|t| t.tag == "packing").unwrap();

        assert_eq!(packing.count, 2);
        assert_eq!(pages_with_tag(&db, "Packing").unwrap().len(), 2, "case insensitive");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn editing_a_page_replaces_its_old_text() {
        let (root, db) = fixture();
        let path = add_page(&root, "Changing", "the original wording");
        reindex(&db, &root).unwrap();

        let mut p = page::read(&path).unwrap();
        p.body = "completely different".into();
        page::write(&path, &p).unwrap();
        index_one(&db, &path).unwrap();

        assert_eq!(search(&db, "original", 10).unwrap().len(), 0, "old text is gone");
        assert_eq!(search(&db, "completely", 10).unwrap().len(), 1);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn two_vaults_do_not_share_an_index() {
        let cache = std::env::temp_dir();
        let a = db_path(&cache, Path::new("/one/vault"));
        let b = db_path(&cache, Path::new("/another/vault"));
        assert_ne!(a, b);
    }
}
