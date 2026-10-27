# NoteHub

An offline notebook. Notes are plain Markdown files in a folder you choose, so they
sync through iCloud Drive, Dropbox or Syncthing without a subscription, and they stay
readable if this app ever goes away.

Notebooks hold sections, sections nest as deep as you like, and pages are documents
written top to bottom.

## Running it

```bash
npm install
npm run tauri dev
```

Needs Node and Rust. On macOS, if `cc` reports an Xcode licence error, either accept
it once with `sudo xcodebuild -license`, or point the build at the standalone tools:

```bash
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
```

## Building

```bash
npm run tauri build
```

The app bundle lands in `src-tauri/target/release/bundle/macos/NoteHub.app`. Copy it
out of `target/` before using it, since a rebuild wipes that folder.

The `.dmg` step at the end needs permission to control Finder (System Settings >
Privacy & Security > Automation), and fails without it. That failure does not affect
the `.app`, which is already built by then — a DMG is only needed to hand the app to
someone else.

## Tests

```bash
cd src-tauri && cargo test
```

## Vault layout

```
<vault>/
  notebooks/
    Reverse-Engineering/
      notebook.json
      Static-Analysis/
        section.json
        ghidra-basics.md
  .notehub/
    trash/
```

Each page is Markdown with a small YAML frontmatter block holding its id, title,
timestamps and tags. Filenames are ASCII slugs so the same vault opens on macOS and
Windows; the full title lives in the frontmatter. Deletes move items to
`.notehub/trash/` rather than destroying them.
