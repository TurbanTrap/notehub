//! Bringing an existing folder of Markdown into the vault as a notebook.
//!
//! The folder structure is mirrored: subfolders become sections, `.md` files become
//! pages. Nothing in the source folder is modified or moved — it is read and copied.
//!
//! Two things are rewritten on the way in, because an imported library that cannot be
//! navigated is just a pile of files:
//!
//! - Links between documents that were imported together become `[[wiki links]]`, so
//!   they work inside the app and show up in the backlinks panel.
//! - Images that live inside the folder are copied next to the page that uses them and
//!   relinked, so they actually appear.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::page::{self, Page};
use crate::paths;
use crate::vault;

/// A folder of notes, not a source tree. Past this it is almost certainly the wrong
/// folder, and importing it would bury the vault.
const MAX_FILES: usize = 4000;

/// A Markdown file larger than this is a data dump that happens to end in `.md`.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// How far into a file to look for its title before giving up on finding a heading.
const TITLE_SCAN_LINES: usize = 120;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub notebook_path: String,
    pub notebook_title: String,
    pub pages: usize,
    pub sections: usize,
    /// Images copied in beside the pages that use them.
    pub images: usize,
    /// Links between imported documents turned into `[[wiki links]]`.
    pub links: usize,
    /// What was left behind, and why. Capped, since the reason repeats.
    pub skipped: Vec<String>,
}

/// One source file, and where it is going.
struct Planned {
    source: PathBuf,
    dest: PathBuf,
    title: String,
    body: String,
}

pub fn import_folder(
    vault: &Path,
    source: &Path,
    notebook_title: &str,
) -> Result<ImportSummary, String> {
    let source = source
        .canonicalize()
        .map_err(|e| format!("could not open that folder: {e}"))?;
    let vault_real = vault
        .canonicalize()
        .map_err(|e| format!("could not open the notes folder: {e}"))?;

    // Importing the vault into itself would copy pages into a notebook inside the
    // folder being walked, and never finish.
    if source.starts_with(&vault_real) || vault_real.starts_with(&source) {
        return Err("that folder is inside your notes folder — pick one from somewhere else".into());
    }

    let mut skipped = Vec::new();
    let files = collect(&source, &mut skipped);
    if files.is_empty() {
        return Err("there are no Markdown files in that folder".into());
    }

    let notebook = vault::create_notebook(&vault_real, notebook_title)?;
    let notebook_dir = PathBuf::from(&notebook.path);

    // Two passes. The first decides every page's title and filename, because a link
    // from the first file to the last can only be rewritten once the last one's title
    // is known.
    let mut taken: HashSet<PathBuf> = HashSet::new();
    // Sorted by path, so a parent section is always made before anything inside it.
    let mut sections: BTreeMap<PathBuf, String> = BTreeMap::new();
    let mut plan: Vec<Planned> = Vec::new();
    let mut titles: HashMap<PathBuf, String> = HashMap::new();

    for file in files {
        let Ok(raw) = std::fs::read_to_string(&file) else {
            note_skip(&mut skipped, &file, &source, "could not be read as text");
            continue;
        };

        let relative = file.strip_prefix(&source).unwrap_or(&file);
        let dir = section_dir(&notebook_dir, relative, &mut sections);
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "note".into());

        let (title, body) = title_and_body(&raw, &stem);
        let dest = reserve(&dir, &paths::slugify(&title), &mut taken);

        titles.insert(file.clone(), title.clone());
        plan.push(Planned {
            source: file,
            dest,
            title,
            body,
        });
    }

    // Every section folder has to exist before the pages are written into it.
    let mut made_sections = 0usize;
    for (dir, title) in &sections {
        if vault::ensure_section(dir, title).is_ok() {
            made_sections += 1;
        }
    }

    let mut summary = ImportSummary {
        notebook_path: notebook.path.clone(),
        notebook_title: notebook.title.clone(),
        sections: made_sections,
        skipped,
        ..Default::default()
    };

    for item in &plan {
        let (body, links) = rewrite_links(&item.body, &item.source, &titles);
        let (body, images) = relocate_images(&body, &source, &item.source, &item.dest);

        let mut page = Page::new(&item.title);
        page.body = body;

        if let Err(e) = page::write(&item.dest, &page) {
            note_skip(&mut summary.skipped, &item.source, &source, &e);
            continue;
        }

        summary.pages += 1;
        summary.links += links;
        summary.images += images;
    }

    Ok(summary)
}

/// Every Markdown file under `root`, deepest paths last.
///
/// Anything with a leading dot is skipped — `.git`, and the build configuration that
/// documentation folders tend to carry, neither of which is a note.
fn collect(root: &Path, skipped: &mut Vec<String>) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut queue = vec![root.to_path_buf()];

    while let Some(dir) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }

            if path.is_dir() {
                queue.push(path);
                continue;
            }

            if !is_markdown(&path) {
                continue;
            }
            if found.len() >= MAX_FILES {
                note_skip(skipped, &path, root, "too many files in that folder");
                continue;
            }
            if entry.metadata().map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
                note_skip(skipped, &path, root, "larger than 4 MB");
                continue;
            }
            found.push(path);
        }
    }

    found.sort();
    found
}

fn is_markdown(path: &Path) -> bool {
    path.extension().is_some_and(|ext| {
        let ext = ext.to_string_lossy().to_ascii_lowercase();
        ext == "md" || ext == "markdown" || ext == "mdx"
    })
}

/// Where a source file's page goes, recording the section folders it needs on the way.
fn section_dir(
    notebook: &Path,
    relative: &Path,
    sections: &mut BTreeMap<PathBuf, String>,
) -> PathBuf {
    let mut dir = notebook.to_path_buf();
    let parts: Vec<_> = relative.components().collect();

    // The last component is the file itself.
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        let title = humanize(&part.as_os_str().to_string_lossy());
        dir = dir.join(paths::slugify(&title));
        sections.insert(dir.clone(), title);
    }
    dir
}

/// A free filename in `dir`, counting names already promised to earlier files.
///
/// The files do not exist yet at this point, so the filesystem alone cannot answer
/// whether a name is taken.
fn reserve(dir: &Path, slug: &str, taken: &mut HashSet<PathBuf>) -> PathBuf {
    let mut n = 1;
    loop {
        let stem = if n == 1 {
            slug.to_string()
        } else {
            format!("{slug}-{n}")
        };
        let candidate = dir.join(format!("{stem}.md"));
        if !taken.contains(&candidate) && !candidate.exists() {
            taken.insert(candidate.clone());
            return candidate;
        }
        n += 1;
    }
}

/// A document's title, and its body with that title's heading removed.
///
/// Frontmatter wins, then the first `# heading`, then the filename. The heading is
/// taken out of the body because the app already shows the title above the page, and
/// leaving it in means every imported note starts by saying its own name twice.
fn title_and_body(raw: &str, stem: &str) -> (String, String) {
    // Parses our own frontmatter and anybody else's simple `key: value` block, and
    // hands back the body with the block removed.
    //
    // Careful: this reports a title from frontmatter *and* from a heading when that
    // heading is the very first line — and in the second case the heading is still
    // sitting in the body. So the heading is found again here rather than trusting
    // that a title means frontmatter.
    let parsed = Page::from_file_string(raw, "");
    let heading = find_heading(&parsed.body);

    let title = match (parsed.title.trim(), &heading) {
        ("", Some((found, _))) => found.clone(),
        ("", None) => humanize(stem),
        (from_frontmatter, _) => from_frontmatter.to_string(),
    };

    // Take the heading out only when it is the one the title came from. A document
    // whose frontmatter names it something else keeps its first heading, because
    // there it is content rather than a repeat of the title.
    match heading {
        Some((found, line)) if found == title => (title, strip_line(&parsed.body, line)),
        _ => (title, parsed.body),
    }
}

/// The first top-level heading, and which line it was on.
fn find_heading(body: &str) -> Option<(String, usize)> {
    for (index, line) in body.lines().take(TITLE_SCAN_LINES).enumerate() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let title = rest.trim().trim_end_matches('#').trim();
            if !title.is_empty() {
                return Some((title.to_string(), index));
            }
        }
    }
    None
}

fn strip_line(body: &str, line: usize) -> String {
    let kept: Vec<&str> = body
        .lines()
        .enumerate()
        .filter(|(index, _)| *index != line)
        .map(|(_, text)| text)
        .collect();
    kept.join("\n").trim_start_matches('\n').to_string()
}

/// `ghidra-mips` becomes `Ghidra mips`: readable, without pretending to know which
/// words in a filename are proper nouns.
fn humanize(name: &str) -> String {
    let spaced: String = name
        .chars()
        .map(|c| if c == '-' || c == '_' { ' ' } else { c })
        .collect();
    let spaced = spaced.trim();

    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Untitled".to_string(),
    }
}

/// Turn `[text](./other.md)` into `[[Other's Title]]` when the target came in too.
///
/// The link text is dropped, since a wiki link is addressed by title and has no room
/// for an alias. Anchors are dropped with it: the app has no way to scroll to one.
/// Links to anything that was not imported — the web, or a file outside the folder —
/// are left exactly as they were.
fn rewrite_links(body: &str, from: &Path, titles: &HashMap<PathBuf, String>) -> (String, usize) {
    let base = from.parent().unwrap_or_else(|| Path::new("."));
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    let mut count = 0usize;

    while let Some(start) = rest.find('[') {
        // An image is `![...]`, and belongs to the other rewriter.
        if start > 0 && rest.as_bytes()[start - 1] == b'!' {
            out.push_str(&rest[..start + 1]);
            rest = &rest[start + 1..];
            continue;
        }

        let Some(link) = parse_link(&rest[start..]) else {
            out.push_str(&rest[..start + 1]);
            rest = &rest[start + 1..];
            continue;
        };

        match resolve(base, &link.target).and_then(|path| titles.get(&path)) {
            Some(title) => {
                out.push_str(&rest[..start]);
                out.push_str(&format!("[[{title}]]"));
                count += 1;
            }
            None => out.push_str(&rest[..start + link.length]),
        }
        rest = &rest[start + link.length..];
    }

    out.push_str(rest);
    (out, count)
}

/// Copy images that live inside the imported folder next to the page that uses them.
///
/// Remote images and anything outside the folder are left alone: following those would
/// mean reaching for files the person did not offer.
fn relocate_images(
    body: &str,
    root: &Path,
    from: &Path,
    page_path: &Path,
) -> (String, usize) {
    let base = from.parent().unwrap_or_else(|| Path::new("."));
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    let mut count = 0usize;

    while let Some(start) = rest.find("![") {
        let Some(link) = parse_link(&rest[start + 1..]) else {
            out.push_str(&rest[..start + 2]);
            rest = &rest[start + 2..];
            continue;
        };
        let whole = start + 1 + link.length;

        let copied = resolve(base, &link.target)
            .filter(|path| path.starts_with(root))
            .and_then(|path| copy_asset(&path, page_path));

        match copied {
            Some(relative) => {
                out.push_str(&rest[..start]);
                out.push_str(&format!("![{}]({})", link.text, relative));
                count += 1;
            }
            None => out.push_str(&rest[..whole]),
        }
        rest = &rest[whole..];
    }

    out.push_str(rest);
    (out, count)
}

fn copy_asset(image: &Path, page_path: &Path) -> Option<String> {
    let name = image.file_name()?.to_string_lossy().to_string();
    let bytes = std::fs::read(image).ok()?;
    vault::save_asset(page_path, &name, &bytes).ok()
}

struct Link {
    text: String,
    target: String,
    /// How much of the input the whole `[text](target)` took up.
    length: usize,
}

/// Parse `[text](target)` starting at the `[`.
///
/// Hand-rolled rather than pulling in a regex engine for two patterns. It handles the
/// title form `(path "title")` and the angled form `(<path>)`, and refuses anything
/// with a line break inside, which Markdown does not allow in a link anyway.
fn parse_link(input: &str) -> Option<Link> {
    let bytes = input.as_bytes();
    if bytes.first() != Some(&b'[') {
        return None;
    }

    let mut depth = 0usize;
    let mut close = None;
    for (index, ch) in input.char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(index);
                    break;
                }
            }
            '\n' => return None,
            _ => {}
        }
    }

    let close = close?;
    if input[close + 1..].chars().next() != Some('(') {
        return None;
    }

    let open = close + 1;
    let mut end = None;
    for (index, ch) in input[open..].char_indices() {
        match ch {
            ')' => {
                end = Some(open + index);
                break;
            }
            '\n' => return None,
            _ => {}
        }
    }

    let end = end?;
    let inside = input[open + 1..end].trim();
    let target = match inside.strip_prefix('<') {
        // The angled form exists so that a path may contain spaces, so the space must
        // not be what ends it.
        Some(angled) => angled.split('>').next().unwrap_or(angled),
        // Otherwise whitespace separates the path from a link title.
        None => inside
            .split_once(char::is_whitespace)
            .map(|(path, _)| path)
            .unwrap_or(inside),
    };

    Some(Link {
        text: input[1..close].to_string(),
        target: target.to_string(),
        length: end + 1,
    })
}

/// Where a relative link points, if it points at a local file at all.
fn resolve(base: &Path, target: &str) -> Option<PathBuf> {
    let target = target.split('#').next().unwrap_or(target);
    if target.is_empty() || target.contains("://") || target.starts_with("//") {
        return None;
    }
    // A mail or tel link, and anything else with a scheme.
    if target.starts_with("mailto:") || target.starts_with('#') {
        return None;
    }

    let joined = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        base.join(target)
    };
    joined.canonicalize().ok()
}

fn note_skip(skipped: &mut Vec<String>, file: &Path, root: &Path, why: &str) {
    if skipped.len() >= 20 {
        return;
    }
    let name = file
        .strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .to_string();
    skipped.push(format!("{name} — {why}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("notehub-import-{}", paths::short_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, relative: &str, text: &str) -> PathBuf {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    /// Import `source` into a fresh vault and hand back both.
    fn run(source: &Path) -> (PathBuf, ImportSummary) {
        let vault = temp();
        vault::ensure(&vault).unwrap();
        let summary = import_folder(&vault, source, "Imported").unwrap();
        (vault, summary)
    }

    #[test]
    fn mirrors_folders_as_sections() {
        let source = temp();
        write(&source, "top.md", "# Top\n\nText.");
        write(&source, "deeper/inner.md", "# Inner\n\nText.");
        write(&source, "deeper/further/down.md", "# Down\n\nText.");

        let (_, summary) = run(&source);

        assert_eq!(summary.pages, 3);
        assert_eq!(summary.sections, 2, "deeper and deeper/further");
        let notebook = Path::new(&summary.notebook_path);
        assert!(notebook.join("top.md").exists());
        assert!(notebook.join("deeper/inner.md").exists());
        assert!(notebook.join("deeper/further/down.md").exists());
    }

    #[test]
    fn takes_the_title_from_the_first_heading_and_removes_it() {
        let source = temp();
        // The heading is often not on the first line — documentation tends to open
        // with a banner or a row of links.
        write(&source, "doc.md", "<div align=\"center\">\n\n# Ghidra on MIPS\n\nBody text.");

        let (_, summary) = run(&source);
        let page = page::read(&Path::new(&summary.notebook_path).join("Ghidra-on-MIPS.md")).unwrap();

        assert_eq!(page.title, "Ghidra on MIPS");
        assert!(!page.body.contains("# Ghidra on MIPS"), "title repeated in the body");
        assert!(page.body.contains("Body text."));
    }

    #[test]
    fn removes_the_heading_when_it_is_the_very_first_line() {
        let source = temp();
        // The ordinary shape of a documentation file, and the one the first version of
        // this missed: the heading-on-line-one case took a different path through the
        // frontmatter parser, and left the title sitting in the body of 243 pages.
        write(&source, "doc.md", "# ELF note tables\n\nBody text.");

        let (_, summary) = run(&source);
        let page = page::read(&Path::new(&summary.notebook_path).join("ELF-note-tables.md")).unwrap();

        assert_eq!(page.title, "ELF note tables");
        assert!(!page.body.contains("# ELF note tables"), "got: {}", page.body);
        assert!(page.body.starts_with("Body text."));
    }

    #[test]
    fn a_heading_that_is_not_the_title_is_left_in_place() {
        let source = temp();
        write(&source, "doc.md", "---\ntitle: Real Title\n---\n\n# Something Else\n\nBody.");

        let (_, summary) = run(&source);
        let page = page::read(&Path::new(&summary.notebook_path).join("Real-Title.md")).unwrap();

        // Here the heading is content, not a repeat of the title.
        assert!(page.body.contains("# Something Else"));
    }

    #[test]
    fn frontmatter_title_wins_and_the_block_does_not_end_up_in_the_note() {
        let source = temp();
        write(&source, "doc.md", "---\ntitle: From Frontmatter\nlayout: home\n---\n\n# Other\n\nBody.");

        let (_, summary) = run(&source);
        let page = page::read(&Path::new(&summary.notebook_path).join("From-Frontmatter.md")).unwrap();

        assert_eq!(page.title, "From Frontmatter");
        assert!(!page.body.contains("layout: home"));
    }

    #[test]
    fn falls_back_to_the_filename() {
        let source = temp();
        write(&source, "elf-notes.md", "Just text, no heading.");

        let (_, summary) = run(&source);
        let page = page::read(&Path::new(&summary.notebook_path).join("Elf-notes.md")).unwrap();

        assert_eq!(page.title, "Elf notes");
    }

    #[test]
    fn links_between_imported_documents_become_wiki_links() {
        let source = temp();
        write(&source, "one.md", "# One\n\nSee [the other page](./two.md) and [two again](two.md#part).");
        write(&source, "two.md", "# Two\n\nText.");

        let (_, summary) = run(&source);
        let page = page::read(&Path::new(&summary.notebook_path).join("One.md")).unwrap();

        assert!(page.body.contains("[[Two]]"), "got: {}", page.body);
        assert_eq!(page.body.matches("[[Two]]").count(), 2, "the anchored one too");
        assert_eq!(summary.links, 2);
    }

    #[test]
    fn links_across_folders_are_followed() {
        let source = temp();
        write(&source, "guides/one.md", "# One\n\n[up and over](../specs/two.md)");
        write(&source, "specs/two.md", "# Two\n\nText.");

        let (_, summary) = run(&source);
        let page = page::read(&Path::new(&summary.notebook_path).join("guides/One.md")).unwrap();

        assert!(page.body.contains("[[Two]]"), "got: {}", page.body);
    }

    #[test]
    fn web_links_and_dangling_links_are_left_alone() {
        let source = temp();
        write(
            &source,
            "one.md",
            "# One\n\n[docs](https://example.com) [gone](./missing.md) [up](../outside.md)",
        );

        let (_, summary) = run(&source);
        let page = page::read(&Path::new(&summary.notebook_path).join("One.md")).unwrap();

        assert!(page.body.contains("[docs](https://example.com)"));
        assert!(page.body.contains("[gone](./missing.md)"));
        assert!(page.body.contains("[up](../outside.md)"));
        assert_eq!(summary.links, 0);
    }

    #[test]
    fn images_inside_the_folder_are_copied_in_and_relinked() {
        let source = temp();
        write(&source, "one.md", "# One\n\n![a diagram](./pics/flow.png)");
        std::fs::create_dir_all(source.join("pics")).unwrap();
        std::fs::write(source.join("pics/flow.png"), b"\x89PNG not really").unwrap();

        let (_, summary) = run(&source);
        let notebook = Path::new(&summary.notebook_path);
        let page = page::read(&notebook.join("One.md")).unwrap();

        assert_eq!(summary.images, 1);
        assert!(page.body.contains("![a diagram](assets/"), "got: {}", page.body);
        assert!(notebook.join("assets/flow.png").exists());
    }

    #[test]
    fn remote_images_and_ones_outside_the_folder_are_left_as_they_are() {
        let source = temp();
        let outside = temp();
        std::fs::write(outside.join("secret.png"), b"not yours").unwrap();
        let escape = format!("![x]({})", outside.join("secret.png").display());
        write(&source, "one.md", &format!("# One\n\n![badge](https://img.example/b.svg)\n\n{escape}"));

        let (_, summary) = run(&source);
        let notebook = Path::new(&summary.notebook_path);
        let page = page::read(&notebook.join("One.md")).unwrap();

        assert_eq!(summary.images, 0);
        assert!(page.body.contains("https://img.example/b.svg"));
        // The point: an import must not pull in files from elsewhere on the machine
        // just because a document asked it to.
        assert!(!notebook.join("assets/secret.png").exists());
    }

    #[test]
    fn two_documents_with_one_title_do_not_overwrite_each_other() {
        let source = temp();
        write(&source, "a.md", "# Same Name\n\nFirst.");
        write(&source, "b.md", "# Same Name\n\nSecond.");

        let (_, summary) = run(&source);
        let notebook = Path::new(&summary.notebook_path);

        assert_eq!(summary.pages, 2);
        assert!(notebook.join("Same-Name.md").exists());
        assert!(notebook.join("Same-Name-2.md").exists());
    }

    #[test]
    fn hidden_folders_are_not_imported() {
        let source = temp();
        write(&source, "real.md", "# Real\n\nText.");
        write(&source, ".vitepress/config.md", "# Build config\n\nNot a note.");

        let (_, summary) = run(&source);

        assert_eq!(summary.pages, 1);
    }

    #[test]
    fn non_markdown_files_are_ignored() {
        let source = temp();
        write(&source, "real.md", "# Real\n\nText.");
        write(&source, "data.json", "{}");
        write(&source, "notes.markdown", "# Also real\n\nText.");

        let (_, summary) = run(&source);

        assert_eq!(summary.pages, 2);
    }

    #[test]
    fn refuses_a_folder_inside_the_vault() {
        let vault = temp();
        vault::ensure(&vault).unwrap();
        let inside = vault.join("notebooks");

        // Walking the folder it is writing into would never finish.
        assert!(import_folder(&vault, &inside, "Loop").is_err());
    }

    #[test]
    fn refuses_a_folder_with_no_markdown_in_it() {
        let source = temp();
        write(&source, "readme.txt", "not markdown");
        let vault = temp();
        vault::ensure(&vault).unwrap();

        assert!(import_folder(&vault, &source, "Empty").is_err());
    }

    #[test]
    fn a_code_fence_is_not_mistaken_for_a_link() {
        let source = temp();
        write(&source, "one.md", "# One\n\n```\nmatrix[0] = f(x)\n```\n\n[two](./two.md)");
        write(&source, "two.md", "# Two\n\nText.");

        let (_, summary) = run(&source);
        let page = page::read(&Path::new(&summary.notebook_path).join("One.md")).unwrap();

        assert!(page.body.contains("matrix[0] = f(x)"));
        assert!(page.body.contains("[[Two]]"));
    }

    #[test]
    fn parses_the_awkward_link_forms() {
        assert_eq!(parse_link("[a](b.md)").unwrap().target, "b.md");
        assert_eq!(parse_link("[a](b.md \"Title\")").unwrap().target, "b.md");
        assert_eq!(parse_link("[a](<b c.md>)").unwrap().target, "b c.md");
        assert_eq!(parse_link("[nested [brackets]](b.md)").unwrap().target, "b.md");
        assert!(parse_link("[unclosed").is_none());
        assert!(parse_link("[a]\n(b.md)").is_none());
        assert!(parse_link("[a] not a link").is_none());
    }
}
