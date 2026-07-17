import { useEffect } from "react";
import { undo, redo, useCanvasStore } from "../state/canvasStore";
import { isEditableTarget } from "../canvas/coordinates";

export type CanvasShortcutAction =
  | "undo"
  | "redo"
  | "save"
  | "group"
  | "ungroup"
  | null;

/**
 * Pure guard/dispatch logic for the canvas keyboard shortcuts (undo/redo,
 * explicit save, and U4's group/ungroup), kept separate from the DOM
 * listener so it can be unit-tested directly. Shares its "is the user
 * typing" guard with `shouldHandleDeleteKey` via `isEditableTarget`
 * (`canvas/coordinates.ts`) so the shortcuts can't drift on what counts as
 * an editable field.
 *
 * Save (Ctrl/Cmd+S) deliberately resolves BEFORE the editable-target guard:
 * the browser's own "save page" dialog must never open while the editor is
 * on screen, even mid-typing in the property panel — and a user pressing
 * Ctrl+S while editing a field means "save my floor plan" either way (the
 * caller's save handler no-ops when there's nothing to save).
 *
 * Group (Ctrl/Cmd+G) and Ungroup (Ctrl/Cmd+Shift+G) resolve AFTER the guard
 * like undo/redo — they act on the canvas selection, which typing-focus
 * contexts have no business triggering. The listener's `preventDefault`
 * (fired for every non-null action) is what keeps the browser's own Ctrl+G
 * behavior (find-next / find-previous) from firing alongside.
 */
export function resolveCanvasShortcut(
  key: string,
  modKey: boolean,
  shiftKey: boolean,
  activeElementTag: string | undefined,
  isContentEditable: boolean,
): CanvasShortcutAction {
  if (!modKey) return null;

  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "s" && !shiftKey) return "save";

  if (isEditableTarget(activeElementTag, isContentEditable)) return null;
  if (normalizedKey === "z") return shiftKey ? "redo" : "undo";
  if (normalizedKey === "y" && !shiftKey) return "redo";
  if (normalizedKey === "g") return shiftKey ? "ungroup" : "group";
  return null;
}

/**
 * Window-level keydown listener for the editor's shortcuts: Ctrl/Cmd+Z
 * (undo), Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y (redo), Ctrl/Cmd+S (`onSave` —
 * `CanvasEditorPage` passes its explicit-save handler in, same as
 * `Toolbar.tsx` gets undo/redo behavior without owning it), and U4's
 * Ctrl/Cmd+G (group) / Ctrl/Cmd+Shift+G (ungroup) — dispatched straight to
 * the store's `groupSelection`/`ungroupSelection`, the same
 * this-hook-owns-the-store-call pattern as undo/redo (both actions no-op
 * appropriately on selections that can't be grouped/ungrouped, so no
 * caller-side gating is needed).
 */
export function useCanvasShortcuts(onSave?: () => void): void {
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

      // Prevent the browser's native behavior — text-field undo/redo for
      // Ctrl+Z/Y, the "save page" dialog for Ctrl+S, and find-next/-previous
      // for Ctrl+G/Ctrl+Shift+G — from firing alongside the canvas's own
      // handling.
      event.preventDefault();
      if (action === "undo") {
        undo();
      } else if (action === "redo") {
        redo();
      } else if (action === "group") {
        useCanvasStore.getState().groupSelection();
      } else if (action === "ungroup") {
        useCanvasStore.getState().ungroupSelection();
      } else {
        onSave?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onSave]);
}
