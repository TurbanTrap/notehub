/**
 * Markdown is the storage format, the editor works in HTML, so every load and save
 * crosses this boundary. Both directions are configured to produce the same small
 * dialect, otherwise a page would quietly reformat itself each time it was opened.
 */
import { marked, type Tokens } from "marked";
import TurndownService from "turndown";
import { convertFileSrc } from "@tauri-apps/api/core";

marked.setOptions({
  gfm: true,
  // Without this, every newline inside a paragraph becomes a <br>, and a round trip
  // then multiplies the blank lines in the file.
  breaks: false,
});

/**
 * `[[Another Page]]` links one note to another.
 *
 * Registered as a marked extension rather than handled with a search and replace over
 * the HTML, so that marked's own tokenizer decides where it applies — which keeps
 * `[[brackets]]` inside a code block or a fence as literal text.
 */
marked.use({
  extensions: [
    {
      name: "wikiLink",
      level: "inline",
      start: (src: string) => src.indexOf("[["),
      tokenizer(src: string) {
        const match = /^\[\[([^\]\n]+)\]\]/.exec(src);
        if (!match) return undefined;
        return {
          type: "wikiLink",
          raw: match[0],
          text: match[1].trim(),
        };
      },
      renderer(token: Tokens.Generic) {
        const target = escapeHtml(String(token.text));
        return `<span data-wikilink="${target}">${target}</span>`;
      },
    },
  ],
});

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  hr: "---",
});

// Markdown has no underline, so it stays as inline HTML, which Markdown permits and
// every renderer passes through.
turndown.addRule("underline", {
  filter: ["u"],
  replacement: (content) => (content ? `<u>${content}</u>` : ""),
});

/**
 * A soft line break — Shift+Enter — written as `<br>`.
 *
 * Markdown's own line break is two spaces at the end of a line, which is whitespace,
 * and that is the whole problem: at the end of a paragraph it is trimmed away, so the
 * break was simply lost; alone on a line it reads back as a blank line, so the
 * paragraph split in two; and inside a list item it broke the rest of the item out of
 * the list. That is why a break only ever held between two pieces of text.
 *
 * `<br>` is inline HTML, which Markdown allows and every renderer passes through. It
 * is not whitespace, so nothing trims it, and it means the same thing everywhere —
 * in a paragraph, in a list item, on a line by itself.
 */
turndown.addRule("hardBreak", {
  filter: "br",
  replacement: () => "<br>\n",
});

turndown.addRule("strikethrough", {
  filter: ["del", "s"],
  replacement: (content) => (content ? `~~${content}~~` : ""),
});

turndown.addRule("wikiLink", {
  filter: (node) => node.nodeName === "SPAN" && node.hasAttribute("data-wikilink"),
  replacement: (_content, node) =>
    `[[${(node as HTMLElement).getAttribute("data-wikilink") ?? ""}]]`,
});

/**
 * Images are displayed through an app-specific URL that only makes sense on this
 * machine, so the original vault-relative path is carried alongside in `data-rel` and
 * written back out. Saving a note must never bake a local absolute path into the file.
 */
turndown.addRule("image", {
  filter: "img",
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const src = el.getAttribute("data-rel") || el.getAttribute("src") || "";
    const alt = el.getAttribute("alt") || "";
    if (!src) return "";

    // `![alt](src)` has nowhere to put a width, so an image that has been resized
    // is written as the HTML that Markdown already allows. One that has not been
    // resized keeps the plain form, which is what most of a vault should look like.
    const width = el.getAttribute("width");
    if (width) {
      return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" width="${escapeAttribute(width)}">`;
    }
    return `![${alt}](${src})`;
  },
});

export interface RenderContext {
  /** Absolute path of the folder holding the page, used to resolve its images. */
  pageDir: string;
}

export function markdownToHtml(markdown: string, context?: RenderContext): string {
  const html = marked.parse(markdown, { async: false }) as string;
  return context ? resolveImageSources(html, context.pageDir) : html;
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

/**
 * Point each relative image at a URL the webview can actually load, keeping the
 * original path in `data-rel` so saving puts it back unchanged.
 */
function resolveImageSources(html: string, pageDir: string): string {
  return html.replace(
    /<img([^>]*?)src="([^"]*)"([^>]*)>/g,
    (whole, before: string, src: string, after: string) => {
      if (!src || isAbsoluteUrl(src)) return whole;
      const absolute = `${stripTrailingSeparator(pageDir)}/${src}`;
      return `<img${before}src="${escapeHtml(convertFileSrc(absolute))}" data-rel="${escapeHtml(src)}"${after}>`;
    },
  );
}

function isAbsoluteUrl(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
}

function stripTrailingSeparator(dir: string): string {
  return dir.replace(/[\\/]+$/, "");
}

/** The folder containing a file, for either platform's separator. */
export function parentDir(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return cut > 0 ? filePath.slice(0, cut) : filePath;
}

/** For a value going inside double quotes in an attribute we are writing ourselves. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
