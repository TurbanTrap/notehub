import { describe, expect, it } from "vitest";
import { FONTS, canonicalColor, canonicalFont, fontLabel } from "./textStyles";

describe("canonicalColor", () => {
  it("accepts the hex the app writes", () => {
    expect(canonicalColor("#d6453d")).toBe("#d6453d");
    expect(canonicalColor("#D6453D")).toBe("#d6453d");
  });

  it("expands the short form", () => {
    expect(canonicalColor("#abc")).toBe("#aabbcc");
  });

  it("turns what the browser hands back into hex again", () => {
    // A style attribute read back through the DOM comes out as rgb(), so without
    // this every page would be rewritten on the first save after it was opened.
    expect(canonicalColor("rgb(214, 69, 61)")).toBe("#d6453d");
    expect(canonicalColor("rgba(214, 69, 61, 0.9)")).toBe("#d6453d");
  });

  it("refuses anything that is not plainly a colour", () => {
    // A page is a file anyone can edit, and this value ends up inside a style
    // attribute, so only the two forms above get through.
    expect(canonicalColor("red")).toBeNull();
    expect(canonicalColor("#1234")).toBeNull();
    expect(canonicalColor("rgb(300, 0, 0)")).toBeNull();
    expect(canonicalColor("url(http://example.com/x.png)")).toBeNull();
    expect(canonicalColor("#fff; background: url(x)")).toBeNull();
    expect(canonicalColor("")).toBeNull();
    expect(canonicalColor(null)).toBeNull();
  });
});

describe("canonicalFont", () => {
  it("matches a stack back to the one the app writes", () => {
    const georgia = FONTS.find((f) => f.label === "Georgia")!.stack;
    expect(canonicalFont(georgia)).toBe(georgia);
  });

  it("matches after the browser has stripped the quotes", () => {
    // What comes back out of a style attribute has lost its quoting, and saving
    // that as-is would rewrite the file on every open.
    expect(canonicalFont("Times New Roman, Times, serif")).toBe(
      FONTS.find((f) => f.label === "Times New Roman")!.stack,
    );
    expect(canonicalFont('"Trebuchet MS", Tahoma, sans-serif')).toBe(
      FONTS.find((f) => f.label === "Trebuchet MS")!.stack,
    );
  });

  it("drops a font that is not on the list", () => {
    // Not a security hole on its own, but a face that exists on one machine and
    // not the other makes the same note look different on each.
    expect(canonicalFont("Papyrus, fantasy")).toBeNull();
    expect(canonicalFont("sans-serif")).toBeNull();
    expect(canonicalFont("")).toBeNull();
  });
});

describe("fontLabel", () => {
  it("names the font the caret is in, and says nothing for the page font", () => {
    expect(fontLabel("Georgia, 'Times New Roman', serif")).toBe("Georgia");
    expect(fontLabel(null)).toBe("");
    expect(fontLabel("Papyrus")).toBe("");
  });
});
