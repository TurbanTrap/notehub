import { describe, expect, it } from "vitest";
import { detectOs, fileManager, modLabel } from "./platform";

// Real strings: the Tauri webview reports the system browser's agent, which is
// WKWebView on macOS and WebView2 (Edge) on Windows.
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("detectOs", () => {
  it("tells the two shipping platforms apart", () => {
    expect(detectOs(MAC)).toBe("mac");
    expect(detectOs(WINDOWS)).toBe("windows");
  });

  it("does not guess on anything else", () => {
    expect(detectOs(LINUX)).toBe("other");
    expect(detectOs("")).toBe("other");
  });
});

describe("labels", () => {
  it("names the modifier the way each platform writes it", () => {
    expect(modLabel("mac")).toBe("⌘");
    expect(modLabel("windows")).toBe("Ctrl+");
  });

  it("names the file manager, and stays vague where it cannot know", () => {
    expect(fileManager("mac")).toBe("Finder");
    expect(fileManager("windows")).toBe("File Explorer");
    expect(fileManager("other")).toBe("your file manager");
  });
});
