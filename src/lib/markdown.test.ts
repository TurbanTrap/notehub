import { describe, expect, it } from "vitest";
import { htmlToMarkdown, markdownToHtml } from "./markdown";

/** One open-and-save cycle in the app: file -> editor -> file. */
const cycle = (markdown: string) => htmlToMarkdown(markdownToHtml(markdown));

describe("markdown round trip", () => {
  it("leaves a page alone after the first save", () => {
    // The property that matters: opening and saving a page repeatedly must not keep
    // changing the file. Otherwise every sync sees a fresh edit and the note drifts.
    const source = [
      "Intro paragraph with **bold**, *italic* and `inline code`.",
      "",
      "## A section",
      "",
      "### A subsection",
      "",
      "- first",
      "- second",
      "  - nested",
      "",
      "1. one",
      "2. two",
      "",
      "> a quote",
      "",
      "---",
      "",
      "Closing line.",
    ].join("\n");

    const once = cycle(source);
    const twice = cycle(once);

    expect(twice).toBe(once);
  });

  it("keeps a code block byte for byte", () => {
    // Disassembly is the main thing going into these notes, so the alignment inside a
    // fence has to survive untouched.
    const asm = ["push    rbp", "mov     rbp, rsp", "sub     rsp, 0x20"].join("\n");
    const source = `Before\n\n\`\`\`\n${asm}\n\`\`\`\n\nAfter`;

    const out = cycle(source);

    expect(out).toContain(asm);
    expect(cycle(out)).toBe(out);
  });

  it("keeps a code block's language", () => {
    const source = "```python\nprint('hi')\n```";
    expect(cycle(source)).toContain("```python");
  });

  it("keeps headings, links and emphasis", () => {
    const out = cycle("# Title\n\nSee [the docs](https://example.com) for **why**.");

    expect(out).toContain("# Title");
    expect(out).toContain("[the docs](https://example.com)");
    expect(out).toContain("**why**");
  });

  it("keeps strikethrough and underline, which have no plain Markdown form", () => {
    const out = cycle("~~gone~~ and <u>underlined</u>");

    expect(out).toContain("~~gone~~");
    expect(out).toContain("<u>underlined</u>");
  });

  it("does not multiply blank lines on each cycle", () => {
    const source = "Line one\nLine two\n\nNew paragraph";
    const once = cycle(source);

    expect(cycle(once)).toBe(once);
    expect(once).not.toContain("\n\n\n");
  });

  it("handles an empty page", () => {
    expect(cycle("")).toBe("");
  });
});
