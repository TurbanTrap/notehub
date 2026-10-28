import { describe, expect, it } from "vitest";
// The stylesheet as text, so the rules below can be read rather than rendered.
// Read from disk rather than imported: the test runner stubs out CSS imports, so
// even `?raw` comes back empty.
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * The editor builds parts of its own display out of real HTML elements — an empty
 * <img> beside a line break that ends a line, a <br> at the end of a block. They are
 * scaffolding, and styling them as though they were content puts marks on the page
 * that are in no document and in no file.
 *
 * This cost two rounds to find: a line break at the end of a line drew a small pale
 * circle and read as a bullet point, because the page's own image styling — a border,
 * rounded corners, and a light plate in the dark theme — landed on that <img>.
 */
const css: string = readFileSync(new URL("../App.css", import.meta.url), "utf8");

describe("the editor's own scaffolding", () => {
  it("styles the line-break separator out of sight", () => {
    const rule = /\.prose img\.ProseMirror-separator\s*\{([^}]*)\}/.exec(css);

    expect(rule, "no rule neutralising img.ProseMirror-separator").not.toBeNull();

    const body = rule![1];
    // Each of these is something `.prose img` or the dark theme would otherwise give
    // it, and each one on its own is enough to draw a visible dot.
    for (const property of ["border", "border-radius", "padding", "background"]) {
      expect(body, `${property} is not reset`).toMatch(new RegExp(`${property}\\s*:`));
    }
    // The dark theme's plate is the more specific rule, so this has to outrank it.
    expect(body).toContain("!important");
  });

  it("still styles the images that are actually in a page", () => {
    // The fix must not have been to stop styling images at all.
    expect(css).toMatch(/\.prose img\s*\{/);
  });
});
