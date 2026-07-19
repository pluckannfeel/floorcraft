import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { beginCanvasGesture, endCanvasGesture, resetCanvasGestures } from "../canvas/gesture";
import { useCanvasStore } from "../state/canvasStore";
import { resolveCanvasShortcut, useCanvasShortcuts } from "./useCanvasShortcuts";

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

  // U5: Ctrl/Cmd+C/X/V drive the app-level canvas clipboard — behind the
  // same editable-target guard (typing contexts keep the browser's NATIVE
  // text copy/cut/paste), and only without Shift (Ctrl+Shift+C is the
  // browser's inspect-element, Ctrl+Shift+V paste-without-formatting).
  it("returns copy for Ctrl+C", () => {
    expect(resolveCanvasShortcut("c", true, false, undefined, false)).toBe(
      "copy",
    );
  });

  it("returns cut for Ctrl+X", () => {
    expect(resolveCanvasShortcut("x", true, false, undefined, false)).toBe(
      "cut",
    );
  });

  it("returns paste for Ctrl+V", () => {
    expect(resolveCanvasShortcut("v", true, false, undefined, false)).toBe(
      "paste",
    );
  });

  it("is case-insensitive on the clipboard keys", () => {
    expect(resolveCanvasShortcut("C", true, false, undefined, false)).toBe(
      "copy",
    );
  });

  it("returns null for Ctrl+Shift+C/X/V (browser-owned combos stay native)", () => {
    expect(resolveCanvasShortcut("c", true, true, undefined, false)).toBe(null);
    expect(resolveCanvasShortcut("x", true, true, undefined, false)).toBe(null);
    expect(resolveCanvasShortcut("v", true, true, undefined, false)).toBe(null);
  });

  it("returns null for bare c/x/v without a modifier", () => {
    expect(resolveCanvasShortcut("c", false, false, undefined, false)).toBe(null);
    expect(resolveCanvasShortcut("x", false, false, undefined, false)).toBe(null);
    expect(resolveCanvasShortcut("v", false, false, undefined, false)).toBe(null);
  });

  it("ignores Ctrl+C while focused in an INPUT (native text copy preserved)", () => {
    expect(resolveCanvasShortcut("c", true, false, "INPUT", false)).toBe(null);
  });

  it("ignores Ctrl+X while focused in a TEXTAREA (native text cut preserved)", () => {
    expect(resolveCanvasShortcut("x", true, false, "TEXTAREA", false)).toBe(
      null,
    );
  });

  it("ignores Ctrl+V while focused in a contentEditable element (native paste preserved)", () => {
    expect(resolveCanvasShortcut("v", true, false, "DIV", true)).toBe(null);
  });
});

describe("plain Enter saves (object-visuals follow-up)", () => {
  it("Enter with no modifiers, outside typing contexts, resolves to save", () => {
    expect(resolveCanvasShortcut("Enter", false, false, "BODY", false)).toBe("save");
    expect(resolveCanvasShortcut("Enter", false, false, undefined, false)).toBe("save");
    expect(resolveCanvasShortcut("Enter", false, false, "DIV", false)).toBe("save");
  });

  it("Enter in typing contexts keeps its native meaning (fields commit their own edits)", () => {
    expect(resolveCanvasShortcut("Enter", false, false, "INPUT", false)).toBeNull();
    expect(resolveCanvasShortcut("Enter", false, false, "TEXTAREA", false)).toBeNull();
    expect(resolveCanvasShortcut("Enter", false, false, "SELECT", false)).toBeNull();
    expect(resolveCanvasShortcut("Enter", false, false, "DIV", true)).toBeNull();
  });

  it("Enter on a focused BUTTON keeps native activation, and modified Enter stays unclaimed", () => {
    expect(resolveCanvasShortcut("Enter", false, false, "BUTTON", false)).toBeNull();
    expect(resolveCanvasShortcut("Enter", true, false, "BODY", false)).toBeNull();
    expect(resolveCanvasShortcut("Enter", false, true, "BODY", false)).toBeNull();
  });
});

describe("Enter finalizes: deselect + pan + save (listener behavior)", () => {
  it("Enter clears the selection, drops select to pan, and fires the save", () => {
    useCanvasStore.setState({ selectedItemIds: [1], activeTool: "select" });
    const onSave = vi.fn();
    const { unmount } = renderHook(() => useCanvasShortcuts(onSave));

    // Dispatch from body (bubbling to the window listener) — real keydowns
    // with nothing focused target document.body, never the window object.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(useCanvasStore.getState().selectedItemIds).toEqual([]);
    expect(useCanvasStore.getState().activeTool).toBe("pan");
    expect(onSave).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("Ctrl+S saves WITHOUT touching the selection (pure save, works mid-edit)", () => {
    useCanvasStore.setState({ selectedItemIds: [1], activeTool: "select" });
    const onSave = vi.fn();
    const { unmount } = renderHook(() => useCanvasShortcuts(onSave));

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }),
    );

    expect(useCanvasStore.getState().selectedItemIds).toEqual([1]);
    expect(useCanvasStore.getState().activeTool).toBe("select");
    expect(onSave).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("Enter never finalizes mid-gesture (final review fix)", () => {
  afterEach(() => resetCanvasGestures());

  it("no-ops while a canvas gesture is in flight; works again once it ends", () => {
    useCanvasStore.setState({ selectedItemIds: [1], activeTool: "select" });
    const onSave = vi.fn();
    const { unmount } = renderHook(() => useCanvasShortcuts(onSave));

    beginCanvasGesture();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // Mid-gesture: nothing moved — selection intact, tool intact, no save.
    expect(useCanvasStore.getState().selectedItemIds).toEqual([1]);
    expect(useCanvasStore.getState().activeTool).toBe("select");
    expect(onSave).not.toHaveBeenCalled();

    endCanvasGesture();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(useCanvasStore.getState().selectedItemIds).toEqual([]);
    expect(useCanvasStore.getState().activeTool).toBe("pan");
    expect(onSave).toHaveBeenCalledTimes(1);
    unmount();
  });
});
