/**
 * Which operating system the window is running on, as far as the interface cares.
 *
 * NoteHub ships on both, and a handful of things are genuinely different rather
 * than cosmetic: the shortcut key people expect, what they call the folder window
 * the notes open in, and the strip of empty space macOS needs at the top left for
 * its traffic lights. Hard-coding the Mac answers would make the Windows build
 * look like a port that nobody finished.
 *
 * Read from the user agent rather than through a Tauri plugin: the app only needs
 * the answer in the web layer, and a dependency for one string is not worth it.
 */
export type Os = "mac" | "windows" | "other";

export function detectOs(ua: string): Os {
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return "mac";
  if (/Win/.test(ua)) return "windows";
  return "other";
}

/** How this machine writes the modifier in a shortcut, e.g. ⌘K against Ctrl+K. */
export function modLabel(os: Os): string {
  return os === "mac" ? "⌘" : "Ctrl+";
}

/** What this machine calls the program that shows a folder. */
export function fileManager(os: Os): string {
  if (os === "mac") return "Finder";
  if (os === "windows") return "File Explorer";
  return "your file manager";
}
