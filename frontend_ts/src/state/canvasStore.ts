import { create } from 'zustand'
import { temporal } from 'zundo'
import { clampZoom } from '../canvas/coordinates'
import type { CanvasObject, LineType, Point, ShapeType } from '../canvas/types'

/** U11's default zoom step for the Toolbar's zoom in/out buttons (a gentler
 * per-click step than a single wheel "tick" would feel like, since a click
 * is a more deliberate action than a scroll). */
const TOOLBAR_ZOOM_STEP = 1.2

/**
 * Drawing-tool mode for the shape/line creation flows (U15/U16). `'select'`
 * is the default/idle mode matching the drag-select interaction; the rest
 * mirror `ShapeType`/`LineType` from `canvas/types.ts`. Untracked by undo
 * (see `partialize` below) — switching tools isn't a content change.
 */
export type ActiveTool = 'select' | ShapeType | LineType

/**
 * Zustand store backing the canvas editor.
 *
 * Persistence model (explicit save): every content action below mutates
 * ONLY this store — nothing here (or in the handlers calling in) talks to
 * the backend per action. The canvas diverges locally from the last
 * server-confirmed state, tracked by the `dirty` flag, until the user
 * explicitly saves (Save button / Ctrl+S -> `useSaveObjects` in
 * `hooks/useObjects.ts`), which PUTs the full `items` list and re-baselines
 * the store from the server's canonical response via `setItems`.
 *
 * Undo/redo design notes (U9):
 * - `zundo`'s `partialize` returns only `{ items }`, so `undo()`/`redo()`
 *   read/write *only* the `items` key on this store — `selectedItemId`,
 *   `activeTool`, zoom/pan, and `dirty` are never touched by a history
 *   traversal, matching R15's "property edits are excluded" scope decision
 *   and the plan's Key Technical Decision that undo/redo is partitioned to
 *   `items` only. (`dirty` in particular must stay out: a traversal must
 *   never restore a stale saved/unsaved flag — `undo()`/`redo()` below mark
 *   the store dirty themselves whenever a traversal actually changes the
 *   canvas.)
 * - `equality` gates whether a given `set()` call pushes a new history
 *   entry at all: it compares the `items` array by *reference*. Every
 *   action below that isn't supposed to be undoable (`selectItem`,
 *   `setActiveTool`, `markSaved`, the zoom/pan actions) only ever `set()`s
 *   keys other than `items`, so `items` keeps the same reference across
 *   those calls and no history entry is created. `createItemLocal`,
 *   `updateItemGeometry`, `deleteItem`, `reorderZIndex`, and
 *   `updateLinePoints` all replace `items` with a new array, so those calls
 *   do produce a history entry. This is simpler and safer than a
 *   `partialize` that strips fields per-item (e.g. dropping `properties`):
 *   zundo's `undo()`/`redo()` write the partialized snapshot straight back
 *   into the store via a shallow merge, so a partialize that reshapes/omits
 *   fields would silently corrupt `items` (losing `properties`) the first
 *   time `undo()` ran. Keeping `items` snapshots whole avoids that trap
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
 * - `setItems` (the server seed/re-baseline) is likewise bracketed with
 *   `pause()`/`resume()`: a server resync is never a user-undoable step.
 *   (Historically, leaving it tracked was the root cause of a real "undo is
 *   one step behind / redo doesn't work" bug — every refetch-driven reseed
 *   pushed a spurious history entry and wiped the redo stack.)
 *
 * U17 decision: a Line-point drag (`updateLinePoints`, below) is undo-
 * tracked like `updateItemGeometry`, not untracked like
 * `updateItemProperties` — R15 defines the undoable set as "create, move,
 * resize, rotate, delete", and a Line's points ARE its shape, so
 * repositioning one is a "move" of that Line's geometry, not a cosmetic
 * change like color or name. `ObjectShape.tsx` reads
 * `object.properties.points` directly off `items[i]`, which is and always
 * has been the sole source of truth for a Line's structural data.
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
  /**
   * Explicit-save model: true whenever `items` has diverged from the last
   * server-confirmed baseline — set by every content-mutating action
   * (create/move/resize/rotate/delete/z-reorder/line-point-edit/property
   * edit) and by any effective `undo()`/`redo()` traversal (an undo away
   * from the saved state is unsaved divergence too). Cleared by
   * `markSaved()` and by `setItems` (which re-baselines from the server).
   * View-of-persistence state, not document state — kept OUT of zundo's
   * `partialize` so history traversals can never restore a stale flag.
   */
  dirty: boolean

  /**
   * Client-id -> server-id translation table, the mechanism that keeps
   * undo/redo working ACROSS saves. Within a session an item's id never
   * changes client-side (a sidebar drop keeps its `local-…` id forever,
   * even after the save that created its real row) — so every zundo
   * history snapshot stays valid no matter how many saves happen in
   * between. The map is consulted only at the persistence boundary:
   * `useSaveObjects` translates ids on the way out and merges the
   * response's `id_map` (sent id -> created id) on the way back. Keyed by
   * `String(id)` (covers local string ids AND stale integer ids whose row
   * a previous save deleted and a later one recreated). Untracked by undo
   * (outside `partialize`); reset by `setItems`, which re-baselines
   * identity from the server.
   */
  serverIdMap: Record<string, number>

  /** Merges a save response's `id_map` into `serverIdMap` (see above). */
  mergeServerIdMap: (idMap: Record<string, number>) => void

  /**
   * Replaces the full items list from server data — the initial load's
   * seed and a floor-plan switch's reseed. Always a server-driven
   * re-baseline, never a user edit, so it clears `dirty`, resets
   * `serverIdMap` (item identity now comes straight from the server), and
   * is bracketed with `temporal.pause()`/`resume()` — a resync must never
   * itself become an undoable/redoable step (see the class doc above for
   * the historical bug this prevents). Deliberately NOT called after a
   * save: a save keeps the store's items (and undo history) untouched and
   * only updates `serverIdMap`/`dirty`.
   */
  setItems: (items: CanvasObject[]) => void

  /**
   * Appends a locally-created item (sidebar drop, Shape draw, Line draw) to
   * the store. Purely local — the item keeps its `local-` client id until
   * the next explicit save round-trips it through the backend.
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
   * U18: moves an item to the front (`'front'`) or back (`'back'`) of the
   * floor plan's stacking order by setting its `z_index` to one above the
   * current max, or one below the current min, among ALL of this store's
   * `items` (siblings on the same FloorPlan — this store never holds more
   * than one FloorPlan's items at a time: the `/floor-plans/:floorPlanId`
   * editor route renders a single plan and `setItems` replaces the store
   * wholesale on a plan switch, so no extra `floor_plan` filtering is
   * needed here).
   *
   * Rendering order itself is NOT touched here or anywhere in this store —
   * per the plan's Key Technical Decision, `CanvasStage.tsx` derives render
   * order by sorting `items` by `z_index` (then `id`) immediately before
   * mapping to `ObjectShape`s, matching the backend's `('z_index', 'id')`
   * queryset ordering. This action's only job is updating the persisted
   * field; it deliberately does NOT call any imperative Konva
   * `.moveToTop()`/`.zIndex()` API, which react-konva's own docs warn will
   * fight React's own re-renders.
   *
   * Undo-tracked (R15/U9): replaces `items` with a new array reference like
   * `updateItemGeometry`/`updateLinePoints`, so it participates in undo
   * history via the store's reference-equality `equality` check.
   *
   * A no-op if `id` doesn't match any item, or if `items` has only one
   * item (nothing to reorder relative to).
   */
  reorderZIndex: (id: CanvasObject['id'], direction: 'front' | 'back') => void

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
   * to actually be visible. `properties`, when provided, REPLACES the
   * item's `properties` object wholesale rather than shallow-merging — this
   * lets the Property Panel's generic key-value editor support deleting a
   * key (the panel builds the full next-`properties` object itself,
   * preserving any Line-structural keys like `points`/`curve_style` it
   * doesn't expose in its generic editor, and omitting whatever the user
   * deleted). `name`, when provided, replaces the item's `name`.
   *
   * Intentionally NOT undoable (R15's confirmed scope decision): even
   * though this produces a new `items` array reference (which would
   * otherwise register as a history-worthy change under the store's
   * reference-equality check), the implementation brackets its `set()` call
   * with `temporal.pause()`/`temporal.resume()` so zundo's history tracking
   * is genuinely suspended for the duration. It IS still a content change
   * the user hasn't saved, though, so it sets `dirty` like every other
   * content action. A no-op if `id` doesn't match any item.
   */
  updateItemProperties: (
    id: CanvasObject['id'],
    patch: { name?: string; properties?: Record<string, unknown> },
  ) => void

  /** Clears the `dirty` flag — the canvas now matches the last
   * server-confirmed state. (A successful save clears it via `setItems`
   * re-baselining from the response; this standalone action exists for
   * callers/tests that need to reset the flag without replacing `items`.) */
  markSaved: () => void

  /** Sets the active drawing tool (U15/U16). Untracked by undo. */
  setActiveTool: (tool: ActiveTool) => void

  /** U11: sets the Stage's zoom AND position together in one call — the
   * shape `coordinates.ts`'s `computeWheelZoom`/`computePinchZoom` return,
   * since a zoom-to-point/pinch changes both at once (repositioning is what
   * keeps the point under the cursor/fingers fixed). Clamped defensively
   * even though callers already clamp, so a stray direct call can't push
   * `zoom` outside [MIN_ZOOM, MAX_ZOOM]. */
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
      dirty: false,
      serverIdMap: {},

      mergeServerIdMap: (idMap) =>
        set((state) => ({ serverIdMap: { ...state.serverIdMap, ...idMap } })),

      setItems: (items) => {
        // Server-driven re-baseline (see this action's doc comment on the
        // CanvasState interface above): never undoable, the canvas now
        // matches the server by definition (clear `dirty`), and item
        // identity comes straight from the server (reset `serverIdMap`).
        const temporalStore = useCanvasStore.temporal.getState()
        temporalStore.pause()
        set({ items, dirty: false, serverIdMap: {} })
        temporalStore.resume()
      },

      createItemLocal: (item) =>
        set((state) => ({
          items: [...state.items, item],
          dirty: true,
        })),

      selectItem: (id) => set({ selectedItemId: id }),

      updateItemGeometry: (id, patch) =>
        set((state) => ({
          items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
          dirty: true,
        })),

      deleteItem: (id) =>
        set((state) => ({
          items: state.items.filter((item) => item.id !== id),
          selectedItemId: state.selectedItemId === id ? null : state.selectedItemId,
          dirty: true,
        })),

      reorderZIndex: (id, direction) =>
        set((state) => {
          const item = state.items.find((candidate) => candidate.id === id)
          if (!item || state.items.length < 2) return {}

          const zIndexes = state.items.map((candidate) => candidate.z_index)
          const nextZIndex =
            direction === 'front' ? Math.max(...zIndexes) + 1 : Math.min(...zIndexes) - 1

          return {
            items: state.items.map((candidate) =>
              candidate.id === id ? { ...candidate, z_index: nextZIndex } : candidate,
            ),
            dirty: true,
          }
        }),

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
            dirty: true,
          }
        }),

      updateItemProperties: (id, patch) => {
        // Suspend zundo tracking for exactly this set() call (R15: property
        // edits must not create undo history), then immediately resume so
        // every other action continues to be tracked normally. Still a
        // content change the user hasn't saved — sets `dirty` (which is
        // outside partialize, so pausing history doesn't affect it anyway).
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
          dirty: true,
        }))
        temporalStore.resume()
      },

      markSaved: () => set({ dirty: false }),

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
      // redo() never touch selectedItemId, activeTool, zoom/pan, or dirty.
      partialize: (state) => ({ items: state.items }),
      // Reference equality on `items` is sufficient for the actions that
      // rely on it: selectItem/setActiveTool/markSaved and the zoom/pan
      // actions never reassign `items`, so its reference is unchanged
      // across those calls and no entry is created. createItemLocal,
      // updateItemGeometry, deleteItem, reorderZIndex, and updateLinePoints
      // always build a new `items` array, so those do produce an entry.
      // `setItems` and `updateItemProperties` ALSO build a new `items`
      // array reference but are kept out of history via
      // `temporal.pause()`/`resume()` instead of relying on this equality
      // check, since reference equality alone can't distinguish "a real
      // user action" from "a server resync"/"a property edit."
      equality: (past, current) => past.items === current.items,
    },
  ),
)

/**
 * Undo/redo entry points. Thin wrappers around zundo's temporal store
 * (`useCanvasStore.temporal.getState()`) rather than every call site (e.g.
 * `Toolbar.tsx`, `useCanvasShortcuts.ts`) reaching into `.temporal`
 * directly. Pure local-state traversals — with the explicit-save model
 * nothing about an undo/redo talks to the backend — but a traversal that
 * actually changes the canvas leaves it diverged from the last saved state,
 * so it marks the store dirty (the `items`-reference check below makes a
 * no-op traversal, e.g. undo with an empty history, leave `dirty` alone).
 * `dirty` lives outside `partialize`, so setting it here pushes no history
 * entry of its own (`equality` sees the same `items` reference).
 */
export function undo(): void {
  const before = useCanvasStore.getState().items
  useCanvasStore.temporal.getState().undo()
  if (useCanvasStore.getState().items !== before) {
    useCanvasStore.setState({ dirty: true })
  }
}

export function redo(): void {
  const before = useCanvasStore.getState().items
  useCanvasStore.temporal.getState().redo()
  if (useCanvasStore.getState().items !== before) {
    useCanvasStore.setState({ dirty: true })
  }
}
