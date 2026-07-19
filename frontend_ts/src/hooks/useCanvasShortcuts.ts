import { useEffect } from "react";
import { undo, redo, useCanvasStore } from "../state/canvasStore";
import { isEditableTarget } from "../canvas/coordinates";

export type CanvasShortcutAction =
  | "undo"
  | "redo"
  | "save"
  | "group"
  | "ungroup"
  | "copy"
  | "cut"
  | "paste"
  | null;

/**
 * Pure guard/dispatch logic for the canvas keyboard shortcuts (undo/redo,
 * explicit save, U4's group/ungroup, and U5's copy/cut/paste), kept separate
 * from the DOM listener so it can be unit-tested directly. Shares its "is
 * the user typing" guard with `shouldHandleDeleteKey` via `isEditableTarget`
 * (`canvas/coordinates.ts`) so the shortcuts can't drift on what counts as
 * an editable field.
 *
 * Save (Ctrl/Cmd+S) deliberately resolves BEFORE the editable-target guard:
 * the browser's own "save page" dialog must never open while the editor is
 * on screen, even mid-typing in the property panel — and a user pressing
 * Ctrl+S while editing a field means "save my floor plan" either way (the
 * caller's save handler no-ops when there's nothing to save).
 *
 * Group (Ctrl/Cmd+G), Ungroup (Ctrl/Cmd+Shift+G), and U5's Copy/Cut/Paste
 * (Ctrl/Cmd+C/X/V) resolve AFTER the guard like undo/redo — they act on the
 * canvas selection/clipboard, and typing contexts must keep the browser's
 * NATIVE text copy/cut/paste (that's the whole point of the guard here: the
 * canvas clipboard never hijacks text editing). Copy/cut/paste also require
 * Shift to be UP — Ctrl+Shift+C is the browser's own inspect-element
 * shortcut (and Ctrl+Shift+V is paste-without-formatting), neither of which
 * this editor should swallow. The listener's `preventDefault` (fired for
 * every non-null action) is what keeps residual browser behavior (find-next
 * for Ctrl+G, etc.) from firing alongside.
 */
export function resolveCanvasShortcut(
  key: string,
  modKey: boolean,
  shiftKey: boolean,
  activeElementTag: string | undefined,
  isContentEditable: boolean,
): CanvasShortcutAction {
  // Plain Enter saves too (user feedback: after resizing/moving objects,
  // Enter is the natural "keep that" key). Guarded like the canvas-side
  // shortcuts — typing contexts keep their native Enter (form fields
  // commit their own edits; the text overlay owns Enter outright), and a
  // focused BUTTON keeps native activation (Enter must click it, not also
  // fire a save). The listener adds a DOM-level guard for role="button"
  // tiles and dialogs, which tag-level information can't see.
  if (!modKey && !shiftKey && key === "Enter") {
    if (isEditableTarget(activeElementTag, isContentEditable)) return null;
    if (activeElementTag === "BUTTON") return null;
    return "save";
  }

  if (!modKey) return null;

  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "s" && !shiftKey) return "save";

  if (isEditableTarget(activeElementTag, isContentEditable)) return null;
  if (normalizedKey === "z") return shiftKey ? "redo" : "undo";
  if (normalizedKey === "y" && !shiftKey) return "redo";
  if (normalizedKey === "g") return shiftKey ? "ungroup" : "group";
  if (normalizedKey === "c" && !shiftKey) return "copy";
  if (normalizedKey === "x" && !shiftKey) return "cut";
  if (normalizedKey === "v" && !shiftKey) return "paste";
  return null;
}

/**
 * U5: the clipboard shortcut handlers `CanvasEditorPage` wires in — that
 * page owns them (copy reads the selection+items, paste needs the paste
 * point and the floor-plan id), the same delegation as `onSave`. All
 * optional so callers/tests that don't exercise the clipboard can omit
 * them; each handler no-ops appropriately on empty selections/clipboards,
 * so no caller-side gating is needed.
 */
export interface ClipboardShortcutHandlers {
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
}

/**
 * Window-level keydown listener for the editor's shortcuts: Ctrl/Cmd+Z
 * (undo), Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y (redo), Ctrl/Cmd+S (`onSave` —
 * `CanvasEditorPage` passes its explicit-save handler in, same as
 * `Toolbar.tsx` gets undo/redo behavior without owning it), U4's
 * Ctrl/Cmd+G (group) / Ctrl/Cmd+Shift+G (ungroup) — dispatched straight to
 * the store's `groupSelection`/`ungroupSelection`, the same
 * this-hook-owns-the-store-call pattern as undo/redo (both actions no-op
 * appropriately on selections that can't be grouped/ungrouped, so no
 * caller-side gating is needed) — and U5's Ctrl/Cmd+C/X/V (copy/cut/paste),
 * dispatched to the caller's `ClipboardShortcutHandlers`.
 */
export function useCanvasShortcuts(
  onSave?: () => void,
  clipboardHandlers?: ClipboardShortcutHandlers,
): void {
  const { onCopy, onCut, onPaste } = clipboardHandlers ?? {};
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const action = resolveCanvasShortcut(
        event.key,
        event.ctrlKey || event.metaKey,
        event.shiftKey,
        target?.tagName,
        target?.isContentEditable ?? false,
      );

      if (action === null) return;

      // Enter-to-save only: interactive DOM contexts the TAG-level guard
      // in `resolveCanvasShortcut` can't see — role="button" tiles (the
      // sidebar's catalog tiles activate on Enter themselves), open
      // dialogs/menus (Enter belongs to them), and links. A save firing on
      // top of those activations would double-act.
      if (
        event.key === "Enter" &&
        target?.closest('[role="button"], [role="dialog"], [role="menu"], a[href], select') != null
      ) {
        return;
      }

      // Prevent the browser's native behavior — text-field undo/redo for
      // Ctrl+Z/Y, the "save page" dialog for Ctrl+S, find-next/-previous
      // for Ctrl+G/Ctrl+Shift+G, and any native copy/cut/paste side effects
      // for Ctrl+C/X/V (the editable-target guard already returned null for
      // real typing contexts, so native text clipboard behavior is intact
      // where it matters) — from firing alongside the canvas's own handling.
      event.preventDefault();
      if (action === "undo") {
        undo();
      } else if (action === "redo") {
        redo();
      } else if (action === "group") {
        useCanvasStore.getState().groupSelection();
      } else if (action === "ungroup") {
        useCanvasStore.getState().ungroupSelection();
      } else if (action === "copy") {
        onCopy?.();
      } else if (action === "cut") {
        onCut?.();
      } else if (action === "paste") {
        onPaste?.();
      } else {
        onSave?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onSave, onCopy, onCut, onPaste]);
}
