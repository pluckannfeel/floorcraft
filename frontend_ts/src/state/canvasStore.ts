import { create } from 'zustand'
import { temporal } from 'zundo'
import { clampZoom } from '../canvas/coordinates'
import { isLocalId, type CanvasObject, type LineType, type Point, type ShapeType } from '../canvas/types'

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
/**
 * U13: the interface `undo()`/`redo()` (below) dispatch through to re-issue
 * the same persistence call the original action would have made (Key
 * Technical Decisions: "Undo/redo re-issues the same persistence call the
 * original action would have made"). Defined here (not imported from
 * `hooks/useObjects.ts`) to avoid a circular import — `useObjects.ts`
 * imports `useCanvasStore` from this module already, so this module can't
 * also import mutation hooks from `useObjects.ts`.
 *
 * A React component (`CanvasEditorPage` via `useObjectPersistence`, see
 * `useObjects.ts`) registers the live implementation — backed by
 * TanStack Query mutations — on mount, and unregisters it on unmount. Until
 * a dispatcher is registered (e.g. in this store's own unit tests, which
 * call `undo()`/`redo()` directly with no `CanvasEditorPage` mounted),
 * `undo()`/`redo()` still perform their local state traversal correctly;
 * they simply have no persistence call to make.
 */
export interface PersistenceDispatcher {
  /** Re-issues a create (`POST`) for an item that came back into `items`
   * (redo of a create, or undo of a delete) without a corresponding
   * `beforeById` entry. The dispatcher is responsible for swapping the
   * item's id for the server-assigned one on success (`swapItemId`,
   * below), same as the original create flow. */
  createObject: (item: CanvasObject) => void
  /** Re-issues an update (`PATCH`) for an item whose geometry/z_index/
   * properties differ between the pre- and post-traversal `items`
   * snapshots. `previous` is the pre-traversal item, for the mutation's
   * onError rollback. */
  updateObject: (id: CanvasObject['id'], patch: Record<string, unknown>, previous: CanvasObject) => void
  /** Re-issues a delete (`DELETE`) for an item present before the
   * traversal but missing after (redo of a delete, or undo of a create).
   * `previous` is the item as it existed before the traversal, for the
   * mutation's onError rollback (re-adding it). */
  deleteObject: (id: CanvasObject['id'], previous: CanvasObject) => void
}

let persistenceDispatcher: PersistenceDispatcher | null = null

/** Registers (or, passed `null`, clears) the live persistence dispatcher.
 * Exported so `useObjects.ts`'s `useObjectPersistence` hook can wire it up
 * from a `useEffect` without this module needing to know anything about
 * TanStack Query. */
export function registerPersistenceDispatcher(dispatcher: PersistenceDispatcher | null): void {
  persistenceDispatcher = dispatcher
}

/**
 * Diffs two `items` snapshots (taken immediately before/after an undo() or
 * redo() traversal) and dispatches the minimal set of persistence calls
 * needed to bring the backend in line with the traversal's result:
 *   - an id present before but not after -> that item was removed by the
 *     traversal -> issue a delete (skipped if the id was only ever local,
 *     i.e. never actually persisted).
 *   - an id present after but not before -> that item was (re)added by the
 *     traversal -> issue a create (skipped if the id is still local-only —
 *     never actually persisted — since re-dispatching a create for it would
 *     risk a duplicate POST once its original, still-in-flight create call
 *     also resolves).
 *   - an id present in both, with differing geometry/z_index/properties
 *     -> issue an update with just the changed fields.
 * This one function is genuinely uniform across every undo/redo-able
 * action (create/move/resize/rotate/delete/z-reorder/line-point-edit) —
 * none of them need bespoke undo-persistence logic, since they all reduce
 * to "how did the `items` array change."
 */
function diffAndDispatchPersistence(before: CanvasObject[], after: CanvasObject[]): void {
  const dispatcher = persistenceDispatcher
  if (!dispatcher) return

  const beforeById = new Map(before.map((item) => [item.id, item]))
  const afterById = new Map(after.map((item) => [item.id, item]))

  for (const [id, item] of beforeById) {
    if (!afterById.has(id) && !isLocalId(id)) {
      dispatcher.deleteObject(id, item)
    }
  }

  for (const [id, item] of afterById) {
    // Skip items that are still local-id-only: they were never actually
    // persisted in the first place (their original creation's own
    // `persistence.createObject` call — dispatched directly by
    // `CanvasEditorPage.tsx`, not through this diff — is solely responsible
    // for that POST). Re-dispatching a create here for a still-local-id
    // item that reappears (e.g. undo of a delete performed before its
    // original create ever resolved, or redo of a create whose POST is
    // still in flight) would risk firing a second, duplicate POST for the
    // same logical item once the original call also resolves.
    if (!beforeById.has(id) && !isLocalId(id)) {
      dispatcher.createObject(item)
    }
  }

  for (const [id, afterItem] of afterById) {
    const beforeItem = beforeById.get(id)
    if (!beforeItem || isLocalId(id)) continue
    const patch = diffPersistedFields(beforeItem, afterItem)
    if (patch) dispatcher.updateObject(id, patch, beforeItem)
  }
}

/** Returns just the fields that differ between two snapshots of the same
 * item (by id), in the shape a `PATCH` body expects — or `null` if nothing
 * persisted actually changed. `properties` is compared by value (JSON
 * string), not reference, since `updateLinePoints`/`updateItemProperties`
 * always build a new `properties` object even when the values are
 * unchanged. */
function diffPersistedFields(before: CanvasObject, after: CanvasObject): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  if (before.x !== after.x) patch.x = after.x
  if (before.y !== after.y) patch.y = after.y
  if (before.width !== after.width) patch.width = after.width
  if (before.height !== after.height) patch.height = after.height
  if (before.rotation !== after.rotation) patch.rotation = after.rotation
  if (before.z_index !== after.z_index) patch.z_index = after.z_index
  if (JSON.stringify(before.properties) !== JSON.stringify(after.properties)) {
    patch.properties = after.properties
  }
  return Object.keys(patch).length > 0 ? patch : null
}

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
   * Replaces the full items list — called on the initial fetch AND on every
   * subsequent refetch-driven resync (`CanvasEditorPage.tsx`'s effect on
   * `objectsQuery.data`, which changes on every U13 mutation's `onSettled`
   * `invalidateQueries`, i.e. after essentially every user action).
   *
   * BUG FIX (U13 root cause of the reported "undo is one step behind /
   * redo doesn't work" issue): this action was originally left as a plain
   * tracked `set()` call, on the assumption it only ran once at initial
   * load. It does not — it reruns on every post-mutation refetch. Because
   * `equality` compares `items` by *reference* and a refetch always
   * produces a brand-new array (even when its contents are byte-identical
   * to the current store state), every refetch pushed a SECOND, spurious
   * history entry on top of the one the user's actual action (drag/resize/
   * delete/etc.) had already pushed moments earlier, and cleared
   * `futureStates` (zundo's `_handleSet` always does on a tracked push).
   * Net effect: one user action = two history entries, so a single undo()
   * only unwound the harmless "resync from server" entry (visually a
   * no-op, since the resynced data matches what's already on screen) and
   * left the actual change in place — requiring a second undo press to
   * revert it — and any pending redo stack was wiped after the very next
   * interaction's refetch landed. Fixed the same way `updateItemProperties`/
   * `removeItemUntracked`/etc. are kept out of history: bracket the `set()`
   * with `temporal.pause()`/`resume()`. A server resync is never a
   * user-undoable step.
   */
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
   * U18: moves an item to the front (`'front'`) or back (`'back'`) of the
   * floor plan's stacking order by setting its `z_index` to one above the
   * current max, or one below the current min, among ALL of this store's
   * `items` (siblings on the same FloorPlan — this store never holds more
   * than one FloorPlan's items at a time, per `DEFAULT_FLOOR_PLAN_ID`'s "no
   * floor-plan selector" scope, so no extra `floor_plan` filtering is
   * needed here). Mirrors `handleDrop`/`handleCreateShape`/`handleCreateLine`
   * in `CanvasEditorPage.tsx`, which already compute a new item's initial
   * `z_index` the same "one past the current max" way.
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
   * history via the store's reference-equality `equality` check — per the
   * plan's U18 test scenarios ("z-reordering is undoable via U9's store")
   * and its Key Technical Decisions list, which names z-reorder alongside
   * create/move/resize/rotate/delete as undo-tracked.
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

  /**
   * U13: removes a local-only "ghost" item after its create mutation fails
   * (Key Technical Decisions: create-failure removes the ghost rather than
   * reverting a position, since a brand-new item has no prior position to
   * revert to). This is a system-driven rollback, not a user action, so —
   * like `updateItemProperties` — it brackets its `set()` with
   * `temporal.pause()`/`temporal.resume()`: a failed create must not itself
   * become an undoable/redoable step (undoing "the ghost got removed"
   * makes no sense to a user who never asked for that removal).
   */
  removeItemUntracked: (id: CanvasObject['id']) => void

  /**
   * U13: restores a single item to a prior snapshot after a failed update
   * or delete mutation (R17) — replacing the item in place if it's still
   * present (a failed update PATCH: revert its fields), or re-adding it if
   * it's gone (a failed delete: put it back). Untracked by undo for the
   * same reason as `removeItemUntracked` — a failed-mutation rollback is
   * not a user-initiated action.
   */
  restoreItemUntracked: (item: CanvasObject) => void

  /**
   * U13: swaps a local-only or stale id for the real backend-assigned id
   * after a create mutation succeeds — both the initial sidebar/shape/line
   * creation flow (local id -> real id) and undo-of-delete's "recreate via
   * new id" case (stale real id -> new real id, since the original backend
   * row is genuinely gone once its DELETE has succeeded). Untracked by undo
   * (system-driven correction, not a user action).
   *
   * Also purges any zundo history entries (past AND future) whose `items`
   * snapshot still references `oldId` — per the plan's documented
   * limitation ("undo-of-delete recreates via new id; later history entries
   * referencing the old id are dropped"), those snapshots are now
   * unreconcilable with the swapped-in item's new identity, so rather than
   * silently misbehaving if a later undo/redo ever reached one, they're
   * dropped outright.
   */
  swapItemId: (oldId: CanvasObject['id'], newItem: CanvasObject) => void

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

      setItems: (items) => {
        // See this action's doc comment on the `CanvasState` interface above:
        // this runs on every post-mutation refetch resync, not just the
        // initial load, and must never itself be undoable/redoable.
        const temporalStore = useCanvasStore.temporal.getState()
        temporalStore.pause()
        set({ items })
        temporalStore.resume()
      },

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

      removeItemUntracked: (id) => {
        const temporalStore = useCanvasStore.temporal.getState()
        temporalStore.pause()
        set((state) => ({
          items: state.items.filter((item) => item.id !== id),
          selectedItemId: state.selectedItemId === id ? null : state.selectedItemId,
        }))
        temporalStore.resume()
      },

      restoreItemUntracked: (item) => {
        const temporalStore = useCanvasStore.temporal.getState()
        temporalStore.pause()
        set((state) => {
          const exists = state.items.some((candidate) => candidate.id === item.id)
          return {
            items: exists
              ? state.items.map((candidate) => (candidate.id === item.id ? item : candidate))
              : [...state.items, item],
          }
        })
        temporalStore.resume()
      },

      swapItemId: (oldId, newItem) => {
        const temporalStore = useCanvasStore.temporal.getState()
        temporalStore.pause()
        set((state) => ({
          items: state.items.map((item) => (item.id === oldId ? newItem : item)),
          selectedItemId: state.selectedItemId === oldId ? newItem.id : state.selectedItemId,
        }))
        temporalStore.resume()

        // Drop any history entries (past or future) that still reference
        // the swapped-out id — see this action's doc comment above. zundo
        // types each history entry as `Partial<{items: CanvasObject[]}>`
        // (the partialized/tracked slice), so `items` is technically
        // optional even though `partialize` above always includes it.
        const referencesOldId = (snapshot: Partial<{ items: CanvasObject[] }>) =>
          (snapshot.items ?? []).some((item) => item.id === oldId)
        useCanvasStore.temporal.setState((temporal) => ({
          pastStates: temporal.pastStates.filter((snapshot) => !referencesOldId(snapshot)),
          futureStates: temporal.futureStates.filter((snapshot) => !referencesOldId(snapshot)),
        }))
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
      // createItemLocal, updateItemGeometry, deleteItem, reorderZIndex, and
      // updateLinePoints always build a new `items` array, so those do
      // produce an entry. `setItems` and `updateItemProperties` ALSO build a
      // new `items` array reference but are kept out of history via
      // `temporal.pause()`/`resume()` instead of relying on this equality
      // check, since reference equality alone can't distinguish "a real user
      // action" from "a server resync"/"a property edit." See `setItems`'s
      // doc comment for why leaving it tracked was the actual root cause of
      // a real reported undo/redo bug.
      equality: (past, current) => past.items === current.items,
    },
  ),
)

/**
 * Undo/redo entry points. Thin wrappers around zundo's temporal store
 * (`useCanvasStore.temporal.getState()`) rather than every call site (e.g.
 * `Toolbar.tsx`) reaching into `.temporal` directly — this indirection was
 * U9's extension point for U13, used here: each call snapshots `items`
 * immediately before and after the zundo traversal, then hands both to
 * `diffAndDispatchPersistence` (above), which re-issues whatever
 * create/update/delete call(s) the traversal's net effect implies via the
 * registered `PersistenceDispatcher`. No dispatcher is registered outside a
 * mounted `CanvasEditorPage` (e.g. this store's own unit tests), in which
 * case the diff is computed and immediately discarded — harmless, since
 * `diffAndDispatchPersistence` no-ops without a dispatcher.
 */
export function undo(): void {
  const before = useCanvasStore.getState().items
  useCanvasStore.temporal.getState().undo()
  diffAndDispatchPersistence(before, useCanvasStore.getState().items)
}

export function redo(): void {
  const before = useCanvasStore.getState().items
  useCanvasStore.temporal.getState().redo()
  diffAndDispatchPersistence(before, useCanvasStore.getState().items)
}
