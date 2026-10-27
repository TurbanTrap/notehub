/**
 * Search snippets arrive from the index with matched words wrapped in two control
 * characters rather than HTML tags, so that note content is never treated as markup.
 * This turns that into a list of runs the interface can render as elements.
 */
export const MATCH_OPEN = "\u0001";
export const MATCH_CLOSE = "\u0002";

export interface Run {
  text: string;
  match: boolean;
}

export function splitSnippet(text: string): Run[] {
  const runs: Run[] = [];
  let rest = text;

  while (rest.length > 0) {
    const start = rest.indexOf(MATCH_OPEN);
    if (start === -1) {
      push(runs, rest, false);
      break;
    }

    const end = rest.indexOf(MATCH_CLOSE, start + 1);
    if (end === -1) {
      // A marker without its partner; show the text rather than losing the snippet.
      push(runs, stripMarkers(rest), false);
      break;
    }

    if (start > 0) push(runs, rest.slice(0, start), false);
    push(runs, stripMarkers(rest.slice(start + 1, end)), true);
    rest = rest.slice(end + 1);
  }

  return runs;
}

function push(runs: Run[], text: string, match: boolean) {
  if (text.length > 0) runs.push({ text, match });
}

function stripMarkers(text: string): string {
  return text.split(MATCH_OPEN).join("").split(MATCH_CLOSE).join("");
}
