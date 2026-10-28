/**
 * The fonts, text colours and highlighters the toolbar offers, and the rules for
 * reading them back out of a file.
 *
 * A page is a plain Markdown file that is hand-editable and synced between machines,
 * so anything here can arrive having been written by something other than this app.
 * Everything crossing that boundary is therefore checked rather than trusted: a
 * colour has to be a plain six-digit hex, and a font has to be one of these. Neither
 * is ever interpolated into a style attribute without going through the checks below.
 */

export interface FontChoice {
  label: string;
  /** The full stack, so a machine missing the first font still reads sensibly. */
  stack: string;
}

/**
 * Kept to the faces that ship with both macOS and Windows. Nothing is downloaded —
 * the app works offline, and a font that resolves on one machine and not the other
 * would make the same note look different on each.
 */
export const FONTS: FontChoice[] = [
  { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  { label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  // Single quotes on purpose: these end up inside a double-quoted style attribute in
  // the file, and single quotes go in as they are rather than as &quot;.
  { label: "Trebuchet MS", stack: "'Trebuchet MS', Tahoma, sans-serif" },
  { label: "Tahoma", stack: "Tahoma, Geneva, sans-serif" },
  { label: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
  { label: "Times New Roman", stack: "'Times New Roman', Times, serif" },
  { label: "Garamond", stack: "Garamond, Georgia, serif" },
  { label: "Courier New", stack: "'Courier New', Courier, monospace" },
  { label: "Comic Sans MS", stack: "'Comic Sans MS', 'Comic Sans', cursive" },
];

export interface Swatch {
  label: string;
  value: string;
}

/**
 * Mid-tone on purpose. The page is white in the light theme and near-black in the
 * dark one, and the same colour has to stay readable on both — a dark navy
 * disappears against the dark page, a pale yellow against the light one.
 */
export const TEXT_COLORS: Swatch[] = [
  { label: "Red", value: "#d6453d" },
  { label: "Orange", value: "#c9741a" },
  { label: "Amber", value: "#b38600" },
  { label: "Green", value: "#2f9e5f" },
  { label: "Teal", value: "#0f9a9a" },
  { label: "Blue", value: "#3d82d8" },
  { label: "Purple", value: "#8b5fd6" },
  { label: "Magenta", value: "#cf4b96" },
  { label: "Grey", value: "#8b919c" },
];

/**
 * Pale, because a highlighter sits behind the text. The stylesheet pins the text on
 * a highlight to a dark ink in both themes, so light-on-pale never happens.
 */
export const HIGHLIGHTS: Swatch[] = [
  { label: "Yellow", value: "#fff3a3" },
  { label: "Green", value: "#c3edbd" },
  { label: "Blue", value: "#bfe1ff" },
  { label: "Pink", value: "#ffc9dd" },
  { label: "Orange", value: "#ffd8a8" },
  { label: "Purple", value: "#e2cfff" },
  { label: "Grey", value: "#e0e3e8" },
];

/**
 * A colour as a plain `#rrggbb`, or null if it is anything else.
 *
 * The browser hands back `rgb(214, 69, 69)` for a colour it has parsed out of a style
 * attribute, so saving what came back would rewrite the file on the first save after
 * every reload. Normalising to hex on the way out keeps the file still.
 */
export function canonicalColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    return digits.length === 3
      ? `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`
      : `#${digits}`;
  }

  const rgb = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/.exec(value);
  if (rgb) {
    const channels = [rgb[1], rgb[2], rgb[3]].map((n) => Number.parseInt(n, 10));
    if (channels.some((n) => n > 255)) return null;
    return `#${channels.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }

  return null;
}

/**
 * The stack this app writes for a font, matched on the first family name — which is
 * all that survives the browser's own parsing of a style attribute, quotes and
 * spacing included. Anything not on the list is dropped rather than passed through.
 */
export function canonicalFont(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(",")[0].replace(/['"]/g, "").trim().toLowerCase();
  if (!first) return null;
  return FONTS.find((f) => f.label.toLowerCase() === first)?.stack ?? null;
}

/** The label to show for a font the caret is sitting in. */
export function fontLabel(raw: string | null | undefined): string {
  const stack = canonicalFont(raw);
  return FONTS.find((f) => f.stack === stack)?.label ?? "";
}
