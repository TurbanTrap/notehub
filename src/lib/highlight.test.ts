import { describe, expect, it } from "vitest";
import { LANGUAGES, lowlight } from "./highlight";

interface HastNode {
  type: string;
  properties?: { className?: string[] };
  children?: HastNode[];
  value?: string;
}

/** Every class lowlight put on the highlighted text, in order. */
function scopes(language: string, code: string): string[] {
  const out: string[] = [];
  const walk = (nodes: HastNode[]) => {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      out.push(...(node.properties?.className ?? []));
      walk(node.children ?? []);
    }
  };
  walk(lowlight.highlight(language, code).children as HastNode[]);
  return out;
}

/** The text that ended up inside a given class. */
function textIn(language: string, code: string, className: string): string[] {
  const out: string[] = [];
  const walk = (nodes: HastNode[], inside: boolean) => {
    for (const node of nodes) {
      if (node.type === "text" && inside) out.push(node.value ?? "");
      if (node.type !== "element") continue;
      const here = inside || (node.properties?.className ?? []).includes(className);
      walk(node.children ?? [], here);
    }
  };
  walk(lowlight.highlight(language, code).children as HastNode[], false);
  return out;
}

describe("hexdump", () => {
  const line = "00000000  7f 45 4c 46 02 01 01 00  |.ELF....|";

  it("picks out the offset, the bytes and the ascii column", () => {
    const found = scopes("hexdump", line);

    expect(found).toContain("hljs-meta");
    expect(found).toContain("hljs-number");
    expect(found).toContain("hljs-string");
  });

  it("marks the offset, not the first byte", () => {
    expect(textIn("hexdump", line, "hljs-meta")).toEqual(["00000000"]);
  });

  it("does not read the ascii column as hex", () => {
    // `cafe` and `dead` are letters in the text column, not bytes. The ascii column is
    // matched before the bytes are, which is the only thing stopping this.
    const found = textIn("hexdump", "00001000  ff 00  |cafe dead|", "hljs-number");

    expect(found).toEqual(["ff", "00"]);
  });

  it("handles the grouped form and a 0x offset", () => {
    expect(textIn("hexdump", "0x1000:   4889 e548  83ec 20", "hljs-meta")).toEqual(["0x1000"]);
    expect(textIn("hexdump", "0x1000:   4889 e548  83ec 20", "hljs-number")).toEqual([
      "4889",
      "e548",
      "83ec",
      "20",
    ]);
  });

  it("does not run away on a line with one stray pipe", () => {
    // A begin/end pair would swallow everything after it.
    const found = textIn("hexdump", "00000000  ff | broken\n00000010  ee", "hljs-meta");

    expect(found).toEqual(["00000000", "00000010"]);
  });
});

describe("assembly", () => {
  it("separates mnemonics from registers and addresses", () => {
    const found = scopes("x86asm", "mov rbp, 0x7fff\ncall qword ptr [rax]");

    expect(found).toContain("hljs-keyword"); // mov, call
    expect(found).toContain("hljs-built_in"); // rbp, rax
    expect(found).toContain("hljs-number"); // 0x7fff
  });

  it("knows ARM and MIPS too", () => {
    expect(scopes("armasm", "ldr r0, [r1, #4]")).toContain("hljs-keyword");
    expect(scopes("mipsasm", "lw $t0, 0($sp)")).not.toHaveLength(0);
  });
});

describe("registration", () => {
  it("offers nothing in the menu that cannot be highlighted", () => {
    // A typo here would silently write an unknown language into the fence, and the
    // block would be auto-detected as something else entirely.
    const missing = LANGUAGES.filter((language) => !lowlight.registered(language.id));

    expect(missing.map((language) => language.id)).toEqual([]);
  });

  it("accepts the short names people actually type in a fence", () => {
    for (const alias of ["sh", "asm", "py", "js", "ts", "yml", "hex", "text"]) {
      expect(lowlight.registered(alias), alias).toBe(true);
    }
  });

  it("treats plain output as plain", () => {
    // ```text is common in tool documentation. Left unregistered it would be
    // auto-detected and coloured as if it were code.
    expect(scopes("plaintext", "Analysis complete: 3 findings, 0 errors")).toEqual([]);
  });
});
