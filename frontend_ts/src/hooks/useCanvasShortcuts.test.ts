import { describe, expect, it } from "vitest";
import { resolveCanvasShortcut } from "./useCanvasShortcuts";

describe("resolveCanvasShortcut", () => {
  it("returns undo for Ctrl+Z", () => {
    expect(resolveCanvasShortcut("z", true, false, undefined, false)).toBe(
      "undo",
    );
  });

  it("returns redo for Ctrl+Shift+Z", () => {
    expect(resolveCanvasShortcut("z", true, true, undefined, false)).toBe(
      "redo",
    );
  });

  it("returns redo for Ctrl+Y", () => {
    expect(resolveCanvasShortcut("y", true, false, undefined, false)).toBe(
      "redo",
    );
  });

  it("is case-insensitive on the key", () => {
    expect(resolveCanvasShortcut("Z", true, false, undefined, false)).toBe(
      "undo",
    );
  });

  it("returns null when no modifier key is held", () => {
    expect(resolveCanvasShortcut("z", false, false, undefined, false)).toBe(
      null,
    );
  });

  it("returns null for Ctrl+Shift+Y (not a recognized combo)", () => {
    expect(resolveCanvasShortcut("y", true, true, undefined, false)).toBe(
      null,
    );
  });

  it("returns null for unrelated keys", () => {
    expect(resolveCanvasShortcut("a", true, false, undefined, false)).toBe(
      null,
    );
  });

  it("ignores the shortcut while focused in an INPUT", () => {
    expect(resolveCanvasShortcut("z", true, false, "INPUT", false)).toBe(
      null,
    );
  });

  it("ignores the shortcut while focused in a TEXTAREA", () => {
    expect(resolveCanvasShortcut("z", true, false, "TEXTAREA", false)).toBe(
      null,
    );
  });

  it("ignores the shortcut while focused in a contentEditable element", () => {
    expect(resolveCanvasShortcut("z", true, false, "DIV", true)).toBe(null);
  });

  it("is case-insensitive on the active element tag", () => {
    expect(resolveCanvasShortcut("z", true, false, "input", false)).toBe(
      null,
    );
  });

  it("returns save for Ctrl+S", () => {
    expect(resolveCanvasShortcut("s", true, false, undefined, false)).toBe(
      "save",
    );
  });

  it("returns save for Ctrl+S even while focused in an INPUT", () => {
    // Deliberate: the browser's "save page" dialog must never open while
    // the editor is on screen, and Ctrl+S mid-typing still means "save my
    // floor plan" (the save handler no-ops when there's nothing to save).
    expect(resolveCanvasShortcut("s", true, false, "INPUT", false)).toBe(
      "save",
    );
  });

  it("returns null for Ctrl+Shift+S (not a recognized combo)", () => {
    expect(resolveCanvasShortcut("s", true, true, undefined, false)).toBe(
      null,
    );
  });

  it("returns null for a bare S without a modifier", () => {
    expect(resolveCanvasShortcut("s", false, false, undefined, false)).toBe(
      null,
    );
  });

  // U4: Ctrl/Cmd+G groups the selection, Ctrl/Cmd+Shift+G ungroups it —
  // both behind the same editable-target guard as undo/redo (they act on
  // the canvas selection; typing contexts must keep the key).
  it("returns group for Ctrl+G", () => {
    expect(resolveCanvasShortcut("g", true, false, undefined, false)).toBe(
      "group",
    );
  });

  it("returns ungroup for Ctrl+Shift+G", () => {
    expect(resolveCanvasShortcut("g", true, true, undefined, false)).toBe(
      "ungroup",
    );
  });

  it("is case-insensitive on the key for group/ungroup (Shift+G reports 'G')", () => {
    expect(resolveCanvasShortcut("G", true, true, undefined, false)).toBe(
      "ungroup",
    );
  });

  it("returns null for a bare G without a modifier", () => {
    expect(resolveCanvasShortcut("g", false, false, undefined, false)).toBe(
      null,
    );
  });

  it("ignores Ctrl+G while focused in an INPUT (editable-target guard)", () => {
    expect(resolveCanvasShortcut("g", true, false, "INPUT", false)).toBe(null);
  });

  it("ignores Ctrl+Shift+G while focused in a contentEditable element", () => {
    expect(resolveCanvasShortcut("g", true, true, "DIV", true)).toBe(null);
  });
});
