import { useEffect } from "react";
import { undo, redo } from "../state/canvasStore";
import { isEditableTarget } from "../canvas/coordinates";

export type CanvasShortcutAction = "undo" | "redo" | "save" | null;

/**
 * Pure guard/dispatch logic for the canvas keyboard shortcuts (undo/redo +
 * explicit save), kept separate from the DOM listener so it can be
 * unit-tested directly. Shares its "is the user typing" guard with
 * `shouldHandleDeleteKey` via `isEditableTarget` (`canvas/coordinates.ts`)
 * so the shortcuts can't drift on what counts as an editable field.
 *
 * Save (Ctrl/Cmd+S) deliberately resolves BEFORE the editable-target guard:
 * the browser's own "save page" dialog must never open while the editor is
 * on screen, even mid-typing in the property panel — and a user pressing
 * Ctrl+S while editing a field means "save my floor plan" either way (the
 * caller's save handler no-ops when there's nothing to save).
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
  return null;
}

/**
 * Window-level keydown listener for the editor's shortcuts: Ctrl/Cmd+Z
 * (undo), Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y (redo), and Ctrl/Cmd+S (`onSave` —
 * `CanvasEditorPage` passes its explicit-save handler in, same as
 * `Toolbar.tsx` gets undo/redo behavior without owning it).
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
      // Ctrl+Z/Y, and the "save page" dialog for Ctrl+S — from firing
      // alongside the canvas's own handling.
      event.preventDefault();
      if (action === "undo") {
        undo();
      } else if (action === "redo") {
        redo();
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
