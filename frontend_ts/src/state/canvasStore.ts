import { create } from 'zustand'
import { temporal } from 'zundo'
import { clampZoom } from '../canvas/coordinates'
import type { CanvasObject, LineType, Point, ShapeType } from '../canvas/types'

/** U11's default zoom step for the Toolbar's zoom in/out buttons (a gentler
 * per-click step than a single wheel "tick" would feel like, since a click
 * is a more deliberate action than a scroll). */
const TOOLBAR_ZOOM_STEP = 1.2

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
 *     `activeTool` field.
 *   - U13 wires these actions to real persistence (optimistic mutations).
 *
 * U9 undo/redo design notes:
 * - `zundo`'s `partialize` returns only `{ items }`, so `undo()`/`redo()`
 *   read/write *only* the `items` key on this store — `selectedItemId` and
 *   `activeTool` are never touched by a history traversal, matching R15's
 *   "property edits are excluded" scope decision and the plan's Key
 *   Technical Decision that undo/redo is partitioned to `items` only.
 * - `equality` gates whether a given `set()` call pushes a new history
 *   entry at all: it compares the `items` array by *reference*. Every
 *   action below that isn't supposed to be undoable (`selectItem`,
 *   `setActiveTool`) only ever `set()`s keys other than `items`, so `items`
 *   keeps the same reference across those calls and no history entry is
 *   created. `setItems`, `createItemLocal`, `updateItemGeometry`, and
 *   `deleteItem` all replace `items` with a new array, so those calls do
 *   produce a history entry. This is simpler and safer than a `partialize`
 *   that strips fields per-item (e.g. dropping `properties`): zundo's
 *   `undo()`/`redo()` write the partialized snapshot straight back into the
 *   store via a shallow merge, so a partialize that reshapes/omits fields
 *   would silently corrupt `items` (losing `properties`) the first time
 *   `undo()` ran. Keeping `items` snapshots whole avoids that trap
 *   entirely.
 * - `updateItemProperties` (U10) is the one action that DOES replace
 *   `items` with a new array reference (it patches `items[i].name`/
 *   `items[i].properties` directly) yet must NOT create a history entry
 *   (R15). Reference-equality alone can't distinguish that case from
 *   `updateItemGeometry`, so this action instead brackets its `set()` call
 *   with zundo's own `temporal.pause()`/`temporal.resume()` — see that
 *   action's doc comment below for the full "why `items[i].properties`
 *   instead of a separate untracked map" reasoning (U9 originally scaffolded
 *   a separate `itemProperties` map for this; U10 found and fixed a
 *   disconnect between that map and what actually renders — removed here).
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
 *   2. `ObjectShape.tsx` reads `object.properties.points` directly off
 *      `items[i]` — `items` is the sole source of truth for
 *      `properties.points` and always has been.
 * `updateLinePoints` therefore patches `items[i].properties.points` (like
 * `updateItemGeometry` patches `items[i].x/y/...`), producing a new `items`
 * array reference and thus a coalesced history entry on each anchor-handle
 * `dragend` — consistent with every other "commit final drag position"
 * action in this store.
 *
 * U10 finding (property panel foundation): U9 originally scaffolded a
 * separate, untracked `itemProperties: Record<id, propertiesJson>` map as
 * this action's target, reasoning that keeping property writes off `items`
 * was *how* they'd stay out of undo history. But by the time U10 was built,
 * nothing read from that map: `ObjectShape.tsx` renders `object.name` and
 * (for Lines) `object.properties.points` straight off `items[i]`, and U17's
 * `updateLinePoints` already established `items[i].properties` as the real
 * source of truth for a Line's structural data. A Property Panel writing
 * to `itemProperties` would have silently edited a piece of state nothing
 * displays or persists — a real bug, not just a scaffold to build on top
 * of. Fixed by deleting the `itemProperties` field/map entirely and having
 * `updateItemProperties` patch `items[i].name`/`items[i].properties`
 * directly, same as every other field on an Object. Untracked-ness (R15)
 * is now achieved via `temporal.pause()`/`temporal.resume()` around the
 * `set()` call instead of via a separate map — zundo's `_handleSet` no-ops
 * entirely while `isTracking` is false (confirmed against zundo 2.3.0's
 * source), so this is a genuine "skip this set from history" primitive,
 * not a workaround.
 */
export interface CanvasState {
  items: CanvasObject[]
  selectedItemId: CanvasObject['id'] | null
  /** Drawing-tool mode for U15/U16's shape/line creation flows. */
  activeTool: ActiveTool
  /** U11: current Stage scale (mirrors Konva's `scaleX`/`scaleY`, kept
   * equal on both axes). View state, not document state — deliberately NOT
   * part of `partialize` below, so zooming/panning never creates undo
   * history (same "only set() items and it's tracked" mechanism the class
   * doc above already relies on for `selectedItemId`/`activeTool`: this
   * store's `equality` only compares `items` by reference, and neither
   * `setZoom`/`setStagePosition`/etc. below ever touch `items`, so no
   * history entry is ever pushed for them). */
  zoom: number
  /** U11: current Stage `x`/`y` (pan offset). Same untracked-by-undo
   * reasoning as `zoom` above. */
  stagePosition: Point

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
   * Patches an item's `name` and/or `properties` JSON (U10's property panel
   * writes) directly on `items[i]` — the same location `ObjectShape.tsx`
   * renders `name`/`properties.points` from, so a saved edit is guaranteed
   * to actually be visible (see the class doc's "U10 finding" for why this
   * matters). `properties`, when provided, REPLACES the item's `properties`
   * object wholesale rather than shallow-merging — this lets the Property
   * Panel's generic key-value editor support deleting a key (the panel
   * builds the full next-`properties` object itself, preserving any
   * Line-structural keys like `points`/`curve_style` it doesn't expose in
   * its generic editor, and omitting whatever the user deleted). `name`,
   * when provided, replaces the item's `name`.
   *
   * Intentionally NOT undoable (R15's confirmed scope decision): even
   * though this produces a new `items` array reference (which would
   * otherwise register as a history-worthy change under the store's
   * reference-equality check), the implementation brackets its `set()` call
   * with `temporal.pause()`/`temporal.resume()` so zundo's history tracking
   * is genuinely suspended for the duration — see the class doc for why
   * this is the correct primitive (not a coincidental side effect).
   * A no-op if `id` doesn't match any item.
   */
  updateItemProperties: (
    id: CanvasObject['id'],
    patch: { name?: string; properties?: Record<string, unknown> },
  ) => void

  /** Sets the active drawing tool (U15/U16 scaffolding). Untracked by undo. */
  setActiveTool: (tool: ActiveTool) => void

  /** U11: sets the Stage's zoom AND position together in one call — the
   * shape `coordinates.ts`'s `computeWheelZoom`/`computePinchZoom` return,
   * since a zoom-to-point/pinch changes both at once (repositioning is what
   * keeps the point under the cursor/fingers fixed). Clamped defensively
   * even though callers already clamp, so a stray direct call can't push
   * `zoom` outside `[MIN_ZOOM, MAX_ZOOM]`. */
  setZoomAndPosition: (zoom: number, position: Point) => void
  /** U11: commits the Stage's final `x`/`y` after a drag-to-pan gesture
   * (`dragend`) — mirrors `updateItemGeometry`'s "commit on release, not
   * every intermediate move" convention. */
  setStagePosition: (position: Point) => void
  /** U11 Toolbar button: zooms in by a fixed step, anchored at the current
   * pan position (no cursor to anchor to for a button click). */
  zoomIn: () => void
  /** U11 Toolbar button: zooms out by the same fixed step as `zoomIn`. */
  zoomOut: () => void
  /** U11 Toolbar button: resets zoom to 1x and pan to the origin. */
  resetZoom: () => void
}

export const useCanvasStore = create<CanvasState>()(
  temporal(
    (set) => ({
      items: [],
      selectedItemId: null,
      activeTool: 'select',
      zoom: 1,
      stagePosition: { x: 0, y: 0 },

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

      updateItemProperties: (id, patch) => {
        // Suspend zundo tracking for exactly this set() call (R15: property
        // edits must not create undo history), then immediately resume so
        // every other action continues to be tracked normally. See the
        // class doc's "U10 finding" for why pause/resume (not a separate
        // untracked map) is the correct primitive here.
        const temporalStore = useCanvasStore.temporal.getState()
        temporalStore.pause()
        set((state) => ({
          items: state.items.map((item) =>
            item.id === id
              ? {
                  ...item,
                  ...(patch.name !== undefined ? { name: patch.name } : {}),
                  ...(patch.properties !== undefined ? { properties: patch.properties } : {}),
                }
              : item,
          ),
        }))
        temporalStore.resume()
      },

      setActiveTool: (tool) => set({ activeTool: tool }),

      setZoomAndPosition: (zoom, position) => set({ zoom: clampZoom(zoom), stagePosition: position }),

      setStagePosition: (position) => set({ stagePosition: position }),

      zoomIn: () =>
        set((state) => ({ zoom: clampZoom(state.zoom * TOOLBAR_ZOOM_STEP) })),

      zoomOut: () =>
        set((state) => ({ zoom: clampZoom(state.zoom / TOOLBAR_ZOOM_STEP) })),

      resetZoom: () => set({ zoom: 1, stagePosition: { x: 0, y: 0 } }),
    }),
    {
      // Only `items` is part of the tracked/restorable snapshot — undo()/
      // redo() never touch selectedItemId or activeTool.
      partialize: (state) => ({ items: state.items }),
      // Reference equality on `items` is sufficient for the actions that
      // rely on it: selectItem/setActiveTool never reassign `items`, so its
      // reference is unchanged across those calls and no entry is created.
      // setItems, createItemLocal, updateItemGeometry, deleteItem, and
      // updateLinePoints always build a new `items` array, so those do
      // produce an entry. `updateItemProperties` ALSO builds a new `items`
      // array (see its doc comment) but is kept out of history via
      // `temporal.pause()`/`resume()` instead of relying on this equality
      // check, since reference equality alone can't distinguish it from
      // updateItemGeometry/updateLinePoints.
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
