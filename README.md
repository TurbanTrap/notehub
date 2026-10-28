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
someone else. `npm run tauri build -- --bundles app` skips the step entirely.

### Windows installers

A Windows build has to happen on Windows, so it runs in GitHub Actions rather than on
this machine. Pushing a tag builds both platforms and opens a draft release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Running **Installers** by hand from the Actions tab builds the same things and attaches
them to the run without publishing anything. Mac gets one universal `.dmg`; Windows
gets an `.msi` and an NSIS `.exe`.

Neither is code-signed. On macOS the first launch needs right-click > Open; on Windows,
"More info" > "Run anyway" on the SmartScreen notice. Signing costs money per year on
both platforms, and nothing about this app needs it to work.

## Tests

```bash
cd src-tauri && cargo test
npx vitest run
```

## Syncing

A note can change while it is open — that is what a sync folder does. NoteHub watches
the vault and reacts rather than carrying on with stale text:

- **Nothing unsaved:** the arriving version simply replaces what is on screen.
- **Something unsaved:** the file that arrived is left untouched, and your text is
  written to a new page beside it, named `<page>.conflict-<date>.md`. Both versions
  are then in the sidebar. Nothing is merged automatically, because merging means
  guessing.

Each save is checked against a fingerprint of the file as it was loaded, so a clash is
caught even if the watcher misses an event.

**History** in a page's header lists earlier copies of its text, kept on this machine
in the app's data folder — outside the vault, so the sync folder never carries them,
and outside the cache folder, which the system may clear. One is kept every couple of
minutes while you work, and whenever a version arrives from elsewhere. Restoring puts
the text back and keeps what you were on, so it can be undone.

## Looks

**Light, Dark or Auto** at the bottom of the sidebar. Auto follows the system, and is
what a fresh install uses; choosing one pins it for this machine only, since the
setting lives in the app rather than in the vault.

**Notebook colours** come from the ⋯ menu on a notebook or section. The colour runs
down the spine of that notebook in the sidebar, tints its icons, and marks the open
page, so a vault with several notebooks reads as a shelf rather than a list. The name
of the colour is kept in `notebook.json`, so it travels with the notes.

## Vault layout

```
<vault>/
  notebooks/
    Reverse-Engineering/
      notebook.json          { "title": "Reverse Engineering", "color": "teal" }
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
