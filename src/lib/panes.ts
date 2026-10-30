/**
 * How wide the side panels are, and whether the right one is showing.
 *
 * In localStorage rather than in the vault, for the same reason as the theme: this
 * describes a window on this machine, not the notes. A laptop and a wide monitor want
 * different proportions, and a synced vault should not drag one machine's onto the
 * other.
 */

export interface PaneRange {
  /** Narrow enough to be useful, wide enough that the labels still read. */
  min: number;
  /** Past this the panel is taking the page's space rather than sharing it. */
  max: number;
  /** Where it sits before anyone drags it, and what a double-click returns to. */
  fallback: number;
}

export const SIDEBAR: PaneRange = { min: 170, max: 560, fallback: 262 };
export const OUTLINE: PaneRange = { min: 160, max: 460, fallback: 214 };

const SIDEBAR_KEY = "notehub.sidebarWidth";
const OUTLINE_KEY = "notehub.outlineWidth";
const OUTLINE_SHOWN_KEY = "notehub.outlineShown";

export function clampWidth(width: number, range: PaneRange): number {
  return Math.round(Math.min(Math.max(width, range.min), range.max));
}

/**
 * Make sense of whatever was in storage.
 *
 * Separate from the readers so it can be tested without a DOM. The value comes from a
 * store the app does not control — an older build, another window, something typed
 * into devtools — so a width that would squash a panel to nothing or push the page
 * off the window has to land back inside the range rather than on the layout.
 */
export function parseWidth(stored: string | null, range: PaneRange): number {
  const value = Number.parseInt(stored ?? "", 10);
  return Number.isFinite(value) ? clampWidth(value, range) : range.fallback;
}

/** Hidden unless it was explicitly left showing. */
export function parseShown(stored: string | null): boolean {
  return stored === "true";
}

function read(key: string, range: PaneRange): number {
  try {
    return parseWidth(localStorage.getItem(key), range);
  } catch {
    // Private windows and locked-down webviews throw on access rather than
    // returning null. The default layout is the right answer either way.
    return range.fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembering the size is a far smaller problem than not applying it.
  }
}

export const readSidebarWidth = (): number => read(SIDEBAR_KEY, SIDEBAR);
export const writeSidebarWidth = (width: number): void =>
  write(SIDEBAR_KEY, String(clampWidth(width, SIDEBAR)));

export const readOutlineWidth = (): number => read(OUTLINE_KEY, OUTLINE);
export const writeOutlineWidth = (width: number): void =>
  write(OUTLINE_KEY, String(clampWidth(width, OUTLINE)));

export function readOutlineShown(): boolean {
  try {
    return parseShown(localStorage.getItem(OUTLINE_SHOWN_KEY));
  } catch {
    return false;
  }
}

export const writeOutlineShown = (shown: boolean): void =>
  write(OUTLINE_SHOWN_KEY, String(shown));
