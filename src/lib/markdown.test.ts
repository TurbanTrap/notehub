import { describe, expect, it, vi } from "vitest";

// The real one builds a URL only the Tauri webview can load; the shape is all that
// matters here, and the tests assert the vault-relative path survives regardless.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

const { htmlToMarkdown, markdownToHtml, parentDir } = await import("./markdown");

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

describe("soft line breaks", () => {
  // Shift+Enter. Markdown's own line break is two spaces at the end of a line, and
  // because that is whitespace it was being trimmed off the end of a paragraph,
  // read back as a blank line when it stood alone, and breaking the rest of a list
  // item out of its list. Each of these pins down one of those.

  it("survives at the end of a paragraph, with nothing after it", () => {
    const once = cycle(htmlToMarkdown("<p>Hey<br></p>"));

    expect(once).toContain("<br>");
    expect(markdownToHtml(once)).toContain("<br>");
  });

  it("stays one paragraph when the break is on a line of its own", () => {
    // Two breaks in a row: a blank line the person put there deliberately. It used
    // to come back as two separate paragraphs.
    const markdown = htmlToMarkdown("<p>Hey<br><br>world</p>");
    const html = markdownToHtml(markdown);

    expect(html).toContain("<br>");
    expect(html.match(/<p>/g)).toHaveLength(1);
    expect(cycle(markdown)).toBe(markdown);
  });

  it("keeps the rest of a list item inside its list", () => {
    const markdown = htmlToMarkdown("<ul><li><p>Hey<br>world</p></li></ul>");
    const html = markdownToHtml(markdown);

    expect(html).toContain("<br>");
    expect(html).toContain("world");
    // The giveaway for the old bug: "world" left the list and became a paragraph.
    expect(html).not.toMatch(/<\/ul>[\s\S]*world/);
    expect(cycle(markdown)).toBe(markdown);
  });

  it("holds a blank line inside a list item", () => {
    const markdown = htmlToMarkdown("<ul><li><p>Hey<br><br></p></li></ul>");

    expect(markdown).toContain("<br>");
    expect(cycle(markdown)).toBe(markdown);
  });

  it("survives inside a quote", () => {
    const markdown = htmlToMarkdown("<blockquote><p>Hey<br>world</p></blockquote>");

    expect(markdownToHtml(markdown)).toContain("<br>");
    expect(cycle(markdown)).toBe(markdown);
  });

  it("does not add a break where the person did not put one", () => {
    // A newline inside a paragraph in the file is just wrapping, not a break.
    expect(markdownToHtml("one\ntwo")).not.toContain("<br>");
  });
});

describe("colour, font and highlighter", () => {
  // None of the three has a Markdown syntax, so each is written as inline HTML.
  // What matters is that a page does not change shape every time it is opened, and
  // that nothing but a known colour or font ever reaches a style attribute.

  it("keeps a text colour, as hex, through a round trip", () => {
    const markdown = htmlToMarkdown('<p><span style="color: rgb(214, 69, 61)">warm</span></p>');

    expect(markdown).toBe('<span style="color: #d6453d">warm</span>');
    expect(cycle(markdown)).toBe(markdown);
  });

  it("keeps a font, in the stack the app writes", () => {
    const markdown = htmlToMarkdown('<p><span style="font-family: Georgia, serif">set</span></p>');

    expect(markdown).toContain("font-family: Georgia, 'Times New Roman', serif");
    expect(cycle(markdown)).toBe(markdown);
  });

  it("keeps a highlight, and writes a background a plain viewer can show", () => {
    const markdown = htmlToMarkdown('<p><mark data-color="#fff3a3">lit</mark></p>');

    expect(markdown).toBe('<mark data-color="#fff3a3" style="background-color: #fff3a3">lit</mark>');
    expect(cycle(markdown)).toBe(markdown);
  });

  it("reads a highlight that only carries a background colour", () => {
    // What another editor, or a hand edit, would leave behind.
    expect(htmlToMarkdown('<mark style="background-color:#c3edbd">lit</mark>')).toContain(
      'data-color="#c3edbd"',
    );
  });

  it("drops anything in a style attribute it does not recognise", () => {
    const sneaky =
      '<p><span style="color: #d6453d; background: url(http://example.com/x); position: fixed">x</span></p>';

    expect(htmlToMarkdown(sneaky)).toBe('<span style="color: #d6453d">x</span>');
  });

  it("keeps the text when the style says nothing it knows", () => {
    expect(htmlToMarkdown('<p><span style="position: fixed">plain</span></p>')).toBe("plain");
  });

  it("leaves a wiki link alone", () => {
    // Wiki links are spans too, and they have a rule of their own.
    expect(htmlToMarkdown('<p><span data-wikilink="Ghidra Basics">Ghidra Basics</span></p>')).toBe(
      "[[Ghidra Basics]]",
    );
  });
});

describe("wiki links", () => {
  it("survives a round trip", () => {
    const out = cycle("See [[Ghidra Basics]] for the setup.");

    expect(out).toContain("[[Ghidra Basics]]");
    expect(cycle(out)).toBe(out);
  });

  it("is left alone inside code", () => {
    // An array index in a code sample must not silently become a page link.
    const fenced = cycle("```\nmatrix[[0]] = 1\n```");
    expect(fenced).toContain("matrix[[0]] = 1");
    expect(fenced).not.toContain("data-wikilink");

    const inline = cycle("Use `arr[[i]]` here.");
    expect(inline).toContain("`arr[[i]]`");
  });

  it("trims the whitespace inside the brackets", () => {
    expect(cycle("[[  Ghidra Basics  ]]")).toContain("[[Ghidra Basics]]");
  });

  it("does not join brackets that sit on different lines", () => {
    const html = markdownToHtml("Opening [[\nand closing ]] later.");
    expect(html).not.toContain("data-wikilink");

    const out = cycle("Opening [[\nand closing ]] later.");
    expect(cycle(out)).toBe(out);
  });
});

describe("images", () => {
  const context = { pageDir: "/vault/notebooks/RE/Static" };

  it("keeps the path relative when saved", () => {
    const html = markdownToHtml("![a shot](assets/shot.png)", context);

    // Displayed through a URL the webview can load...
    expect(html).toContain("asset://localhost/");
    // ...but written back exactly as it was.
    expect(htmlToMarkdown(html)).toBe("![a shot](assets/shot.png)");
  });

  it("does not rewrite an external image", () => {
    const markdown = "![logo](https://example.com/logo.png)";
    const html = markdownToHtml(markdown, context);

    expect(html).toContain("https://example.com/logo.png");
    expect(htmlToMarkdown(html)).toBe(markdown);
  });

  it("repeated saves do not accumulate a local path", () => {
    const once = htmlToMarkdown(markdownToHtml("![x](assets/a.png)", context));
    const twice = htmlToMarkdown(markdownToHtml(once, context));

    expect(twice).toBe(once);
    expect(twice).not.toContain("/vault/");
  });

  it("a resized image keeps its width", () => {
    // `![](…)` has nowhere to put a width, so a resized image is written as HTML.
    // The point of the test is that the width survives, and that the path written
    // is still the relative one rather than this machine's asset:// URL.
    const html = '<img src="asset://localhost/x" data-rel="assets/shot.png" alt="a shot" width="320">';
    const markdown = htmlToMarkdown(html);

    expect(markdown).toBe('<img src="assets/shot.png" alt="a shot" width="320">');
    expect(markdown).not.toContain("asset://");
  });

  it("a resized image survives being reopened and saved again", () => {
    const first = '<img src="assets/shot.png" alt="a shot" width="320">';
    const once = htmlToMarkdown(markdownToHtml(first, context));
    const twice = htmlToMarkdown(markdownToHtml(once, context));

    expect(once).toContain('width="320"');
    expect(twice).toBe(once);
    expect(twice).not.toContain("/vault/");
  });

  it("an image that was never resized stays in the plain form", () => {
    // Most of a vault should look like Markdown, not like HTML.
    expect(htmlToMarkdown('<img src="assets/a.png" alt="x">')).toBe("![x](assets/a.png)");
  });

  it("keeps a height as well as a width", () => {
    const html = '<img src="assets/a.png" alt="x" width="320" height="180">';

    expect(htmlToMarkdown(html)).toBe('<img src="assets/a.png" alt="x" width="320" height="180">');
    expect(cycle(htmlToMarkdown(html))).toBe(htmlToMarkdown(html));
  });

  it("keeps the side the text runs down", () => {
    const markdown = htmlToMarkdown('<img src="assets/a.png" alt="x" width="200" align="right">');

    expect(markdown).toContain('align="right"');
    expect(cycle(markdown)).toBe(markdown);
  });

  it("writes a wrapped image as HTML even when it was never resized", () => {
    expect(htmlToMarkdown('<img src="assets/a.png" alt="x" align="left">')).toBe(
      '<img src="assets/a.png" alt="x" align="left">',
    );
  });

  it("ignores a size or a side that is not one we wrote", () => {
    // The attribute can have been typed into the file by hand.
    expect(htmlToMarkdown('<img src="assets/a.png" alt="x" width="wide" align="middle">')).toBe(
      "![x](assets/a.png)",
    );
    expect(htmlToMarkdown('<img src="assets/a.png" alt="x" width="-5">')).toBe(
      "![x](assets/a.png)",
    );
  });
});

describe("parentDir", () => {
  it("handles both platforms' separators", () => {
    expect(parentDir("/vault/section/page.md")).toBe("/vault/section");
    expect(parentDir("C:\\vault\\section\\page.md")).toBe("C:\\vault\\section");
  });
});
