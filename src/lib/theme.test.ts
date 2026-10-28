import { describe, expect, it } from "vitest";
import { THEMES, nextTheme, parseTheme, type Theme } from "./theme";

describe("parseTheme", () => {
  it("keeps the three it knows", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
  });

  it("falls back to following the system", () => {
    // Nothing stored yet, a key from an older build, or something typed in by
    // hand. None of these should reach the document as an attribute.
    expect(parseTheme(null)).toBe("system");
    expect(parseTheme("")).toBe("system");
    expect(parseTheme("Dark")).toBe("system");
    expect(parseTheme("auto")).toBe("system");
  });
});

describe("nextTheme", () => {
  it("cycles through every theme and comes back round", () => {
    const seen: Theme[] = [];
    let current: Theme = "light";
    for (let i = 0; i < THEMES.length; i++) {
      seen.push(current);
      current = nextTheme(current);
    }

    expect(new Set(seen).size).toBe(THEMES.length);
    expect(current).toBe("light");
  });
});
