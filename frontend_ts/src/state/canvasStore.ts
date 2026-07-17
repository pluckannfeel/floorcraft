import { create } from 'zustand'
import { temporal } from 'zundo'
import { clampZoom } from '../canvas/coordinates'
import type { BoundingBox } from '../canvas/coordinates'
import type { CanvasObject, LineType, Point, ShapeType, TextType } from '../canvas/types'

/** U11's default zoom step for the Toolbar's zoom in/out buttons (a gentler
 * per-click step than a single wheel "tick" would feel like, since a click
 * is a more deliberate action than a scroll). */
const TOOLBAR_ZOOM_STEP = 1.2

/**
 * Drawing-tool mode for the shape/line/text creation flows (U15/U16, and
 * canvas-tools U7's `'text'`, U8's `'crop'`). `'select'` is the default/idle
 * mode matching the drag-select interaction; the rest mirror `ShapeType`/
 * `LineType`/`TextType` from `canvas/types.ts` plus the crop tool. Untracked
 * by undo (see `partialize` below) — switching tools isn't a content change.
 */
export type ActiveTool = 'select' | ShapeType | LineType | TextType | 'crop'

/**
 * U8 (canvas-tools): the floor plan's live canvas dimensions while editing.
 * `null` only before the first seed (the editor doesn't render the stage
 * until the seed-once effect stamps real dims) and after a plan-switch
 * reset, so unsaved cropped dims can never leak into the next plan.
 */
export interface CanvasSize {
  width: number
  height: number
}

/**
 * One item's share of a batched `updateItemsGeometry` gesture commit.
 *
 * U3 decision (the plan's "extend the batched action to accept a points
 * patch" option): a Line member of a multi-selection moves/resizes by
 * replacing its `properties.points` (a Line's points ARE its geometry — the
 * same U17 reasoning that made `updateLinePoints` undo-tracked), but
 * `properties` is not a geometry column. Rather than adding a second store
 * write (which would split one gesture into two history entries), the
 * batched patch carries an optional `points` array that
 * `updateItemsGeometry` folds into `item.properties.points` inside the SAME
 * single `set()` — one gesture, one history entry, whatever mix of boxes
 * and Lines the selection contains.
 */
export type ItemGeometryPatch = Partial<
  Pick<CanvasObject, 'x' | 'y' | 'width' | 'height' | 'rotation'>
> & {
  /** Replacement ABSOLUTE canvas points for a Line-typed item. */
  points?: Point[]
  /**
   * U7: replacement `font_size` for a TEXT-typed item — the transformer
   * resize special case (a text node folds `min(scaleX, scaleY)` into its
   * font size instead of stretching width/height; see
   * `computeTransformCommit`). Folded into `item.properties.font_size`
   * inside the same single tracked `set()`, exactly like `points` — one
   * gesture, one history entry, and the patch's width/height carry the
   * remeasured mirrored box alongside.
   */
  font_size?: number
}

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
 * Undo/redo design notes (U9, extended by canvas-tools U8):
 * - `zundo`'s `partialize` returns `{ items, canvasSize }` (U8 pulled the
 *   canvas dims into the tracked snapshot so a crop undoes as ONE step), so
 *   `undo()`/`redo()`
 *   read/write *only* those keys on this store — `selectedItemIds`,
 *   `activeTool`, zoom/pan, and `dirty` are never touched by a history
 *   traversal, matching R15's "property edits are excluded" scope decision
 *   and the plan's Key Technical Decision that undo/redo is partitioned to
 *   document content only. (`dirty` in particular must stay out: a traversal must
 *   never restore a stale saved/unsaved flag — `undo()`/`redo()` below mark
 *   the store dirty themselves whenever a traversal actually changes the
 *   canvas. `selectedItemIds` likewise: a traversal never RESTORES an old
 *   selection, but the exported `undo()`/`redo()` wrappers do PRUNE ids
 *   that no longer exist in the restored `items`, so e.g. undoing a create
 *   can't leave a ghost selection pointing at a nonexistent item.)
 * - `equality` gates whether a given `set()` call pushes a new history
 *   entry at all: it compares the `items` array AND `canvasSize` (U8) by
 *   *reference*. Every
 *   action below that isn't supposed to be undoable (the selection actions
 *   `replaceSelection`/`toggleInSelection`/`toggleIdsInSelection`/
 *   `clearSelection`, `setActiveTool`, `markSaved`, the zoom/pan actions)
 *   only ever `set()`s
 *   keys other than `items`/`canvasSize`, so both keep the same reference
 *   across
 *   those calls and no history entry is created. `createItemLocal`/
 *   `createItemsLocal`,
 *   `updateItemGeometry`/`updateItemsGeometry`, `deleteItem`/`deleteItems`,
 *   `reorderZIndex`/`reorderZIndexItems`, `updateLinePoints`, U4's
 *   `groupSelection`/`ungroupSelection`, U7's `updateItemText`, and U8's
 *   `applyCrop` (which replaces BOTH tracked references at once) all
 *   replace `items` with a new array, so those calls
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
  /**
   * U1 (canvas-tools plan): the current selection, as an ORDERED array of
   * item ids (insertion-ordered, not a Set — deterministic and
   * JSON-friendly for tests). This is always the LITERAL operand set every
   * consumer acts on as-is (delete, z-order, transformer, property panel):
   * group expansion (U4) happens at selection time in the click/marquee
   * handlers, never by derivation here, and no consumer re-expands or
   * branches on group state. Consumers needing exactly-one semantics
   * (PropertyPanel's form, line anchor handles) check `length === 1`.
   * Untracked by undo (never in `partialize` — a binding invariant from
   * docs/solutions/ui-bugs/undo-redo-broken-after-save-2026-07-16.md); the
   * exported `undo()`/`redo()` wrappers below prune ids absent from the
   * restored `items` after a traversal instead.
   */
  selectedItemIds: CanvasObject['id'][]
  /** Drawing-tool mode for U15/U16's shape/line creation flows. */
  activeTool: ActiveTool
  /**
   * U8: the canvas dimensions, part of the TRACKED snapshot (unlike
   * zoom/pan/selection): `partialize` below carries `{ items, canvasSize }`
   * and `equality` compares BOTH references, so `applyCrop` — which replaces
   * both in ONE `set()` — is a single history entry whose undo restores dims
   * AND every shifted coordinate together. Seeded by `setItems` (from the
   * floor-plan query, inside the same paused bracket) and reset to `null` by
   * the plan-switch `setItems([])`; every OTHER action leaves the reference
   * untouched, so nothing else ever pushes a dims history entry.
   */
  canvasSize: CanvasSize | null
  /** U11: current Stage scale (mirrors Konva's `scaleX`/`scaleY`, kept
   * equal on both axes). View state, not document state — deliberately NOT
   * part of `partialize` below, so zooming/panning never creates undo
   * history (same "only set() items and it's tracked" mechanism the class
   * doc above already relies on for `selectedItemIds`/`activeTool`: this
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
   *
   * U8: also the `seedFromServer(items, canvasSize)`-shaped seed for the
   * canvas dims — the seed-once effect gates on BOTH queries and passes the
   * floor plan's dims here, inside the same paused bracket, so seeding
   * never becomes an undoable step either. Omitting `canvasSize` (the
   * plan-switch reset's `setItems([])`) resets it to `null`, so an unsaved
   * crop's dims can't leak into the next plan.
   */
  setItems: (items: CanvasObject[], canvasSize?: CanvasSize | null) => void

  /**
   * U8: applies a confirmed crop region (model-space rect, integer-rounded
   * by the crop gesture) in ONE tracked `set()` that ALWAYS replaces BOTH
   * tracked references — the `items` array (every object's x/y shifted by
   * -rect.x/-rect.y; a Line's `properties.points` shifted identically, its
   * x/y bbox metadata shifting via the same x/y rule) and `canvasSize`
   * ({rect.width, rect.height}) — so one undo restores dims AND every
   * coordinate together. Objects fully or partly outside the region KEEP
   * their (now possibly negative / out-of-bounds) coordinates (R22);
   * `constrainTransformBox`/`clampGroupDragDelta` relax their bounds
   * rejection for already-out-of-bounds boxes so such objects stay
   * transformable/movable. Note: a crop origin that isn't grid-aligned
   * de-aligns previously grid-snapped objects — accepted per the plan (the
   * next drag re-snaps them).
   */
  applyCrop: (rect: BoundingBox) => void

  /**
   * Appends a locally-created item (sidebar drop, Shape draw, Line draw) to
   * the store. Purely local — the item keeps its `local-` client id until
   * the next explicit save round-trips it through the backend.
   */
  createItemLocal: (item: CanvasObject) => void

  /**
   * U5: batched multi-item variant of `createItemLocal` — appends every
   * minted item in ONE `set()` (one history entry for a whole paste,
   * however many items the clipboard held; a single undo removes the whole
   * pasted set, AE4). The items arrive fully formed from
   * `clipboard.ts`'s `mintClipboardItems` (fresh `local-` ids, fresh
   * `group-` keys, absolute geometry, top-of-stack z_indexes) — this action
   * only commits them. A no-op (same `items` reference, so no history
   * entry, `dirty` untouched) for an empty list. Selecting the pasted set
   * is the caller's follow-up `replaceSelection` (untracked, so the pair
   * still yields exactly one history entry).
   */
  createItemsLocal: (items: CanvasObject[]) => void

  /**
   * U1: replaces the selection wholesale with `ids` — the plain-click
   * contract (`replaceSelection([id])`) and, from U2 on, the marquee's full
   * hit set. Callers pass the exact operand set (group expansion, when it
   * arrives in U4, happens in the handlers before this call). Untracked by
   * undo (never touches `items`).
   */
  replaceSelection: (ids: CanvasObject['id'][]) => void

  /**
   * U1: toggles one id's membership in the selection — the ctrl(/meta)+
   * click contract. Removes the id if present; appends it at the END if
   * not (the array is insertion-ordered). Untracked by undo.
   */
  toggleInSelection: (id: CanvasObject['id']) => void

  /**
   * U4: batched variant of `toggleInSelection` — toggles a whole id SET
   * in/out of the selection atomically, the group-aware ctrl(/meta)+click
   * contract (the handler expands the clicked member's `group_key` peers
   * via `expandIdsByGroup` and passes the expanded set here). When EVERY
   * given id is already selected the whole set is removed; otherwise the
   * missing ids are appended at the END in the given order (so a partially
   * selected group completes rather than half-toggling). A one-element set
   * behaves exactly like `toggleInSelection`, which remains for lone-object
   * paths (the same single+batched convention as `deleteItem`/
   * `deleteItems`). Untracked by undo.
   */
  toggleIdsInSelection: (ids: CanvasObject['id'][]) => void

  /** U1: empties the selection (empty-canvas click, PNG export, plan
   * switch). Untracked by undo. */
  clearSelection: () => void

  /**
   * U4: stamps ONE fresh client-generated key (`group-${crypto.randomUUID()}`,
   * NEVER server-assigned — the institutional stable-identity invariant, so
   * keys ride `items` snapshots safely with no id-map involvement) onto
   * every currently-selected item, in ONE tracked `set()` — one history
   * entry per Group action. Groups are FLAT (R9): items already carrying a
   * key are simply re-stamped with the new one, merging any groups in the
   * selection into a single group. A no-op (no history entry, `dirty`
   * untouched) unless the selection matches at least 2 items.
   */
  groupSelection: () => void

  /**
   * U4: clears `group_key` (to null) on every currently-selected item, in
   * ONE tracked `set()`. A mixed selection dissolves ALL groups present;
   * loose (never-grouped) members are untouched, and the selection itself
   * is left as-is (everything stays selected — selection is untracked
   * anyway). A no-op (no history entry, `dirty` untouched) unless at least
   * one selected item is grouped.
   */
  ungroupSelection: () => void

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

  /**
   * U1: batched multi-item variant of `updateItemGeometry` — applies every
   * patch in ONE `set()` call, so a single gesture over a multi-selection
   * (U3's group move/transform, U6's align/distribute) produces exactly one
   * history entry (one `items` reference swap), never N undo steps. Later
   * patches for the same id shallow-merge over earlier ones. A no-op (same
   * `items` reference, so no history entry) when no patch id matches an
   * item. The single-item action above remains for lone-object paths.
   *
   * U3: a patch may carry `points` for a Line member — folded into that
   * item's `properties.points` in the same `set()` (see `ItemGeometryPatch`
   * for why Line translation/scale commits ride this action instead of a
   * second one).
   */
  updateItemsGeometry: (
    patches: Array<{
      id: CanvasObject['id']
      patch: ItemGeometryPatch
    }>,
  ) => void

  /** Removes an item and drops its id from the selection if selected. */
  deleteItem: (id: CanvasObject['id']) => void

  /**
   * U1: batched multi-item variant of `deleteItem` — removes every listed
   * item in ONE `set()` (one history entry for a whole-selection delete)
   * and drops the deleted ids from the selection in the same call. A no-op
   * when none of the ids match an item.
   */
  deleteItems: (ids: CanvasObject['id'][]) => void

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
   * U1: batched multi-item variant of `reorderZIndex` — moves ALL listed
   * items above the previous max (`'front'`) or below the previous min
   * (`'back'`) among this store's `items`, preserving the batch's own
   * relative z-order (current `z_index`, then `id` — the same tiebreak
   * `CanvasStage.tsx`'s `sortObjectsByZIndex` renders by), in ONE
   * `set()`/history entry. Same no-op conditions as the single-item
   * action; both share the pure `applyZIndexReorder` helper below.
   */
  reorderZIndexItems: (ids: CanvasObject['id'][], direction: 'front' | 'back') => void

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
   * U7: commits a text object's CONTENT (`properties.text`) plus its
   * remeasured mirrored `width`/`height` in ONE tracked `set()` — one
   * history entry per overlay commit. TRACKED deliberately (the plan's
   * doc-review decision): text content is the object's substance — the same
   * "a Line's points ARE its shape" U17 reasoning behind
   * `updateLinePoints` — unlike STYLING, which stays untracked per R15
   * (see `updateItemTextStyling` below). Without tracking, an unrelated
   * undo would silently revert typed content via the whole-items snapshot
   * restore. A no-op (no history entry, `dirty` untouched) if `id` matches
   * no item.
   */
  updateItemText: (
    id: CanvasObject['id'],
    text: string,
    size: { width: number; height: number },
  ) => void

  /**
   * U7: commits a text object's STYLING (`properties` replacement — the
   * caller builds the full next-properties object, `updateItemProperties`
   * convention) plus the remeasured mirrored `width`/`height`, UNTRACKED
   * (R15: property/styling edits never create undo history — same
   * `temporal.pause()`/`resume()` bracket as `updateItemProperties`).
   * A dedicated action rather than `updateItemProperties` itself because
   * styling changes the rendered text metrics, so the mirrored box must
   * move in the same `set()` — and `updateItemProperties`' patch shape is
   * deliberately geometry-free. Still a content change the user hasn't
   * saved: sets `dirty`. A no-op if `id` matches no item.
   */
  updateItemTextStyling: (
    id: CanvasObject['id'],
    properties: Record<string, unknown>,
    size: { width: number; height: number },
  ) => void

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

  /** Sets the active drawing tool (U15/U16). Untracked by undo. U8:
   * entering the CROP tool also clears the selection (the plan's
   * interaction default — crop is a canvas-level gesture, and a lingering
   * selection would leave transformer chrome under the crop preview);
   * handled here so every entry path (Toolbar button, future shortcuts)
   * gets it for free. */
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

/**
 * U4's shared selection-expansion helper — THE mechanism behind the plan's
 * "expansion at selection time" model: the click/dblclick/marquee handlers
 * (`CanvasStage.tsx`) pass their raw hit ids through this before writing
 * the selection, so `selectedItemIds` is always the LITERAL operand set and
 * no consumer ever re-derives group membership. For each input id, if its
 * item carries a `group_key` the WHOLE key-set joins the result (in `items`
 * order — deterministic for the ordered-array selection contract);
 * ungrouped/unknown ids pass through as themselves. Deduplicated, input
 * order first. Pure and Konva-free; deliberately NOT called by anything in
 * this store — double-click member-mode (a plain one-id selection of a
 * grouped member) exists precisely because handlers can also choose NOT to
 * expand.
 */
export function expandIdsByGroup(
  ids: CanvasObject['id'][],
  items: CanvasObject[],
): CanvasObject['id'][] {
  const result: CanvasObject['id'][] = []
  const seen = new Set<CanvasObject['id']>()
  const push = (id: CanvasObject['id']) => {
    if (!seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  for (const id of ids) {
    const key = items.find((item) => item.id === id)?.group_key
    if (key != null) {
      for (const member of items) {
        if (member.group_key === key) push(member.id)
      }
    } else {
      push(id)
    }
  }
  return result
}

/**
 * Pure z-reorder math shared by `reorderZIndex` (single) and
 * `reorderZIndexItems` (batched): returns the next `items` array with every
 * matched id renumbered contiguously above the current max (`'front'`) or
 * below the current min (`'back'`) among ALL items, preserving the batch's
 * own relative ordering (current `z_index`, then `id`). Returns `null` when
 * there's nothing to do (no id matches any item, or fewer than 2 items) so
 * the calling action can no-op without replacing the `items` reference —
 * i.e. without pushing a history entry.
 */
function applyZIndexReorder(
  items: CanvasObject[],
  ids: CanvasObject['id'][],
  direction: 'front' | 'back',
): CanvasObject[] | null {
  const idSet = new Set(ids)
  const selected = items.filter((item) => idSet.has(item.id))
  if (selected.length === 0 || items.length < 2) return null

  const orderedSelected = [...selected].sort((a, b) => {
    if (a.z_index !== b.z_index) return a.z_index - b.z_index
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const zIndexes = items.map((item) => item.z_index)
  const base =
    direction === 'front'
      ? Math.max(...zIndexes) + 1
      : Math.min(...zIndexes) - orderedSelected.length
  const nextZIndexById = new Map<CanvasObject['id'], number>()
  orderedSelected.forEach((item, index) => nextZIndexById.set(item.id, base + index))

  return items.map((item) => {
    const nextZIndex = nextZIndexById.get(item.id)
    return nextZIndex === undefined ? item : { ...item, z_index: nextZIndex }
  })
}

export const useCanvasStore = create<CanvasState>()(
  temporal(
    (set) => ({
      items: [],
      selectedItemIds: [],
      activeTool: 'select',
      canvasSize: null,
      zoom: 1,
      stagePosition: { x: 0, y: 0 },
      dirty: false,
      serverIdMap: {},

      mergeServerIdMap: (idMap) =>
        set((state) => {
          // Chain repair: if an existing entry's TARGET row was itself
          // recreated by this save (its old id appears as a key in the
          // incoming map), re-point the entry at the new row. Without
          // this, a delete -> save -> undo -> save cycle leaves the
          // original client id aimed at a dead row forever, and every
          // subsequent save would delete-and-recreate that object (id
          // churn) instead of updating it in place.
          const merged: Record<string, number> = { ...state.serverIdMap }
          for (const [clientId, serverId] of Object.entries(merged)) {
            const repointed = idMap[String(serverId)]
            if (repointed !== undefined) merged[clientId] = repointed
          }
          return { serverIdMap: { ...merged, ...idMap } }
        }),

      setItems: (items, canvasSize = null) => {
        // Server-driven re-baseline (see this action's doc comment on the
        // CanvasState interface above): never undoable, the canvas now
        // matches the server by definition (clear `dirty`), and item
        // identity comes straight from the server (reset `serverIdMap`).
        // U8: the canvas dims seed rides the same paused set() — and the
        // default `null` means the plan-switch reset's `setItems([])`
        // clears any unsaved cropped dims along with the items.
        const temporalStore = useCanvasStore.temporal.getState()
        temporalStore.pause()
        set({ items, canvasSize, dirty: false, serverIdMap: {} })
        temporalStore.resume()
      },

      applyCrop: (rect) =>
        set((state) => ({
          // ONE tracked set() replacing BOTH tracked references (see the
          // action's interface doc): a single history entry restores dims
          // and every coordinate together on undo.
          items: state.items.map((item) => {
            const rawPoints = item.properties.points
            return {
              ...item,
              // Shifting x/y covers Lines' descriptive bbox metadata too —
              // a rigid translation moves the points' bbox by the same
              // delta.
              x: item.x - rect.x,
              y: item.y - rect.y,
              ...(Array.isArray(rawPoints)
                ? {
                    properties: {
                      ...item.properties,
                      points: rawPoints.map((point: Point) => ({
                        x: point.x - rect.x,
                        y: point.y - rect.y,
                      })),
                    },
                  }
                : {}),
            }
          }),
          canvasSize: { width: rect.width, height: rect.height },
          dirty: true,
        })),

      createItemLocal: (item) =>
        set((state) => ({
          items: [...state.items, item],
          dirty: true,
        })),

      createItemsLocal: (items) =>
        set((state) =>
          items.length === 0
            ? {}
            : {
                items: [...state.items, ...items],
                dirty: true,
              },
        ),

      replaceSelection: (ids) => set({ selectedItemIds: ids }),

      toggleInSelection: (id) =>
        set((state) => ({
          selectedItemIds: state.selectedItemIds.includes(id)
            ? state.selectedItemIds.filter((existing) => existing !== id)
            : [...state.selectedItemIds, id],
        })),

      toggleIdsInSelection: (ids) =>
        set((state) => {
          const selected = new Set(state.selectedItemIds)
          const allSelected = ids.every((id) => selected.has(id))
          return {
            selectedItemIds: allSelected
              ? state.selectedItemIds.filter((existing) => !ids.includes(existing))
              : [...state.selectedItemIds, ...ids.filter((id) => !selected.has(id))],
          }
        }),

      clearSelection: () => set({ selectedItemIds: [] }),

      groupSelection: () =>
        set((state) => {
          const idSet = new Set(state.selectedItemIds)
          const memberCount = state.items.reduce(
            (count, item) => (idSet.has(item.id) ? count + 1 : count),
            0,
          )
          // A group needs at least 2 real members — returning {} keeps the
          // `items` reference, so no history entry and `dirty` untouched.
          if (memberCount < 2) return {}
          const groupKey = `group-${crypto.randomUUID()}`
          return {
            items: state.items.map((item) =>
              idSet.has(item.id) ? { ...item, group_key: groupKey } : item,
            ),
            dirty: true,
          }
        }),

      ungroupSelection: () =>
        set((state) => {
          const idSet = new Set(state.selectedItemIds)
          const hasGroupedMember = state.items.some(
            (item) => idSet.has(item.id) && item.group_key != null,
          )
          if (!hasGroupedMember) return {}
          return {
            items: state.items.map((item) =>
              idSet.has(item.id) && item.group_key != null
                ? { ...item, group_key: null }
                : item,
            ),
            dirty: true,
          }
        }),

      updateItemGeometry: (id, patch) =>
        set((state) => ({
          items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
          dirty: true,
        })),

      updateItemsGeometry: (patches) =>
        set((state) => {
          const patchById = new Map<CanvasObject['id'], ItemGeometryPatch>()
          for (const { id, patch } of patches) {
            patchById.set(id, { ...patchById.get(id), ...patch })
          }
          if (!state.items.some((item) => patchById.has(item.id))) return {}
          return {
            items: state.items.map((item) => {
              const patch = patchById.get(item.id)
              if (!patch) return item
              // U3: `points` isn't a top-level column — fold it into
              // `properties.points` (same location `updateLinePoints`
              // writes and `ObjectShape` renders from) inside this same
              // single tracked set(). U7: `font_size` (a text member's
              // transformer-resize fold) rides the same mechanism into
              // `properties.font_size`.
              const { points, font_size, ...geometry } = patch
              const propertiesPatch = {
                ...(points !== undefined ? { points } : {}),
                ...(font_size !== undefined ? { font_size } : {}),
              }
              return {
                ...item,
                ...geometry,
                ...(points !== undefined || font_size !== undefined
                  ? { properties: { ...item.properties, ...propertiesPatch } }
                  : {}),
              }
            }),
            dirty: true,
          }
        }),

      deleteItem: (id) =>
        set((state) => ({
          items: state.items.filter((item) => item.id !== id),
          selectedItemIds: state.selectedItemIds.includes(id)
            ? state.selectedItemIds.filter((existing) => existing !== id)
            : state.selectedItemIds,
          dirty: true,
        })),

      deleteItems: (ids) =>
        set((state) => {
          const idSet = new Set(ids)
          const nextItems = state.items.filter((item) => !idSet.has(item.id))
          if (nextItems.length === state.items.length) return {}
          return {
            items: nextItems,
            selectedItemIds: state.selectedItemIds.filter((id) => !idSet.has(id)),
            dirty: true,
          }
        }),

      reorderZIndex: (id, direction) =>
        set((state) => {
          const nextItems = applyZIndexReorder(state.items, [id], direction)
          return nextItems ? { items: nextItems, dirty: true } : {}
        }),

      reorderZIndexItems: (ids, direction) =>
        set((state) => {
          const nextItems = applyZIndexReorder(state.items, ids, direction)
          return nextItems ? { items: nextItems, dirty: true } : {}
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

      updateItemText: (id, text, size) =>
        set((state) => {
          const item = state.items.find((candidate) => candidate.id === id)
          if (!item) return {}
          return {
            items: state.items.map((candidate) =>
              candidate.id === id
                ? {
                    ...candidate,
                    width: size.width,
                    height: size.height,
                    properties: { ...candidate.properties, text },
                  }
                : candidate,
            ),
            dirty: true,
          }
        }),

      updateItemTextStyling: (id, properties, size) => {
        // Untracked like `updateItemProperties` (R15 — styling edits push
        // no history entry), via the same pause()/resume() bracket; the
        // mirrored box update rides the same set() so the box can never
        // drift from the styling that produced it.
        const temporalStore = useCanvasStore.temporal.getState()
        temporalStore.pause()
        set((state) => {
          const item = state.items.find((candidate) => candidate.id === id)
          if (!item) return {}
          return {
            items: state.items.map((candidate) =>
              candidate.id === id
                ? { ...candidate, width: size.width, height: size.height, properties }
                : candidate,
            ),
            dirty: true,
          }
        })
        temporalStore.resume()
      },

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

      setActiveTool: (tool) =>
        // U8: entering the crop tool clears the selection (see the
        // interface doc). Neither key touches `items`/`canvasSize`, so no
        // history entry either way.
        set(tool === 'crop' ? { activeTool: tool, selectedItemIds: [] } : { activeTool: tool }),

      setZoomAndPosition: (zoom, position) => set({ zoom: clampZoom(zoom), stagePosition: position }),

      setStagePosition: (position) => set({ stagePosition: position }),

      zoomIn: () =>
        set((state) => ({ zoom: clampZoom(state.zoom * TOOLBAR_ZOOM_STEP) })),

      zoomOut: () =>
        set((state) => ({ zoom: clampZoom(state.zoom / TOOLBAR_ZOOM_STEP) })),

      resetZoom: () => set({ zoom: 1, stagePosition: { x: 0, y: 0 } }),
    }),
    {
      // `items` AND `canvasSize` (U8) form the tracked/restorable snapshot —
      // undo()/redo() never touch selectedItemIds, activeTool, zoom/pan, or
      // dirty. (Selection stays out per the institutional invariant: a
      // traversal must never restore a stale selection; the exported
      // undo()/redo() wrappers below prune dead ids from it instead.
      // `canvasSize` joins because a crop changes dims and coordinates as
      // ONE user action — restoring one without the other would tear the
      // document apart.)
      partialize: (state) => ({ items: state.items, canvasSize: state.canvasSize }),
      // Reference equality on BOTH tracked keys is sufficient for the
      // actions that rely on it: the selection actions (replaceSelection/
      // toggleInSelection/toggleIdsInSelection/clearSelection),
      // setActiveTool, markSaved, and
      // the zoom/pan actions never reassign `items` or `canvasSize`, so
      // both references are
      // unchanged across those calls and no entry is created.
      // createItemLocal/createItemsLocal (U5's batched paste commit),
      // updateItemGeometry/updateItemsGeometry,
      // deleteItem/deleteItems, reorderZIndex/reorderZIndexItems,
      // updateLinePoints, groupSelection/ungroupSelection (U4),
      // updateItemText (U7's tracked content commit), and applyCrop (U8 —
      // the one action that replaces BOTH references)
      // always build a new `items` array, so those do
      // produce an entry (the batched variants deliberately in ONE set()
      // each — one history entry per gesture, however many items it
      // touched). `setItems`, `updateItemProperties`, and U7's
      // `updateItemTextStyling` ALSO build a new
      // `items` array reference (and `setItems` reseeds `canvasSize`) but
      // are kept out of history via
      // `temporal.pause()`/`resume()` instead of relying on this equality
      // check, since reference equality alone can't distinguish "a real
      // user action" from "a server resync"/"a property edit."
      equality: (past, current) =>
        past.items === current.items && past.canvasSize === current.canvasSize,
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
 *
 * U1 (canvas-tools): an effective traversal also PRUNES the selection —
 * any selected id absent from the restored `items` (e.g. undoing a create,
 * or redoing a delete, of a selected item) is dropped, closing the
 * stale-selection class (ghost selections enabling z-order buttons or
 * feeding Delete a nonexistent id) before it can ship. Pruning is the only
 * way a traversal touches `selectedItemIds`: it never restores an old
 * selection (selection is untracked, outside `partialize`), and like
 * `dirty` the write here pushes no history entry of its own.
 */
function markDirtyAndPruneSelection(): void {
  const { items, selectedItemIds } = useCanvasStore.getState()
  const prunedSelection = selectedItemIds.filter((id) =>
    items.some((item) => item.id === id),
  )
  useCanvasStore.setState({
    dirty: true,
    ...(prunedSelection.length !== selectedItemIds.length
      ? { selectedItemIds: prunedSelection }
      : {}),
  })
}

/** U8: true when a traversal actually changed the tracked snapshot — the
 * dirty/prune trigger must cover EITHER tracked reference changing, since a
 * dims-only entry (canvasSize replaced, items untouched) still leaves the
 * canvas diverged from the last saved state. */
function trackedSnapshotChanged(
  beforeItems: CanvasObject[],
  beforeCanvasSize: CanvasSize | null,
): boolean {
  const { items, canvasSize } = useCanvasStore.getState()
  return items !== beforeItems || canvasSize !== beforeCanvasSize
}

export function undo(): void {
  const { items: beforeItems, canvasSize: beforeCanvasSize } = useCanvasStore.getState()
  useCanvasStore.temporal.getState().undo()
  if (trackedSnapshotChanged(beforeItems, beforeCanvasSize)) {
    markDirtyAndPruneSelection()
  }
}

export function redo(): void {
  const { items: beforeItems, canvasSize: beforeCanvasSize } = useCanvasStore.getState()
  useCanvasStore.temporal.getState().redo()
  if (trackedSnapshotChanged(beforeItems, beforeCanvasSize)) {
    markDirtyAndPruneSelection()
  }
}
