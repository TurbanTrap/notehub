/**
 * Syntax highlighting for code blocks.
 *
 * Only the languages worth having are registered, rather than all two hundred
 * highlight.js ships: the app is downloaded once and never updated over the network,
 * but the bundle still has to be parsed at every launch.
 *
 * The set is chosen for reverse-engineering notes — disassembly for three
 * architectures and hex dumps — plus the languages a tool's output actually arrives
 * in.
 */
import { createLowlight } from "lowlight";
import type { Language } from "highlight.js";

import armasm from "highlight.js/lib/languages/armasm";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import mipsasm from "highlight.js/lib/languages/mipsasm";
// Registered on purpose: an unregistered language falls back to auto-detection, which
// happily colours a plain block of output as if it were code.
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import toml from "highlight.js/lib/languages/ini";
import typescript from "highlight.js/lib/languages/typescript";
import x86asm from "highlight.js/lib/languages/x86asm";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * A hex dump is not a programming language, so highlight.js has no definition for one.
 * It is also most of what gets pasted into a note about a binary, and left plain it is
 * a wall of identical characters with nothing for the eye to catch.
 *
 * This covers the shapes `hexdump -C`, `xxd` and most debuggers produce:
 *
 *     00000000  7f 45 4c 46  02 01 01 00  |.ELF....|
 *     0x1000:   4889 e548    83ec 20
 *
 * The offset column and the ASCII column are picked out; the bytes themselves are left
 * as numbers. The ASCII column is matched before the bytes are, so letters inside it
 * are never mistaken for hex.
 */
function hexdump(): Language {
  return {
    name: "hexdump",
    case_insensitive: true,
    contains: [
      { scope: "meta", begin: /^[ \t]*(0x)?[0-9a-f]{4,16}(?=[:\s])/, relevance: 0 },
      // One regex rather than a begin/end pair: a line with a single stray pipe would
      // otherwise swallow the rest of the dump.
      { scope: "string", begin: /\|[^|\n]*\|/, relevance: 0 },
      // Two to eight digits, so grouped forms like `4889 e548` are covered too.
      { scope: "number", begin: /\b[0-9a-f]{2,8}\b/, relevance: 0 },
    ],
  };
}

export const lowlight = createLowlight();

lowlight.register({
  armasm,
  bash,
  c,
  cpp,
  csharp,
  diff,
  go,
  hexdump,
  java,
  javascript,
  json,
  mipsasm,
  plaintext,
  powershell,
  python,
  rust,
  sql,
  toml,
  typescript,
  x86asm,
  xml,
  yaml,
});

// What people actually type in a fence. Without these, ```sh and ```asm come out
// unhighlighted even though the language is registered under another name.
lowlight.registerAlias({
  bash: ["sh", "shell", "zsh", "console"],
  c: ["h"],
  cpp: ["c++", "cc", "hpp"],
  csharp: ["cs"],
  hexdump: ["hex", "xxd"],
  javascript: ["js"],
  plaintext: ["text", "txt", "log", "output"],
  python: ["py"],
  rust: ["rs"],
  toml: ["ini", "cfg", "conf"],
  typescript: ["ts"],
  x86asm: ["asm", "assembly", "nasm", "disasm"],
  xml: ["html", "svg"],
  yaml: ["yml"],
});

/** Offered in the code block's language menu, in the order shown. */
export const LANGUAGES: { id: string; label: string }[] = [
  { id: "plaintext", label: "Plain text" },
  { id: "x86asm", label: "x86 assembly" },
  { id: "armasm", label: "ARM assembly" },
  { id: "mipsasm", label: "MIPS assembly" },
  { id: "hexdump", label: "Hex dump" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
  { id: "java", label: "Java" },
  { id: "csharp", label: "C#" },
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "bash", label: "Shell" },
  { id: "powershell", label: "PowerShell" },
  { id: "sql", label: "SQL" },
  { id: "json", label: "JSON" },
  { id: "yaml", label: "YAML" },
  { id: "xml", label: "XML / HTML" },
  { id: "diff", label: "Diff" },
];
