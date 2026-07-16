import { useEffect } from "react";
import { undo, redo } from "../state/canvasStore";
import { isEditableTarget } from "../canvas/coordinates";

export type UndoRedoAction = "undo" | "redo" | null;

/**
 * Pure guard/dispatch logic for the undo/redo keyboard shortcuts, kept
 * separate from the DOM listener so it can be unit-tested directly.
 * Shares its "is the user typing" guard with `shouldHandleDeleteKey` via
 * `isEditableTarget` (`canvas/coordinates.ts`) so the two shortcuts can't
 * drift on what counts as an editable field.
 */
export function resolveUndoRedoAction(
  key: string,
  modKey: boolean,
  shiftKey: boolean,
  activeElementTag: string | undefined,
  isContentEditable: boolean,
): UndoRedoAction {
  if (!modKey) return null;
  if (isEditableTarget(activeElementTag, isContentEditable)) return null;

  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "z") return shiftKey ? "redo" : "undo";
  if (normalizedKey === "y" && !shiftKey) return "redo";
  return null;
}

export function useCanvasShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const action = resolveUndoRedoAction(
        event.key,
        event.ctrlKey || event.metaKey,
        event.shiftKey,
        target?.tagName,
        target?.isContentEditable ?? false,
      );

      if (action === null) return;

      // Prevent the browser's native undo/redo (e.g. text-field undo) from
      // firing alongside the canvas's own undo/redo.
      event.preventDefault();
      if (action === "undo") {
        undo();
      } else {
        redo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}
