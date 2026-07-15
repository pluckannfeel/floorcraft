import { create } from 'zustand'
import { temporal } from 'zundo'
import type { CanvasObject, LineType, Point, ShapeType } from '../canvas/types'

/**
 * Drawing-tool mode for the (not-yet-built, U15/U16) shape/line creation
 * flows. `'select'` is the default/idle mode matching today's drag-select
 * interaction; the rest mirror `ShapeType`/`LineType` from `canvas/types.ts`.
 * Untracked by undo (see `partialize` below) — switching tools isn't a
 * content change.
 */
export type ActiveTool = 'select' | ShapeType | LineType

/**
 * Zustand store backing the canvas editor.
 *
 * Per the plan (U7): this is INTENTIONALLY the minimal shape needed for
 * sidebar-drag-to-create to work — `items` + `selectedItemId` plus the few
 * actions this unit's creation flow needs. Later units extend this same
 * store rather than replacing it:
 *   - U8 adds resize/rotate/delete-related actions.
 *   - U9 wraps it with `zundo` temporal middleware for undo/redo and adds
 *     `activeTool`/`itemProperties` fields.
 *   - U13 wires these actions to real persistence (optimistic mutations).
 *
 * U9 undo/redo design notes:
 * - `zundo`'s `partialize` returns only `{ items }`, so `undo()`/`redo()`
 *   read/write *only* the `items` key on this store — `selectedItemId`,
 *   `itemProperties`, and `activeTool` are never touched by a history
 *   traversal, matching R15's "property edits are excluded" scope decision
 *   and the plan's Key Technical Decision that undo/redo is partitioned to
 *   `items` only.
 * - `equality` gates whether a given `set()` call pushes a new history
 *   entry at all: it compares the `items` array by *reference*. Every
 *   action below that isn't supposed to be undoable (`selectItem`,
 *   `setActiveTool`, `updateItemProperties`) only ever `set()`s keys other
 *   than `items`, so `items` keeps the same reference across those calls
 *   and no history entry is created. `setItems`, `createItemLocal`,
 *   `updateItemGeometry`, and `deleteItem` all replace `items` with a new
 *   array, so those calls do produce a history entry. This is simpler and
 *   safer than a `partialize` that strips fields per-item (e.g. dropping
 *   `properties`): zundo's `undo()`/`redo()` write the partialized
 *   snapshot straight back into the store via a shallow merge, so a
 *   partialize that reshapes/omits fields would silently corrupt `items`
 *   (losing `properties`) the first time `undo()` ran. Keeping `items`
 *   snapshots whole avoids that trap entirely.
 * - Property edits live in the separate untracked `itemProperties` map
 *   rather than mutating `items[i].properties` in place — this is what
 *   actually keeps property edits out of undo history (not the
 *   `partialize`/`equality` config alone), since `items` never changes
 *   reference when only `itemProperties` is written.
 * - Undo-of-delete: because `partialize`/`undo` restore the exact prior
 *   `items` snapshot verbatim, undoing a delete brings the item back with
 *   its *original* id at this (purely in-memory) store layer — zundo has
 *   no notion of "recreate", only "restore prior state". The plan's
 *   "recreate via new id" language describes U13's concern once real
 *   persistence exists: a DELETE that already succeeded against the
 *   backend means the old row is genuinely gone, so U13's re-issued
 *   persistence call for an undone delete will need to `POST` a new row
 *   and swap the id U13 then plugs into this store. That id-swap has no
 *   work to do yet here, since this unit has no persistence calls to
 *   re-issue.
 *
 * U17 decision: is a Line-point drag (`updateLinePoints`, below) undo-
 * tracked like `updateItemGeometry`, or untracked like `updateItemProperties`?
 * The plan's prose is genuinely ambiguous — U17's Key Technical Decisions
 * describe `properties.points` as living in "properties JSON" (which reads
 * like the untracked slice), but U9's own "Approach" section explicitly
 * lists "line-anchor-drag-end" alongside dragend/transformend/create/delete
 * as one of the history-coalescing commit points, i.e. as a geometry-class
 * action. Two things settle it in favor of undo-tracked:
 *   1. R15 defines the undoable set as "create, move, resize, rotate,
 *      delete" — a Line's points ARE its shape, so repositioning one is a
 *      "move" of that Line's geometry, not a cosmetic/property change like
 *      color or name.
 *   2. This codebase's `itemProperties` map is genuinely disconnected from
 *      rendering: `ObjectShape.tsx` reads `object.properties.points`
 *      directly off `items[i]`, never from `itemProperties`. Routing point
 *      edits through `updateItemProperties` (the untracked map) would not
 *      even be visible on next render without also duplicating the write
 *      into `items` — so `items` is already the de facto source of truth
 *      for `properties.points`, undo-tracked slice or not.
 * `updateLinePoints` therefore patches `items[i].properties.points` (like
 * `updateItemGeometry` patches `items[i].x/y/...`), producing a new `items`
 * array reference and thus a coalesced history entry on each anchor-handle
 * `dragend` — consistent with every other "commit final drag position"
 * action in this store.
 */
export interface CanvasState {
  items: CanvasObject[]
  /**
   * Per-item `properties` JSON (U10's property panel target), keyed by
   * `CanvasObject['id']` (as a string). Deliberately NOT stored on
   * `items[i].properties` — see the class doc above for why keeping it
   * separate is what keeps property edits out of undo history and safe
   * from being clobbered by an `undo()`/`redo()` snapshot restore.
   */
  itemProperties: Record<string, Record<string, unknown>>
  selectedItemId: CanvasObject['id'] | null
  /** Drawing-tool mode for U15/U16's shape/line creation flows. */
  activeTool: ActiveTool

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

  /**
   * Patches a single point (by index) in a Line-typed item's
   * `properties.points` array — the mutation point for U17's anchor-handle
   * drag commits (`dragend`). Deliberately mirrors `updateItemGeometry`
   * (replaces `items` with a new array reference, so it participates in
   * undo history) rather than `updateItemProperties` — see the class doc
   * above ("U17 decision") for the full reasoning. Only the point at
   * `pointIndex` changes; every other point, and every other field on the
   * item, is left untouched. A no-op if `id` doesn't match any item or
   * `pointIndex` is out of range for that item's current points array.
   */
  updateLinePoints: (id: CanvasObject['id'], pointIndex: number, point: Point) => void

  /**
   * Patches an item's `properties` JSON (U10's property panel writes).
   * Intentionally NOT undoable (R15's confirmed scope decision) — see the
   * class doc for how this stays out of undo history.
   */
  updateItemProperties: (id: CanvasObject['id'], patch: Record<string, unknown>) => void

  /** Sets the active drawing tool (U15/U16 scaffolding). Untracked by undo. */
  setActiveTool: (tool: ActiveTool) => void
}

export const useCanvasStore = create<CanvasState>()(
  temporal(
    (set) => ({
      items: [],
      itemProperties: {},
      selectedItemId: null,
      activeTool: 'select',

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

      updateLinePoints: (id, pointIndex, point) =>
        set((state) => {
          const item = state.items.find((candidate) => candidate.id === id)
          const rawPoints = item?.properties.points
          if (!item || !Array.isArray(rawPoints) || pointIndex < 0 || pointIndex >= rawPoints.length) {
            return {}
          }
          const nextPoints = rawPoints.map((existing, index) => (index === pointIndex ? point : existing))
          return {
            items: state.items.map((candidate) =>
              candidate.id === id
                ? { ...candidate, properties: { ...candidate.properties, points: nextPoints } }
                : candidate,
            ),
          }
        }),

      updateItemProperties: (id, patch) =>
        set((state) => {
          const key = String(id)
          return {
            itemProperties: {
              ...state.itemProperties,
              [key]: { ...state.itemProperties[key], ...patch },
            },
          }
        }),

      setActiveTool: (tool) => set({ activeTool: tool }),
    }),
    {
      // Only `items` is part of the tracked/restorable snapshot — undo()/
      // redo() never touch selectedItemId, itemProperties, or activeTool.
      partialize: (state) => ({ items: state.items }),
      // Reference equality on `items` is sufficient: every action that
      // shouldn't create a history entry (selectItem, setActiveTool,
      // updateItemProperties) never reassigns `items`, so its reference is
      // unchanged across those calls. Every action that should create an
      // entry (setItems, createItemLocal, updateItemGeometry, deleteItem)
      // always builds a new `items` array.
      equality: (past, current) => past.items === current.items,
    },
  ),
)

/**
 * Undo/redo entry points. Thin wrappers around zundo's temporal store
 * (`useCanvasStore.temporal.getState()`) rather than every call site (e.g.
 * `Toolbar.tsx`) reaching into `.temporal` directly — this indirection is
 * U9's extension point for U13, which will wrap these with "re-issue the
 * original mutation's persistence call" behavior once the mutation-function
 * infrastructure exists, without needing to touch call sites again.
 */
export function undo(): void {
  useCanvasStore.temporal.getState().undo()
}

export function redo(): void {
  useCanvasStore.temporal.getState().redo()
}
