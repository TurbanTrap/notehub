/**
 * Light, dark, or whatever the operating system is doing.
 *
 * The choice lives in localStorage rather than in the vault: it describes this
 * machine, and a vault synced between a laptop in a dark room and a desktop by a
 * window should not drag one machine's lighting over to the other.
 */
export type Theme = "light" | "dark" | "system";

export const THEMES: Theme[] = ["light", "dark", "system"];

const KEY = "notehub.theme";

/**
 * Make sense of whatever was in storage.
 *
 * Separate from `readTheme` so it can be tested without a DOM: the value comes
 * from a store the app does not control, and anything unrecognised — a key left
 * by an older build, or something a person typed into devtools — has to land on
 * "system" rather than on the document as an attribute.
 */
export function parseTheme(stored: string | null): Theme {
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function readTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(KEY));
  } catch {
    // Private windows and locked-down webviews throw on access rather than
    // returning null. Following the system is the right answer either way.
    return "system";
  }
}

/**
 * Put the choice on the document and remember it.
 *
 * "system" removes the attribute instead of setting it, which is what lets the
 * `prefers-color-scheme` rules in App.css take over again.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }

  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not being able to remember it is a smaller problem than not applying it.
  }
}

/** The next theme in the cycle, for a single button that rotates through them. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

/** What the theme resolves to right now — what the eye actually sees. */
export function resolvedTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return dark ? "dark" : "light";
}
