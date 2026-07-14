import { create } from 'zustand'
import type { CanvasObject } from '../canvas/types'

/**
 * Zustand store backing the canvas editor.
 *
 * Per the plan (U7): this is INTENTIONALLY the minimal shape needed for
 * sidebar-drag-to-create to work — `items` + `selectedItemId` plus the few
 * actions this unit's creation flow needs. Later units extend this same
 * store rather than replacing it:
 *   - U8 adds resize/rotate/delete-related actions.
 *   - U9 wraps it with `zundo` temporal middleware for undo/redo and adds
 *     `activeTool`/z-order fields.
 *   - U13 wires these actions to real persistence (optimistic mutations).
 */
export interface CanvasState {
  items: CanvasObject[]
  selectedItemId: CanvasObject['id'] | null

  /** Replaces the full items list (e.g. after the initial fetch resolves). */
  setItems: (items: CanvasObject[]) => void

  /**
   * Appends a locally-created item (sidebar drop) to the store, ahead of
   * real persistence (U13). Used for optimistic/local-only creation in U7.
   */
  createItemLocal: (item: CanvasObject) => void

  /** Selects an item, or clears selection when passed `null`. */
  selectItem: (id: CanvasObject['id'] | null) => void

  /**
   * Patches an item's geometry (x/y/width/height/rotation) — the single
   * mutation point for U8's drag-reposition (`dragend`) and
   * resize/rotate (`transformend`) commits. Deliberately narrow (geometry
   * only, not `properties`/`name`) so U9 can wrap it as one clean,
   * coalesced undo/redo history entry without also snapshotting unrelated
   * fields property edits (U10) would touch.
   */
  updateItemGeometry: (
    id: CanvasObject['id'],
    patch: Partial<Pick<CanvasObject, 'x' | 'y' | 'width' | 'height' | 'rotation'>>,
  ) => void

  /** Removes an item and clears selection if it was the selected item. */
  deleteItem: (id: CanvasObject['id']) => void
}

export const useCanvasStore = create<CanvasState>((set) => ({
  items: [],
  selectedItemId: null,

  setItems: (items) => set({ items }),

  createItemLocal: (item) =>
    set((state) => ({
      items: [...state.items, item],
    })),

  selectItem: (id) => set({ selectedItemId: id }),

  updateItemGeometry: (id, patch) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),

  deleteItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
      selectedItemId: state.selectedItemId === id ? null : state.selectedItemId,
    })),
}))
