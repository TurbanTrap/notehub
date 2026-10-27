import { describe, expect, it } from "vitest";
import { MATCH_CLOSE, MATCH_OPEN, splitSnippet } from "./snippet";

const mark = (text: string) => `${MATCH_OPEN}${text}${MATCH_CLOSE}`;

describe("splitSnippet", () => {
  it("separates the matched words from the rest", () => {
    const runs = splitSnippet(`calls ${mark("ptrace")} with a flag`);

    expect(runs).toEqual([
      { text: "calls ", match: false },
      { text: "ptrace", match: true },
      { text: " with a flag", match: false },
    ]);
  });

  it("handles several matches", () => {
    const runs = splitSnippet(`${mark("a")} and ${mark("b")}`);
    expect(runs.filter((r) => r.match).map((r) => r.text)).toEqual(["a", "b"]);
  });

  it("leaves plain text as one run", () => {
    expect(splitSnippet("nothing matched here")).toEqual([
      { text: "nothing matched here", match: false },
    ]);
  });

  it("keeps note content as text, never markup", () => {
    // The whole reason the index does not emit HTML.
    const runs = splitSnippet(`before ${mark("<script>alert(1)</script>")} after`);

    expect(runs[1]).toEqual({ text: "<script>alert(1)</script>", match: true });
  });

  it("recovers from a marker with no partner", () => {
    const runs = splitSnippet(`broken ${MATCH_OPEN}tail`);

    expect(runs).toEqual([{ text: "broken tail", match: false }]);
    expect(runs.some((r) => r.text.includes(MATCH_OPEN))).toBe(false);
  });

  it("returns nothing for an empty snippet", () => {
    expect(splitSnippet("")).toEqual([]);
  });
});
