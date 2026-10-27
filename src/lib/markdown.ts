/**
 * Markdown is the storage format, the editor works in HTML, so every load and save
 * crosses this boundary. Both directions are configured to produce the same small
 * dialect, otherwise a page would quietly reformat itself each time it was opened.
 */
import { marked } from "marked";
import TurndownService from "turndown";

marked.setOptions({
  gfm: true,
  // Without this, every newline inside a paragraph becomes a <br>, and a round trip
  // then multiplies the blank lines in the file.
  breaks: false,
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

turndown.addRule("strikethrough", {
  filter: ["del", "s"],
  replacement: (content) => (content ? `~~${content}~~` : ""),
});

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}
