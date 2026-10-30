import { describe, expect, it } from "vitest";
import { OUTLINE, SIDEBAR, clampWidth, parseShown, parseWidth } from "./panes";

describe("clampWidth", () => {
  it("leaves a width that is already in range", () => {
    expect(clampWidth(300, SIDEBAR)).toBe(300);
  });

  it("pulls a too-narrow width up to the minimum", () => {
    expect(clampWidth(20, SIDEBAR)).toBe(SIDEBAR.min);
  });

  it("pulls a too-wide width down to the maximum", () => {
    expect(clampWidth(4000, SIDEBAR)).toBe(SIDEBAR.max);
  });

  it("rounds, so the layout never gets a fractional pixel", () => {
    expect(clampWidth(300.6, SIDEBAR)).toBe(301);
  });

  it("uses each pane's own range", () => {
    expect(clampWidth(500, OUTLINE)).toBe(OUTLINE.max);
    expect(clampWidth(500, SIDEBAR)).toBe(500);
  });
});

describe("parseWidth", () => {
  it("reads a stored width back", () => {
    expect(parseWidth("340", SIDEBAR)).toBe(340);
  });

  it("falls back when nothing was stored", () => {
    expect(parseWidth(null, SIDEBAR)).toBe(SIDEBAR.fallback);
  });

  it("falls back on a value that is not a number", () => {
    expect(parseWidth("wide", SIDEBAR)).toBe(SIDEBAR.fallback);
    expect(parseWidth("", SIDEBAR)).toBe(SIDEBAR.fallback);
  });

  // The store is hand-editable and survives upgrades, so a width that would hide the
  // sidebar or swallow the page has to be corrected rather than applied.
  it("clamps a stored width that is out of range", () => {
    expect(parseWidth("5", SIDEBAR)).toBe(SIDEBAR.min);
    expect(parseWidth("9999", SIDEBAR)).toBe(SIDEBAR.max);
    expect(parseWidth("-400", SIDEBAR)).toBe(SIDEBAR.min);
  });
});

describe("parseShown", () => {
  it("is hidden until it has been explicitly turned on", () => {
    expect(parseShown(null)).toBe(false);
    expect(parseShown("")).toBe(false);
    expect(parseShown("yes")).toBe(false);
  });

  it("shows the panel when it was left open", () => {
    expect(parseShown("true")).toBe(true);
  });
});

describe("the ranges themselves", () => {
  it("keep the default between the limits", () => {
    for (const range of [SIDEBAR, OUTLINE]) {
      expect(range.min).toBeLessThan(range.fallback);
      expect(range.fallback).toBeLessThan(range.max);
    }
  });
});
