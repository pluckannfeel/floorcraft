import { describe, expect, it } from "vitest";
import { resolveUndoRedoAction } from "./useCanvasShortcuts";

describe("resolveUndoRedoAction", () => {
  it("returns undo for Ctrl+Z", () => {
    expect(resolveUndoRedoAction("z", true, false, undefined, false)).toBe(
      "undo",
    );
  });

  it("returns redo for Ctrl+Shift+Z", () => {
    expect(resolveUndoRedoAction("z", true, true, undefined, false)).toBe(
      "redo",
    );
  });

  it("returns redo for Ctrl+Y", () => {
    expect(resolveUndoRedoAction("y", true, false, undefined, false)).toBe(
      "redo",
    );
  });

  it("is case-insensitive on the key", () => {
    expect(resolveUndoRedoAction("Z", true, false, undefined, false)).toBe(
      "undo",
    );
  });

  it("returns null when no modifier key is held", () => {
    expect(resolveUndoRedoAction("z", false, false, undefined, false)).toBe(
      null,
    );
  });

  it("returns null for Ctrl+Shift+Y (not a recognized combo)", () => {
    expect(resolveUndoRedoAction("y", true, true, undefined, false)).toBe(
      null,
    );
  });

  it("returns null for unrelated keys", () => {
    expect(resolveUndoRedoAction("a", true, false, undefined, false)).toBe(
      null,
    );
  });

  it("ignores the shortcut while focused in an INPUT", () => {
    expect(resolveUndoRedoAction("z", true, false, "INPUT", false)).toBe(
      null,
    );
  });

  it("ignores the shortcut while focused in a TEXTAREA", () => {
    expect(resolveUndoRedoAction("z", true, false, "TEXTAREA", false)).toBe(
      null,
    );
  });

  it("ignores the shortcut while focused in a contentEditable element", () => {
    expect(resolveUndoRedoAction("z", true, false, "DIV", true)).toBe(null);
  });

  it("is case-insensitive on the active element tag", () => {
    expect(resolveUndoRedoAction("z", true, false, "input", false)).toBe(
      null,
    );
  });
});
