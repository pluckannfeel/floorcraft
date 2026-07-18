import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import Konva from 'konva'
import { Layer, Line, Rect, Stage } from 'react-konva'
import { AlignmentGuideLines, boundingBoxForObject, NO_GUIDES, snapDragPosition } from './AlignmentGuides'
import type { GuideLines } from './AlignmentGuides'
import {
  clampGroupDragDelta,
  clientToContainerPoint,
  computePinchZoom,
  computeWheelZoom,
  containerToStagePoint,
  isEditableTarget,
  rectFromPoints,
  rectsIntersect,
  screenToStagePoint,
  SELECTION_CHROME,
  shouldHandleDeleteKey,
  translatePoints,
  unionBoundingBoxes,
} from './coordinates'
import type { BoundingBox, ZoomPanState } from './coordinates'
import { buildClipboardPayload } from './clipboard'
import type { ClipboardPayload } from './clipboard'
import { CropConfirmControls, CropRegionOverlay, useCropTool } from './CropTool'
import { LineAnchorHandles } from './LineAnchorHandles'
import {
  computeLineBoundingBox,
  flattenPoints,
  isLineTool,
  LinePreview,
  parseLinePoints,
  useLineTool,
} from './LineTool'
import { ObjectShape } from './ObjectShape'
import type { GroupDragHandlers, SelectionClickModifiers } from './ObjectShape'
import { SelectionTransformer } from './SelectionTransformer'
import { isShapeTool, ShapePreview, useShapeTool } from './ShapeTool'
import type { ShapeGeometry } from './ShapeTool'
import { isTextType } from './TextTool'
import { expandIdsByGroup } from '../state/canvasStore'
import type { ActiveTool, ItemGeometryPatch } from '../state/canvasStore'
import type { CanvasObject, LineType, Point, ShapeType } from './types'

// U2: left-drag on empty canvas is now the marquee, and panning moved to
// Space+drag / middle-mouse-drag. Konva's default `dragButtons` is `[0, 1]`,
// which would let a middle-button press natively start a drag on any
// draggable node — including an ObjectShape Group under the cursor, which
// would then move WITH the middle-mouse pan our own pointerdown handler
// starts on the Stage. Restricting native drags to the left button keeps
// object dragging exactly as it was (left-drag) while middle-mouse panning
// stays fully imperative (`stage.startDrag()` bypasses this check, and
// Konva ends manual drags on any pointerup regardless of button). Touch is
// unaffected: `touchstart` events carry no `button`, so Konva skips the
// check for them.
Konva.dragButtons = [0]

interface CanvasStageProps {
  width: number
  height: number
  gridSize: number
  objects: CanvasObject[]
  /** U1: the current selection set (ordered id array — see
   * `canvasStore.ts`'s `selectedItemIds` doc for the literal-operand-set
   * contract). */
  selectedItemIds: CanvasObject['id'][]
  /** U1 click routing: a plain click on an object replaces the selection
   * with its GROUP-EXPANDED operand set (U4: `expandIdsByGroup([id])` — a
   * grouped member selects its whole group; U2's marquee passes its full,
   * likewise-expanded hit set; U4's double-click passes the bare `[id]`
   * for member-mode). Wired to the store's `replaceSelection` by the
   * caller — same delegation as `onGeometryChange`/`onDeleteSelected`. */
  onReplaceSelection: (ids: CanvasObject['id'][]) => void
  /** U1/U4 click routing: ctrl(/meta)+click toggles the clicked object's
   * group-expanded id SET in/out of the selection atomically (a
   * one-element set for ungrouped objects — same behavior as U1's
   * single-id toggle). Wired to the store's `toggleIdsInSelection`. */
  onToggleIdsInSelection: (ids: CanvasObject['id'][]) => void
  /** U1 click routing: clicking empty canvas clears the selection. Wired
   * to the store's `clearSelection`. */
  onClearSelection: () => void
  /** Commits a SINGLE object's drag-reposition final geometry to the store
   * (U8). Optional so callers/tests that don't exercise select/drag can
   * omit it. */
  onGeometryChange?: (
    id: CanvasObject['id'],
    patch: Partial<Pick<CanvasObject, 'x' | 'y' | 'width' | 'height' | 'rotation'>>,
  ) => void
  /** U3: commits a whole GESTURE's per-member geometry patches in one call
   * — wired to the store's batched `updateItemsGeometry` (one history entry
   * per gesture). Carries every transform commit (single- and multi-node)
   * and every group-drag commit; Line members ride along via the patch's
   * optional `points` (see `ItemGeometryPatch`). */
  onItemsGeometryChange?: (patches: Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }>) => void
  /** Deletes the WHOLE current selection (U8's Delete/Backspace shortcut,
   * batched over the selection set as of U1). */
  onDeleteSelected?: () => void
  /** U15's drawing-tool mode. Defaults to `'select'` so callers/tests that
   * don't exercise shape drawing can omit it. */
  activeTool?: ActiveTool
  /** Commits a click-drag-sized Shape (U15). The caller is responsible for
   * both creating the item AND resetting `activeTool` back to `'select'`
   * (both are canvasStore concerns CanvasStage itself doesn't reach into,
   * matching how `onGeometryChange`/`onDeleteSelected` delegate their store
   * writes to the caller). */
  onCreateShape?: (type: ShapeType, geometry: ShapeGeometry) => void
  /** Commits a finished (>= 2 points) click-per-point Line (U16). The caller
   * is responsible for both creating the item AND resetting `activeTool`
   * back to `'select'`, same delegation as `onCreateShape`. */
  onCreateLine?: (type: LineType, points: Point[]) => void
  /** Commits a single anchor-handle drag's final point (U17), called on
   * that handle's `dragend`. Optional so callers/tests that don't exercise
   * Line point editing can omit it. */
  onLinePointDragEnd?: (id: CanvasObject['id'], pointIndex: number, point: Point) => void
  /** U11's current Stage scale. Defaults to 1 so callers/tests that don't
   * exercise zoom can omit it. */
  zoom?: number
  /** U11's current Stage x/y (pan offset). Defaults to the origin. */
  stagePosition?: Point
  /** Commits a wheel- or pinch-zoom's new zoom+position together (U11) —
   * both change atomically since zoom-to-point repositions the stage to
   * keep the zoomed-on point fixed under the cursor/fingers. */
  onZoomChange?: (zoom: number, position: Point) => void
  /** Commits a drag-to-pan gesture's final position on `dragend` (U11),
   * mirroring `onGeometryChange`'s commit-on-release convention. */
  onPanEnd?: (position: Point) => void
  /** U5: a right-click on the canvas wants the context menu opened. Fired
   * AFTER the right-click selection rule has been applied (see
   * `resolveContextMenuSelection`), so by the time the caller renders the
   * menu the store's selection already matches what the user visually
   * targeted. `stagePoint` is the click in MODEL coordinates (the
   * context-menu Paste's paste point); `clientPosition` is the raw viewport
   * point the DOM menu is positioned at. */
  onOpenContextMenu?: (request: ContextMenuRequest) => void
  /** U6: an Alt-drop wants the selection DUPLICATED at `dropPoint` (the
   * dragged-to position of the selection's bbox origin). The caller mints
   * via U5's `mintClipboardItems` and commits through ONE tracked
   * `createItemsLocal` (one undo entry removes every duplicate), then
   * selects the minted set — the same mint-and-commit path a paste uses,
   * fed by this payload instead of the clipboard (the clipboard itself is
   * never touched by an Alt-drop). Optional: without it, Alt-drags commit
   * as ordinary moves. */
  onDuplicateSelection?: (payload: ClipboardPayload, dropPoint: Point) => void
  /** U7: a Text-tool click on EMPTY canvas wants a text object created at
   * `point` (raw model coordinates — the caller snaps/clamps, builds the
   * draft, and opens the edit overlay; same delegation as
   * `onCreateShape`/`onCreateLine`). */
  onCreateTextAt?: (point: Point) => void
  /** Escape with no gesture in flight leaves the active tool, returning to
   * the idle pan mode (canvas-tools follow-up). */
  onExitTool?: () => void
  /** Clicking an object while in the idle pan mode engages the select tool
   * (the click's own selection lands through the normal routing). */
  onActivateSelectTool?: () => void
  /** A plain empty-canvas click deselects AND returns to the idle pan mode
   * — the counterpart to `onActivateSelectTool` that closes the loop
   * (enter select by clicking an object, leave it by clicking empty). */
  onBackgroundDeselect?: () => void
  /** U7: an existing TEXT object wants re-editing — a Text-tool click on
   * it, or a double-click with any tool (`resolveObjectDoubleClickAction`).
   * The caller opens the overlay for the id; the routing here has already
   * selected the object. */
  onEditTextObject?: (id: CanvasObject['id']) => void
  /** U7: the id currently being edited through the DOM overlay, if any —
   * that object's Konva node hides (the overlay's textarea IS the visible
   * text during editing, per Konva's official pattern). */
  editingItemId?: CanvasObject['id'] | null
  /** U8: a drawn crop region was CONFIRMED (Enter or the floating Apply
   * button). The caller owns both the store write (`applyCrop` — one
   * tracked entry shifting every coordinate and replacing the dims) and
   * the switch back to the select tool, the same delegation as
   * `onCreateShape`/`onCreateLine`. Optional: without it the crop tool
   * draws but confirm is a no-op (tests that don't exercise crop). */
  onApplyCrop?: (region: BoundingBox) => void
}

/** What `onOpenContextMenu` reports up — see the prop's doc above. */
export interface ContextMenuRequest {
  stagePoint: Point
  clientPosition: Point
}

/** Builds the static grid line coordinates for a `width` x `height` canvas
 * at `gridSize` spacing. Pure so it's trivially memoizable if this ever
 * becomes a perf concern; not memoized yet since the FloorPlan's dimensions
 * don't change at runtime in this unit's scope. */
function buildGridLines(width: number, height: number, gridSize: number): number[][] {
  if (gridSize <= 0) return []
  const lines: number[][] = []
  for (let x = 0; x <= width; x += gridSize) {
    lines.push([x, 0, x, height])
  }
  for (let y = 0; y <= height; y += gridSize) {
    lines.push([0, y, width, y])
  }
  return lines
}

/**
 * U18: sorts `objects` by `z_index` (then `id` as a tiebreaker) — the pure
 * function `CanvasStage` maps to `ObjectShape`s in render order, so a
 * higher `z_index` renders later (i.e. visually on top). Matches the
 * backend `ObjectViewSet` queryset's `('z_index', 'id')` ordering, so a
 * fresh fetch and this store-driven client-side ordering agree. Pulled out
 * as its own exported, Konva-independent function (like `buildGridLines`
 * above) so it's unit-testable without mounting a real Konva `<Stage>` —
 * this codebase's existing tests (e.g. `SelectionTransformer.test.tsx`)
 * avoid mounting Konva trees in jsdom, which has no `<canvas>`
 * implementation, by testing the pure logic a component delegates to
 * instead. Returns a NEW array — never mutates `objects` in place, since
 * that may be the store's own `items` reference and `Array.prototype.sort`
 * sorts in place otherwise.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function sortObjectsByZIndex(objects: CanvasObject[]): CanvasObject[] {
  return [...objects].sort((a, b) => {
    if (a.z_index !== b.z_index) return a.z_index - b.z_index
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * U2: container-space (screen px) movement below which a marquee gesture is
 * treated as a plain CLICK rather than a drag — preserving U1's
 * click-empty-canvas-clears-selection behavior, which as of U2 commits on
 * pointerup instead of pointerdown (a pointerdown clear would wipe the
 * existing selection before a Shift+marquee could union with it). Measured
 * in screen px, not model units, so the click/drag boundary feels the same
 * at every zoom level.
 */
export const MARQUEE_CLICK_THRESHOLD_PX = 4

/**
 * U2's pure marquee hit-test: which object ids does `rect` (model-space)
 * select? Intersection, NOT containment (plan's interaction defaults), and
 * each object's bbox comes from `boundingBoxForObject` — rotated objects use
 * their rotated AABB (`getRotatedBoundingBox`), and Lines derive their bbox
 * from `properties.points` (the stored x/y/width/height is descriptive
 * metadata only), reusing the exact polymorphic dispatch U19's alignment
 * guides already established rather than reimplementing it. Returned ids
 * keep `objects` order, making the hit set deterministic for
 * `replaceSelection` (the store's ordered-array selection contract).
 * Deliberately NOT group-expanded here — this is the raw geometric hit
 * set; `resolveMarqueeCommit` expands it (U4), keeping one hit-test and one
 * expansion boundary.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function selectIdsInRect(rect: BoundingBox, objects: CanvasObject[]): CanvasObject['id'][] {
  return objects
    .filter((object) => rectsIntersect(rect, boundingBoxForObject(object)))
    .map((object) => object.id)
}

/**
 * U2: how a finished marquee's hit set combines with the existing selection.
 * Plain marquee REPLACES; Shift+marquee ADDS (union, stable order: the
 * existing selection's order is preserved, then not-yet-selected hits are
 * appended in their hit order — no duplicates).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function applyMarqueeSelection(
  existing: CanvasObject['id'][],
  hits: CanvasObject['id'][],
  additive: boolean,
): CanvasObject['id'][] {
  if (!additive) return hits
  const union = [...existing]
  for (const id of hits) {
    if (!union.includes(id)) union.push(id)
  }
  return union
}

/** What releasing a marquee should do to the selection — see
 * `resolveMarqueeCommit`. */
export type MarqueeCommitAction =
  | { kind: 'clear' }
  | { kind: 'keep' }
  | { kind: 'select'; ids: CanvasObject['id'][] }

export interface ResolveMarqueeCommitArgs {
  /** Gesture endpoints in CONTAINER space (screen px, pre-zoom/pan) — the
   * space `stage.getPointerPosition()`/`clientToContainerPoint` report in. */
  origin: Point
  current: Point
  zoom: number
  stagePosition: Point
  objects: CanvasObject[]
  selectedItemIds: CanvasObject['id'][]
  /** Shift held at release → add to the existing selection. */
  additive: boolean
}

/**
 * U2: the complete pointerup decision for a marquee gesture, pure so the
 * whole zoom/pan-aware pipeline is unit-testable in jsdom (no Konva).
 *
 * Coordinate spaces, per the plan's single-space rule: the gesture is
 * TRACKED in container/screen space (where pointer events natively live),
 * then converted to model space at exactly one boundary —
 * `containerToStagePoint` on both corners — and ALL hit-testing happens in
 * model space against `boundingBoxForObject`'s model-space bboxes. Nothing
 * ever compares screen-space numbers against model-space numbers.
 *
 * Sub-threshold movement is a click, not a drag: plain click on empty
 * canvas still clears the selection (U1 behavior, preserved), while a
 * Shift+click on empty canvas keeps it (additive gestures never destroy
 * the selection they're adding to).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveMarqueeCommit({
  origin,
  current,
  zoom,
  stagePosition,
  objects,
  selectedItemIds,
  additive,
}: ResolveMarqueeCommitArgs): MarqueeCommitAction {
  const movedPx = Math.max(Math.abs(current.x - origin.x), Math.abs(current.y - origin.y))
  if (movedPx < MARQUEE_CLICK_THRESHOLD_PX) {
    return additive ? { kind: 'keep' } : { kind: 'clear' }
  }
  const rect = rectFromPoints(
    containerToStagePoint(origin, zoom, stagePosition),
    containerToStagePoint(current, zoom, stagePosition),
  )
  // U4: a marquee touching ANY member selects the whole group — the raw
  // geometric hits get group-expanded at this selection-time boundary
  // (same shared helper as the click routing), so the committed selection
  // is already the literal operand set.
  const hits = expandIdsByGroup(selectIdsInRect(rect, objects), objects)
  return { kind: 'select', ids: applyMarqueeSelection(selectedItemIds, hits, additive) }
}

/**
 * U3: everything one group-drag FRAME needs to apply, computed by
 * `resolveGroupDragUpdate` (pure). `draggedPosition` is where the dragged
 * node must be forced (its snapped, collectively-clamped position);
 * `delta` is the shared translation every co-selected member follows —
 * ONE delta for the whole selection is what preserves relative offsets.
 */
export interface GroupDragUpdate {
  draggedPosition: Point
  delta: Point
  guides: GuideLines
}

export interface ResolveGroupDragUpdateArgs {
  draggedId: CanvasObject['id']
  /** The dragged node's current MODEL-space position (`node.x()/node.y()` —
   * layer-local coordinates, which this app never transforms; only the
   * Stage carries zoom/pan). For a dragged LINE member this is the node's
   * position OFFSET (Lines render their absolute points with the node at
   * the origin, so a dragged Line's x/y is exactly the translation so
   * far). */
  nodePosition: Point
  objects: CanvasObject[]
  selectedItemIds: CanvasObject['id'][]
  zoom: number
  gridSize: number
  canvasWidth: number
  canvasHeight: number
}

/**
 * U3's pure per-frame group-drag policy (plan's doc-review-hardened rules):
 *
 * - Snapping: the dragged member's `snapDragPosition` excludes the ENTIRE
 *   selection (never snap against a co-moving member's stale store
 *   position). Alignment-or-grid snap applies only when a BOX member is
 *   the one being dragged; a dragged LINE member skips snapping entirely
 *   (its `nodePosition` is a translation offset, not a box origin — and
 *   the plan allows skipping snap for group drags outright).
 * - Clamping: the DELTA is clamped so the selection's COLLECTIVE bounding
 *   box (union of every member's rotated/points-derived bbox at its STORE
 *   position) stays in bounds — never per-member clamping, which would
 *   distort the arrangement at the canvas edge.
 * - Guides: a snap that the collective clamp then overrides is not shown
 *   (that axis's guide is dropped — the edge isn't actually aligned).
 *
 * Returns `null` when the dragged id isn't in `objects` (mid-delete race)
 * or the selection has no boxes to clamp against.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveGroupDragUpdate({
  draggedId,
  nodePosition,
  objects,
  selectedItemIds,
  zoom,
  gridSize,
  canvasWidth,
  canvasHeight,
}: ResolveGroupDragUpdateArgs): GroupDragUpdate | null {
  const dragged = objects.find((object) => object.id === draggedId)
  if (!dragged) return null
  const selectedIdSet = new Set(selectedItemIds)

  const draggedIsLine = isLineTool(dragged.type)
  const origin: Point = draggedIsLine ? { x: 0, y: 0 } : { x: dragged.x, y: dragged.y }

  let target = nodePosition
  let guides: GuideLines = NO_GUIDES
  if (!draggedIsLine) {
    const snapped = snapDragPosition(
      nodePosition,
      dragged.width,
      dragged.height,
      objects,
      selectedIdSet,
      zoom,
      gridSize,
    )
    target = snapped.point
    guides = snapped.guides
  }

  const collectiveBox = unionBoundingBoxes(
    objects.filter((object) => selectedIdSet.has(object.id)).map(boundingBoxForObject),
  )
  if (!collectiveBox) return null

  const rawDelta = { x: target.x - origin.x, y: target.y - origin.y }
  const delta = clampGroupDragDelta(rawDelta, collectiveBox, canvasWidth, canvasHeight)
  return {
    draggedPosition: { x: origin.x + delta.x, y: origin.y + delta.y },
    delta,
    guides: {
      x: delta.x === rawDelta.x ? guides.x : null,
      y: delta.y === rawDelta.y ? guides.y : null,
    },
  }
}

/**
 * U3's pure dragend commit builder: one patch per selected member, all
 * translated by the SAME final `delta`. Box members patch x/y; Line members
 * patch `points` (translated absolute coordinates — the store folds them
 * into `properties.points`) plus their recomputed descriptive bbox
 * metadata. The caller commits the whole array through ONE
 * `updateItemsGeometry` call — one history entry per group-drag gesture.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildGroupDragPatches(
  delta: Point,
  objects: CanvasObject[],
  selectedItemIds: CanvasObject['id'][],
): Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }> {
  const selectedIdSet = new Set(selectedItemIds)
  const patches: Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }> = []
  for (const object of objects) {
    if (!selectedIdSet.has(object.id)) continue
    if (isLineTool(object.type)) {
      const points = translatePoints(parseLinePoints(object.properties), delta)
      const metadata = points.length > 0 ? computeLineBoundingBox(points) : {}
      patches.push({ id: object.id, patch: { points, ...metadata } })
    } else {
      patches.push({ id: object.id, patch: { x: object.x + delta.x, y: object.y + delta.y } })
    }
  }
  return patches
}

/**
 * U6: one selected member's pre-drag node state, captured at dragstart for
 * the Alt-drop duplicate's IMPERATIVE revert. Box members restore
 * `node.position(position)`; Line members restore their absolute `points`
 * AND a zero `position` (a dragged Line moves via its node's position
 * offset — Konva's own drag — while co-moved Lines move via rewritten
 * points; restoring both covers either role, and a co-moved Line's
 * position was zero all along so re-setting it is harmless).
 */
export interface PreDragMemberState {
  id: CanvasObject['id']
  position: Point
  points: Point[] | null
}

/**
 * U6: captures every selected member's pre-drag state (see
 * `PreDragMemberState`). Called at dragstart — the store's geometry IS the
 * pre-drag truth at that instant (geometry commits on release, so nothing
 * store-side moves during the drag), which is exactly why the Alt-drop
 * revert must be imperative in the first place: on release the originals'
 * store x/y never changed, so a store write would be a no-op and
 * react-konva would never reset value-identical props. This snapshot is
 * what `CanvasStage` plays back onto the live nodes instead.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function captureDragSnapshot(
  objects: CanvasObject[],
  selectedItemIds: CanvasObject['id'][],
): PreDragMemberState[] {
  const selectedIdSet = new Set(selectedItemIds)
  const snapshot: PreDragMemberState[] = []
  for (const object of objects) {
    if (!selectedIdSet.has(object.id)) continue
    if (isLineTool(object.type)) {
      snapshot.push({ id: object.id, position: { x: 0, y: 0 }, points: parseLinePoints(object.properties) })
    } else {
      snapshot.push({ id: object.id, position: { x: object.x, y: object.y }, points: null })
    }
  }
  return snapshot
}

/**
 * U6: what releasing a selection drag commits — an ordinary MOVE (U3's
 * batched geometry patches) or, with Alt held at release, a DUPLICATE:
 * the originals stay untouched (the caller reverts their nodes
 * imperatively and commits NOTHING for them) and a payload minted from the
 * selection lands at `dropPoint` via the U5 clipboard helpers.
 * `dropPoint` is the selection's collective bbox origin translated by the
 * gesture's final delta, so `mintClipboardItems(payload, dropPoint, …)` —
 * whose entries store offsets relative to that same bbox origin —
 * reproduces every member (Line re-absolutization included) exactly where
 * the drag preview showed it.
 */
export type DragEndAction =
  | { kind: 'move'; patches: Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }> }
  | { kind: 'duplicate'; payload: ClipboardPayload; dropPoint: Point }

export interface ResolveDragEndActionArgs {
  draggedId: CanvasObject['id']
  /** The dragged node's final MODEL-space position at release (same
   * convention as `ResolveGroupDragUpdateArgs.nodePosition`: a dragged
   * LINE's position is its translation offset). */
  nodePosition: Point
  /** Alt sampled AT RELEASE — the plan's interaction default. Alt pressed
   * only mid-drag but released before the drop is a plain move; Alt held
   * at release duplicates even if it was pressed mid-drag. */
  altKey: boolean
  objects: CanvasObject[]
  selectedItemIds: CanvasObject['id'][]
}

/**
 * U6's pure dragend decision (the Konva-free core of the Alt-drop
 * duplicate, testable in jsdom like U3's `buildGroupDragPatches`). Returns
 * `null` when the dragged id isn't in `objects` (mid-delete race). A
 * degenerate Alt release whose selection matches no items falls back to
 * the move commit rather than dropping the gesture on the floor.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveDragEndAction({
  draggedId,
  nodePosition,
  altKey,
  objects,
  selectedItemIds,
}: ResolveDragEndActionArgs): DragEndAction | null {
  const dragged = objects.find((object) => object.id === draggedId)
  if (!dragged) return null
  // The dragged node sits at its final (already snapped/clamped — every
  // dragmove frame went through `resolveGroupDragUpdate`) position; the
  // final shared delta falls straight out of it.
  const origin: Point = isLineTool(dragged.type) ? { x: 0, y: 0 } : { x: dragged.x, y: dragged.y }
  const delta: Point = { x: nodePosition.x - origin.x, y: nodePosition.y - origin.y }

  if (altKey) {
    const payload = buildClipboardPayload(selectedItemIds, objects)
    const selectedIdSet = new Set(selectedItemIds)
    const setBox = unionBoundingBoxes(
      objects.filter((object) => selectedIdSet.has(object.id)).map(boundingBoxForObject),
    )
    if (payload && setBox) {
      return {
        kind: 'duplicate',
        payload,
        dropPoint: { x: setBox.x + delta.x, y: setBox.y + delta.y },
      }
    }
  }

  return { kind: 'move', patches: buildGroupDragPatches(delta, objects, selectedItemIds) }
}

/** What a right-click must do to the selection BEFORE the context menu
 * opens — see `resolveContextMenuSelection`. */
export type ContextMenuSelectionAction =
  | { kind: 'keep' }
  | { kind: 'replace'; ids: CanvasObject['id'][] }
  | { kind: 'clear' }

/**
 * U5's right-click selection rule (plan Key Technical Decision), pure for
 * jsdom tests: the menu must always act on what the user visually targeted.
 *
 * - Right-click on an object that is NOT selected → the selection becomes
 *   that object's group-expanded operand set (same `expandIdsByGroup`
 *   boundary as click/marquee routing — a grouped member targets its whole
 *   group), REPLACING whatever was selected before.
 * - Right-click on an already-selected member (of any selection shape,
 *   including member-mode's lone grouped id) → the existing selection is
 *   kept exactly as-is; the menu acts on all of it.
 * - Right-click on empty canvas → the selection clears (the menu is
 *   effectively Paste-only: Copy/Cut/Group/Ungroup all disable without a
 *   selection).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveContextMenuSelection(
  targetId: CanvasObject['id'] | null,
  selectedItemIds: CanvasObject['id'][],
  objects: CanvasObject[],
): ContextMenuSelectionAction {
  if (targetId == null) return { kind: 'clear' }
  if (selectedItemIds.includes(targetId)) return { kind: 'keep' }
  return { kind: 'replace', ids: expandIdsByGroup([targetId], objects) }
}

/**
 * U4's member-mode cue, pure for jsdom tests: when the selection is exactly
 * ONE grouped member (the double-click "member-mode" state — a plain one-id
 * selection, no mode flag), returns the union bounding box of that member's
 * WHOLE group so `CanvasStage` can draw a dashed group-context outline
 * around it — the member's own solid selection chrome nested inside the
 * dashed group outline is what tells the user "you're inside a group"
 * versus a plain single selection. Returns `null` for every other selection
 * shape: ungrouped single selections, any multi-selection (a fully-selected
 * group already reads as a group via the transformer's dashed border), and
 * degenerate one-member "groups" (no surrounding context to show).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveMemberModeGroupBox(
  selectedItemIds: CanvasObject['id'][],
  objects: CanvasObject[],
): BoundingBox | null {
  if (selectedItemIds.length !== 1) return null
  const sole = objects.find((object) => object.id === selectedItemIds[0])
  const key = sole?.group_key
  if (key == null) return null
  const members = objects.filter((object) => object.group_key === key)
  if (members.length < 2) return null
  return unionBoundingBoxes(members.map(boundingBoxForObject))
}

/** What a click on an OBJECT should do — see `resolveObjectClickAction`. */
export type ObjectClickAction =
  | { kind: 'edit-text'; id: CanvasObject['id'] }
  | { kind: 'toggle'; ids: CanvasObject['id'][] }
  | { kind: 'replace'; ids: CanvasObject['id'][] }

/**
 * U1/U4/U7's object-click routing, pure for jsdom tests: with the TEXT tool
 * active, clicking an existing TEXT object re-edits it (the plan's
 * interaction default — the selection also narrows to that object, which
 * the `edit-text` consumer does before opening the overlay); every other
 * click keeps the U1/U4 contract — ctrl(/meta) toggles the clicked object's
 * group-expanded operand set atomically, a plain click replaces the
 * selection with it. Expansion happens HERE, at selection time (the plan's
 * chosen model), so the store's selection is always the literal operand
 * set.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveObjectClickAction(
  id: CanvasObject['id'],
  activeTool: ActiveTool,
  objects: CanvasObject[],
  modifiers?: SelectionClickModifiers,
): ObjectClickAction {
  const target = objects.find((object) => object.id === id)
  if (isTextType(activeTool) && target && isTextType(target.type)) {
    return { kind: 'edit-text', id }
  }
  const operand = expandIdsByGroup([id], objects)
  if (modifiers?.ctrlKey || modifiers?.metaKey) {
    return { kind: 'toggle', ids: operand }
  }
  return { kind: 'replace', ids: operand }
}

/**
 * Should the Stage be draggable (i.e. will a plain drag pan)? The ONE
 * expression behind both the `draggable` prop and every imperative restore
 * after a per-gesture enable — they MUST agree, since react-konva only
 * re-applies the prop when it changes between renders: restoring to a
 * stale value (once: just `spaceHeld`) left the Stage non-draggable while
 * the prop still read `true`, so pan mode worked exactly once per tool
 * switch.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isStageDraggable(activeTool: ActiveTool, spaceHeld: boolean): boolean {
  return spaceHeld || activeTool === 'pan'
}

/** What a double-click on an object should do — see
 * `resolveObjectDoubleClickAction`. */
export type ObjectDoubleClickAction =
  | { kind: 'edit-text'; id: CanvasObject['id'] }
  | { kind: 'member-mode'; id: CanvasObject['id'] }
  | { kind: 'none' }

/**
 * U4/U7's double-click routing, pure for jsdom tests: a TEXT object
 * re-edits (the overlay opens; the selection narrows to just it — for a
 * grouped text member this doubles as U4's member-mode, which is exactly a
 * one-id selection); a non-text GROUP MEMBER enters member-mode (U4);
 * anything else is a no-op (a plain click already selected it).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveObjectDoubleClickAction(
  id: CanvasObject['id'],
  objects: CanvasObject[],
): ObjectDoubleClickAction {
  const target = objects.find((object) => object.id === id)
  if (!target) return { kind: 'none' }
  if (isTextType(target.type)) return { kind: 'edit-text', id }
  if (target.group_key != null) return { kind: 'member-mode', id }
  return { kind: 'none' }
}

interface UseMarqueeArgs {
  zoom: number
  stagePosition: Point
  objects: CanvasObject[]
  selectedItemIds: CanvasObject['id'][]
  onReplaceSelection: (ids: CanvasObject['id'][]) => void
  onClearSelection: () => void
  /** See the same-named field on `CanvasStageProps`: a plain empty-canvas
   * click deselects and returns to the idle pan mode. */
  onBackgroundDeselect?: () => void
}

/**
 * U2: drives the marquee-select gesture (Select tool, plain left-drag on
 * empty canvas). Mirrors `useShapeTool`/`useLineTool`'s split: this hook is
 * the Konva-free state machine (begin → update* → commit | cancel), tested
 * directly with `renderHook`; `CanvasStage` wires pointer/keyboard events
 * into it. All points passed in are CONTAINER-space (screen px); the
 * returned `rect` is MODEL-space, ready to render on a stage-transformed
 * layer — `resolveMarqueeCommit` documents the single conversion boundary.
 *
 * `cancel` (Escape mid-marquee) discards the gesture WITHOUT touching the
 * selection; `commit` (pointerup) resolves clear/keep/select per
 * `resolveMarqueeCommit`. A Space press mid-gesture is simply never routed
 * here (the gesture locks at pointerdown — `CanvasStage`'s pan handling
 * only consults Space state at pointerdown time).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useMarquee({
  zoom,
  stagePosition,
  objects,
  selectedItemIds,
  onReplaceSelection,
  onClearSelection,
  onBackgroundDeselect,
}: UseMarqueeArgs) {
  const [gesture, setGesture] = useState<{ origin: Point; current: Point } | null>(null)

  const begin = useCallback((containerPoint: Point) => {
    setGesture({ origin: containerPoint, current: containerPoint })
  }, [])

  const update = useCallback((containerPoint: Point) => {
    setGesture((active) => (active ? { ...active, current: containerPoint } : active))
  }, [])

  const cancel = useCallback(() => setGesture(null), [])

  const commit = useCallback(
    (additive: boolean) => {
      if (!gesture) return
      const action = resolveMarqueeCommit({
        origin: gesture.origin,
        current: gesture.current,
        zoom,
        stagePosition,
        objects,
        selectedItemIds,
        additive,
      })
      if (action.kind === 'clear') {
        // A plain empty-canvas click: deselect AND drop back to the idle
        // pan mode (mirrors Escape). `onBackgroundDeselect` owns both;
        // `onClearSelection` is the bare fallback for tests.
        ;(onBackgroundDeselect ?? onClearSelection)()
      } else if (action.kind === 'select') {
        onReplaceSelection(action.ids)
      }
      setGesture(null)
    },
    [
      gesture,
      zoom,
      stagePosition,
      objects,
      selectedItemIds,
      onReplaceSelection,
      onClearSelection,
      onBackgroundDeselect,
    ],
  )

  // Model-space rect for rendering: converted per-render from the tracked
  // container-space endpoints, so a mid-gesture wheel-zoom keeps the drawn
  // rect under the pointer (screen-anchored) and the commit hit-test uses
  // the same conversion.
  const rect = gesture
    ? rectFromPoints(
        containerToStagePoint(gesture.origin, zoom, stagePosition),
        containerToStagePoint(gesture.current, zoom, stagePosition),
      )
    : null

  return { isActive: gesture != null, rect, begin, update, commit, cancel }
}

/**
 * 3-layer Konva Stage (grid/background, interactive Objects, UI overlay) —
 * NOT the originally-discussed 4-layer grid/structural/interactive/UI split.
 * Per the plan's Key Technical Decisions: once Objects were unified into one
 * model/array, a separate "structural" layer would have no distinct content
 * to hold (e.g. "outlines" is just another catalog type living alongside
 * everything else in the interactive layer), so it's dropped.
 *
 * The UI overlay layer holds the Transformer (U8) and, as of this unit,
 * alignment guides (U19).
 */
export const CanvasStage = forwardRef<Konva.Stage, CanvasStageProps>(function CanvasStage(
  {
    width,
    height,
    gridSize,
    objects,
    selectedItemIds,
    onReplaceSelection,
    onToggleIdsInSelection,
    onClearSelection,
    onGeometryChange,
    onItemsGeometryChange,
    onDeleteSelected,
    activeTool = 'select',
    onCreateShape,
    onCreateLine,
    onLinePointDragEnd,
    zoom = 1,
    stagePosition = { x: 0, y: 0 },
    onZoomChange,
    onPanEnd,
    onOpenContextMenu,
    onDuplicateSelection,
    onCreateTextAt,
    onExitTool,
    onActivateSelectTool,
    onBackgroundDeselect,
    onEditTextObject,
    editingItemId = null,
    onApplyCrop,
  },
  ref,
) {
  const gridLines = buildGridLines(width, height, gridSize)
  const drawingShape = isShapeTool(activeTool)
  const drawingLine = isLineTool(activeTool)
  const textToolActive = isTextType(activeTool)
  const croppingTool = activeTool === 'crop'
  // The idle "no tool engaged" mode (canvas-tools follow-up): a plain drag
  // navigates, exactly like Space+drag from any other mode. Deselecting any
  // tool lands here, so it must behave like Space-held: the Stage is
  // draggable and the objects layer stops listening (a drag starting over
  // an object pans instead of moving it).
  const panTool = activeTool === 'pan'

  // U2: plain drag on empty canvas is the marquee now; panning is
  // pan-active-only. The Stage is natively `draggable` ONLY while Space is
  // held (window key listeners below); middle-mouse and touch gestures
  // enable dragging imperatively per-event inside `onPointerDown` — a React
  // state toggle commits too late for the same pointerdown to start a Konva
  // drag.
  const [spaceHeld, setSpaceHeld] = useState(false)
  // The ONE truth for the Stage's `draggable`, used by the prop AND by
  // every imperative restore below. They must agree: react-konva only
  // re-applies the prop when it CHANGES between renders, so restoring to a
  // stale expression (e.g. just `spaceHeld`) leaves the Stage stuck
  // non-draggable while the prop still reads `true` — which is exactly how
  // pan-mode panning died after its first drag.
  const stageDraggable = isStageDraggable(activeTool, spaceHeld)
  // U2: whether a stage pan drag is actually in flight — drives the
  // grab (pan available) vs grabbing (panning) cursor distinction.
  const [panDragging, setPanDragging] = useState(false)

  // U2: internal handle on the Stage, merged with the forwarded ref — the
  // cursor effect and the marquee's window-level pointermove need
  // `stage.container()` outside any Konva event callback.
  const stageRef = useRef<Konva.Stage | null>(null)
  const setStageRef = useCallback(
    (node: Konva.Stage | null) => {
      stageRef.current = node
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [ref],
  )

  // U2: Space-held pan state. Window-level (Konva Stages aren't natively
  // focusable, same rationale as the Delete/Escape listener below), guarded
  // by `isEditableTarget` so typing a space into the property panel or the
  // floor-plan name field never hijacks the key. `keyup` and window `blur`
  // (e.g. Alt-Tab away mid-hold) both release, so the stage can't get stuck
  // draggable.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.code !== 'Space') return
      const activeElement = document.activeElement as HTMLElement | null
      if (isEditableTarget(activeElement?.tagName, activeElement?.isContentEditable ?? false)) return
      // Own the key: without this the page scrolls (and a focused button
      // would activate) on every Space press over the editor.
      event.preventDefault()
      setSpaceHeld(true)
    }
    function handleKeyUp(event: KeyboardEvent) {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    function handleWindowBlur() {
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [])

  // U11: two-finger pinch-zoom state. Kept in a ref (not React state) since
  // it's write-only bookkeeping between consecutive `touchmove` events, not
  // something any render depends on — same rationale as `shapeNodesRef`
  // below for why this is a ref instead of state.
  const pinchRef = useRef<{ lastDistance: number } | null>(null)

  // U17/U1: the "which selection UI to show" branch point. Anchor handles
  // render ONLY when exactly one item is selected and it's a Line — Lines
  // have no box to resize (see `ObjectShape.tsx`'s Line branch). Every
  // other selection shape (exactly-one non-line, and any multi-selection)
  // routes to `SelectionTransformer`, which in U1 attaches only for
  // exactly-one selections (U3 adds the true multi-node transformer). The
  // branch lives here (not inside `ObjectShape`) because
  // `SelectionTransformer` itself is already only ever rendered once, at
  // this Stage level, resolving selected nodes from the same
  // `shapeNodesRef` Map `ObjectShape`'s `shapeRef` populates.
  const soleSelectedId = selectedItemIds.length === 1 ? selectedItemIds[0] : null
  const selectedObject =
    soleSelectedId != null ? (objects.find((object) => object.id === soleSelectedId) ?? null) : null
  const selectedIsLine = selectedObject != null && isLineTool(selectedObject.type)

  // U1/U4/U7: selection click routing — the whole decision is pure
  // (`resolveObjectClickAction`): plain click REPLACES the selection with
  // the clicked object's group-expanded set, ctrl(/meta)+click TOGGLES it
  // atomically, and a Text-tool click on an existing TEXT object re-edits
  // it (selecting just that object first, so the overlay always edits the
  // visually-targeted, selected item).
  const handleObjectSelect = (id: CanvasObject['id'], modifiers?: SelectionClickModifiers) => {
    const action = resolveObjectClickAction(id, activeTool, objects, modifiers)
    // Clicking an object from the idle pan mode means "I want to work on
    // this one": hand the canvas to the select tool, with the click's own
    // selection (resolved below) landing as usual — no second click needed.
    if (panTool) onActivateSelectTool?.()
    if (action.kind === 'edit-text') {
      onReplaceSelection([action.id])
      onEditTextObject?.(action.id)
    } else if (action.kind === 'toggle') {
      onToggleIdsInSelection(action.ids)
    } else {
      onReplaceSelection(action.ids)
    }
  }

  // U4/U7: double-click routing, pure via `resolveObjectDoubleClickAction`:
  // a TEXT object re-edits through the overlay; a non-text group member
  // enters MEMBER-MODE — the selection narrows to JUST that member (a plain
  // one-id selection; there is no mode flag, so any outside click/marquee
  // naturally restores group-level behavior by re-expanding). The
  // double-click's constituent clicks also fired `handleObjectSelect`
  // (browsers dispatch click, click, dblclick) — that ordering is expected
  // and harmless: the first click selects the whole group, the second
  // re-selects it, and this narrows/edits. Ungrouped non-text objects need
  // no narrowing (a plain click already selected exactly them): no-op.
  const handleObjectDoubleClick = (id: CanvasObject['id']) => {
    const action = resolveObjectDoubleClickAction(id, objects)
    if (action.kind === 'edit-text') {
      onReplaceSelection([action.id])
      onEditTextObject?.(action.id)
    } else if (action.kind === 'member-mode') {
      onReplaceSelection([action.id])
    }
  }

  // U4's member-mode cue: the dashed group-context outline drawn while
  // exactly one grouped member is selected (see resolveMemberModeGroupBox).
  const memberModeGroupBox = resolveMemberModeGroupBox(selectedItemIds, objects)

  // U2: the marquee gesture state machine (see `useMarquee`'s doc).
  // `onPointerDown` begins it; move/release/Escape are handled by the
  // window-level listeners below, NOT Stage handlers — Konva's Stage pointer
  // events stop firing once the pointer leaves the canvas element (the same
  // out-of-canvas-release problem `shapeTool`'s window pointerup solves),
  // and a single owner avoids double-committing when the release happens
  // over the canvas.
  const marquee = useMarquee({
    zoom,
    stagePosition,
    objects,
    selectedItemIds,
    onReplaceSelection,
    onClearSelection,
    onBackgroundDeselect,
  })

  // Latest-value ref so the gesture-scoped window listeners (registered
  // once per gesture, below) always dispatch into the current render's
  // hook callbacks instead of stale closures.
  const marqueeRef = useRef(marquee)
  useEffect(() => {
    marqueeRef.current = marquee
  })

  const marqueeActive = marquee.isActive
  useEffect(() => {
    if (!marqueeActive) return undefined
    function handleWindowPointerMove(event: PointerEvent) {
      const stage = stageRef.current
      if (!stage) return
      marqueeRef.current.update(clientToContainerPoint(stage, event.clientX, event.clientY))
    }
    function handleWindowPointerUp(event: PointerEvent) {
      // Only the primary button's release ends the gesture (releasing a
      // middle/right button pressed mid-marquee must not commit early).
      if (event.button !== 0) return
      // Shift is sampled at release (same convention as U6's
      // Alt-at-release): plain marquee replaces, Shift+marquee adds.
      marqueeRef.current.commit(event.shiftKey)
    }
    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      // Escape ownership (plan's documented priority order, innermost
      // first): text overlay → context menu → crop region →
      // marquee-in-progress → line-draw finish. This listener only exists
      // while a marquee is in progress, and a marquee can only start with
      // the Select tool active, so it can never race the line-draw Escape
      // in the keydown effect below (line tools never have an active
      // marquee).
      event.stopPropagation()
      marqueeRef.current.cancel()
    }
    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerUp)
    window.addEventListener('keydown', handleWindowKeyDown)
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('keydown', handleWindowKeyDown)
    }
  }, [marqueeActive])

  // U8: the crop gesture state machine (see `useCropTool`'s doc in
  // CropTool.tsx). `onPointerDown` begins it; move/release live on
  // window-level listeners below for the same out-of-canvas-release reason
  // as the marquee's; Enter/Escape have their own listener while a gesture
  // or pending region exists.
  const crop = useCropTool({
    zoom,
    stagePosition,
    canvasWidth: width,
    canvasHeight: height,
    onApplyCrop,
  })

  // Latest-value ref, same rationale as `marqueeRef` above.
  const cropRef = useRef(crop)
  useEffect(() => {
    cropRef.current = crop
  })

  const cropDrawing = crop.isDrawing
  useEffect(() => {
    if (!cropDrawing) return undefined
    function handleWindowPointerMove(event: PointerEvent) {
      const stage = stageRef.current
      if (!stage) return
      cropRef.current.update(clientToContainerPoint(stage, event.clientX, event.clientY))
    }
    function handleWindowPointerUp(event: PointerEvent) {
      // Only the primary button's release ends the drag (same guard as the
      // marquee's window pointerup).
      if (event.button !== 0) return
      cropRef.current.release()
    }
    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerUp)
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
    }
  }, [cropDrawing])

  // U8: Enter confirms / Escape cancels while a crop gesture or pending
  // region exists (the floating Apply/Cancel buttons drive the same
  // confirm/cancel). Escape ownership (plan's documented priority order,
  // innermost first): text overlay → context menu → crop region →
  // marquee-in-progress → line-draw finish. The overlay/menu both sit above
  // this and stop propagation from their own handlers; the marquee and
  // line-draw sit below and can never coexist with a crop gesture (both
  // require a different active tool, and `onContextMenu` below suppresses
  // the menu entirely while the crop tool is active so a menu can't open
  // OVER a pending region either) — so this listener existing only while a
  // crop gesture/region is live keeps the order correct by construction.
  const cropActive = crop.isDrawing || crop.isPending
  useEffect(() => {
    if (!cropActive) return undefined
    function handleWindowKeyDown(event: KeyboardEvent) {
      const activeElement = document.activeElement as HTMLElement | null
      if (isEditableTarget(activeElement?.tagName, activeElement?.isContentEditable ?? false)) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        cropRef.current.cancel()
      } else if (event.key === 'Enter' && cropRef.current.isPending) {
        event.preventDefault()
        cropRef.current.confirm()
      }
    }
    window.addEventListener('keydown', handleWindowKeyDown)
    return () => window.removeEventListener('keydown', handleWindowKeyDown)
  }, [cropActive])

  // U8: leaving the crop tool (Toolbar toggle, confirm's switch back to
  // select) discards any in-progress gesture/region — the preview must
  // never outlive the tool.
  useEffect(() => {
    if (!croppingTool) cropRef.current.cancel()
  }, [croppingTool])

  // U2 cursor language: crosshair while a marquee is being drawn and for
  // the Crop tool (U8 — the plan's cursor spec groups them);
  // grab/grabbing while pan is available/active (Space held or an actual
  // pan drag, including middle-mouse); I-beam for the Text tool over the
  // canvas (U7); default arrow otherwise (the plan explicitly allows
  // keeping the arrow for the idle Select tool).
  useEffect(() => {
    const container = stageRef.current?.container()
    if (!container) return
    // One cursor per interaction mode (canvas-tools follow-up: every tool
    // gets a cursor that names what a press will do). Order matters —
    // in-flight gestures beat mode defaults.
    container.style.cursor = panDragging
      ? 'grabbing'
      : marqueeActive || croppingTool || drawingShape || drawingLine
        ? 'crosshair'
        : spaceHeld || panTool
          ? 'grab'
          : textToolActive
            ? 'text'
            : ''
  }, [
    marqueeActive,
    croppingTool,
    drawingShape,
    drawingLine,
    panDragging,
    spaceHeld,
    panTool,
    textToolActive,
  ])

  // Map<id, Konva.Node> resolving the selected item's live node for
  // SelectionTransformer's `.nodes([ref])` attach — populated/cleared by
  // each ObjectShape's `shapeRef` callback as items mount/unmount.
  const shapeNodesRef = useRef(new Map<CanvasObject['id'], Konva.Node>())

  // U5: which Object a right-click landed on. Konva reports the innermost
  // hit node (an ObjectShape Group's child Rect/Text, or a Line node
  // itself), so walk up the parent chain until a node registered in
  // `shapeNodesRef` is found — the same registry every other node-to-id
  // need already uses. Returns null for the stage/grid (empty canvas).
  const findObjectIdForNode = (target: Konva.Node, stage: Konva.Stage): CanvasObject['id'] | null => {
    let node: Konva.Node | null = target
    while (node && node !== stage) {
      for (const [id, candidate] of shapeNodesRef.current) {
        if (candidate === node) return id
      }
      node = node.getParent()
    }
    return null
  }

  // U19: the currently-matched alignment guide(s), reported up by whichever
  // ObjectShape is being dragged or by SelectionTransformer during a resize,
  // on every dragmove/transform frame; reset to `NO_GUIDES` on
  // dragend/transformend. Plain `useState` (not a ref) since this drives
  // what `AlignmentGuideLines` renders below — re-rendering every drag frame
  // is the accepted, unthrottled cost the plan flags (Risks & Dependencies).
  const [guides, setGuides] = useState<GuideLines>(NO_GUIDES)

  // U3: group drag — dragging any member of a 2+ selection moves the whole
  // selection as one. `ObjectShape` relays the dragged member's
  // dragstart/dragmove/dragend here (see `GroupDragHandlers`); these
  // handlers are the
  // thin Konva plumbing around the pure policy in `resolveGroupDragUpdate`/
  // `resolveDragEndAction` above: per frame, force the dragged node to its
  // snapped+collectively-clamped position and apply the SAME delta to every
  // co-selected node imperatively via `shapeNodesRef` (never a Konva.Group
  // re-parent, never `shouldOverdrawWholeArea` — the plan's Key Technical
  // Decision; `SelectionTransformer`'s attach effect also unbinds Konva's
  // own proxy-drag so nothing fights this). Co-moved LINE members translate
  // by rewriting their `points` (the `LineAnchorHandles` onDragMove
  // pattern), never via node.x()/y() — a Line's position isn't a React
  // prop, so an offset would survive the commit and double the translation.
  //
  // U6: the relay also covers a SOLE-selected box object (not just 2+
  // selections), so "Alt-dragging a selection drops a duplicate" has ONE
  // code path whatever the selection size: dragstart captures the
  // imperative-revert snapshot, dragmove runs the same snap/clamp policy
  // (identical to the old per-node `dragBoundFunc` for a 1-selection:
  // snapping excludes exactly the object itself, and the collective bbox
  // IS its own bbox), and dragend samples Alt at release. A sole-selected
  // LINE still gets no relay — it stays non-draggable, anchor-only (U17);
  // dragging an UNSELECTED object keeps the plain `dragBoundFunc` +
  // `onGeometryChange` path (a drag never selects, so Alt-dragging an
  // unselected object is an ordinary move — the duplicate source is
  // always THE SELECTION, mirroring what the context menu acts on).
  const dragRelayFor = (object: CanvasObject): GroupDragHandlers | undefined =>
    selectedItemIds.includes(object.id) &&
    (selectedItemIds.length >= 2 || !isLineTool(object.type))
      ? groupDragHandlers
      : undefined

  // U6: the pre-drag snapshot for the Alt-drop revert, captured at
  // dragstart. A ref (not state): it's per-gesture bookkeeping no render
  // depends on — same rationale as `pinchRef`.
  const preDragSnapshotRef = useRef<PreDragMemberState[] | null>(null)

  // U6: plays a pre-drag snapshot back onto the live nodes — the
  // IMPERATIVE revert (see `captureDragSnapshot`'s doc for why a store
  // write can't do this). Line members restore points first, then
  // position; box members restore position (React re-applies the same
  // values harmlessly on the next render since they equal the store's).
  const restoreDragSnapshot = (snapshot: PreDragMemberState[]) => {
    for (const member of snapshot) {
      const memberNode = shapeNodesRef.current.get(member.id)
      if (!memberNode) continue
      if (member.points) {
        ;(memberNode as Konva.Line).points(flattenPoints(member.points))
      }
      memberNode.position(member.position)
    }
  }

  const applyGroupDelta = (draggedId: CanvasObject['id'], delta: Point) => {
    for (const member of objects) {
      if (member.id === draggedId || !selectedItemIds.includes(member.id)) continue
      const memberNode = shapeNodesRef.current.get(member.id)
      if (!memberNode) continue
      if (isLineTool(member.type)) {
        ;(memberNode as Konva.Line).points(
          flattenPoints(translatePoints(parseLinePoints(member.properties), delta)),
        )
      } else {
        memberNode.position({ x: member.x + delta.x, y: member.y + delta.y })
      }
    }
  }

  const groupDragHandlers: GroupDragHandlers = {
    onDragStart: () => {
      // U6: capture every selected member's pre-drag state for the
      // Alt-drop revert. The dragged id is always selected (the relay is
      // only passed to selected members), so it's in the snapshot too.
      preDragSnapshotRef.current = captureDragSnapshot(objects, selectedItemIds)
    },
    onDragMove: (draggedId, node) => {
      const update = resolveGroupDragUpdate({
        draggedId,
        nodePosition: { x: node.x(), y: node.y() },
        objects,
        selectedItemIds,
        zoom,
        gridSize,
        canvasWidth: width,
        canvasHeight: height,
      })
      if (!update) return
      setGuides(update.guides)
      node.position(update.draggedPosition)
      applyGroupDelta(draggedId, update.delta)
      node.getLayer()?.batchDraw()
    },
    onDragEnd: (draggedId, node, altKey) => {
      setGuides(NO_GUIDES)
      const snapshot = preDragSnapshotRef.current
      preDragSnapshotRef.current = null
      // U6: the whole release decision is pure (`resolveDragEndAction`).
      // Alt is sampled HERE, from the release event — Alt pressed mid-drag
      // but released before the drop is a plain move; Alt held at release
      // duplicates. The duplicate path is gated on the caller actually
      // wiring `onDuplicateSelection` so Alt-drags stay ordinary moves for
      // callers/tests that don't.
      const action = resolveDragEndAction({
        draggedId,
        nodePosition: { x: node.x(), y: node.y() },
        altKey: altKey && onDuplicateSelection != null,
        objects,
        selectedItemIds,
      })
      if (!action) return

      if (action.kind === 'duplicate') {
        // U6 Alt-drop, in the plan's mandated order: (a) IMPERATIVELY
        // restore every selected node to its pre-drag state (the store
        // never changed during the drag, so only the nodes are out of
        // place — see `captureDragSnapshot`); (b) commit NOTHING for the
        // originals (the U3 move commit below is skipped entirely);
        // (c) hand the payload+drop point up — the caller mints fresh
        // items in ONE tracked entry and selects them. The dragstart
        // snapshot is always present in practice; the store-derived
        // fallback is byte-identical since geometry commits on release.
        restoreDragSnapshot(snapshot ?? captureDragSnapshot(objects, selectedItemIds))
        node.getLayer()?.batchDraw()
        onDuplicateSelection?.(action.payload, action.dropPoint)
        return
      }

      // A dragged LINE moved via its node's position offset (Konva's own
      // drag) — bake the translation into its points and zero the offset in
      // this same dragend, BEFORE the store commit re-renders: the
      // committed points already carry the translation, and a surviving
      // offset would apply it twice (Line x/y aren't React-controlled).
      const dragged = objects.find((object) => object.id === draggedId)
      if (dragged && isLineTool(dragged.type)) {
        const committedPoints = action.patches.find((patch) => patch.id === draggedId)?.patch.points
        if (committedPoints) (node as Konva.Line).points(flattenPoints(committedPoints))
        node.position({ x: 0, y: 0 })
      }
      // ONE batched store action for the whole gesture — a single undo
      // entry restores every member (AE2).
      onItemsGeometryChange?.(action.patches)
    },
  }

  // U15: click-drag-to-size Shape drawing. `onCommit` fires on pointerup
  // with the finished (snapped/clamped) geometry; the caller (CanvasEditorPage)
  // both creates the item and resets `activeTool` back to `'select'`.
  const shapeTool = useShapeTool({
    gridSize,
    canvasWidth: width,
    canvasHeight: height,
    onCommit: (type, geometry) => onCreateShape?.(type, geometry),
  })

  // U16: click-per-point Line drawing. `onCommit` fires on finish (double-
  // click or Escape) only when >= 2 points were placed; the caller both
  // creates the item and resets `activeTool` back to `'select'`.
  const lineTool = useLineTool({
    gridSize,
    canvasWidth: width,
    canvasHeight: height,
    onCommit: (type, points) => onCreateLine?.(type, points),
  })

  // U8: Delete/Backspace removes the selected item. U16: Escape finishes
  // (commits-if-valid, else discards) an in-progress Line draw — takes
  // priority over Delete/Backspace's own handling since they're unrelated
  // keys; both live on the same window-level listener (not a Stage keydown
  // handler) since Konva Stages aren't natively focusable/don't receive
  // keyboard events by default.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const activeElement = document.activeElement as HTMLElement | null
      // Code-review fix: the Escape branch shares the same "is the user
      // typing?" guard as Delete/Backspace — Escape pressed to leave a
      // property-panel or name field mid-line-draw must not also commit
      // the half-drawn line.
      if (
        isEditableTarget(activeElement?.tagName, activeElement?.isContentEditable ?? false)
      ) {
        return
      }
      if (event.key === 'Escape') {
        // Escape ownership (documented order: text overlay -> context menu
        // -> crop region -> marquee -> line-draw -> EXIT TOOL). The inner
        // consumers own their own gesture-scoped listeners; this handler
        // covers the line draw and, when nothing is in flight, exiting the
        // active tool back to idle/pan (canvas-tools follow-up).
        if (drawingLine) {
          lineTool.finishDraw()
          return
        }
        if (cropActive || marquee.isActive) return
        if (!panTool) onExitTool?.()
        return
      }
      if (shouldHandleDeleteKey(event.key, selectedItemIds, activeElement?.tagName, activeElement?.isContentEditable)) {
        onDeleteSelected?.()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // `lineTool.finishDraw` is the only piece of `lineTool` this effect
    // calls; `useLineTool` doesn't memoize the object it returns, so
    // depending on the whole `lineTool` value would re-subscribe this
    // listener every render for no behavioral difference (same rationale as
    // the `shapeTool` window-pointerup effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedItemIds,
    onDeleteSelected,
    drawingLine,
    lineTool.finishDraw,
    cropActive,
    marquee.isActive,
    panTool,
    onExitTool,
  ])

  // U15 safety net: Konva's Stage pointer events only fire while the
  // pointer is over the canvas element, so a drag released outside the
  // canvas (e.g. the user drags past the edge before releasing) would never
  // reach the Stage's own `onPointerUp` and leave the draw stuck forever.
  // Same pattern as `Sidebar.tsx`'s window-level `pointerup` fallback for
  // its own out-of-canvas drag-end case.
  useEffect(() => {
    if (!shapeTool.isDrawing) return undefined
    function handleWindowPointerUp() {
      shapeTool.endDraw()
    }
    window.addEventListener('pointerup', handleWindowPointerUp)
    return () => window.removeEventListener('pointerup', handleWindowPointerUp)
    // `shapeTool.endDraw` is already listed and is the only piece of
    // `shapeTool` this effect calls; `useShapeTool` doesn't memoize the
    // object it returns, so depending on the whole `shapeTool` value would
    // re-subscribe this listener every render for no behavioral difference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeTool.isDrawing, shapeTool.endDraw])

  return (
    <>
    <Stage
      ref={setStageRef}
      width={width}
      height={height}
      scaleX={zoom}
      scaleY={zoom}
      x={stagePosition.x}
      y={stagePosition.y}
      draggable={stageDraggable}
      onDragStart={(event) => {
        // Only the Stage's own drag is a pan — an Object's dragstart fires
        // on the Object node, not the Stage (Konva dispatches drag events on
        // the node actually being dragged), so this guard filters the
        // bubbled ones.
        const stage = event.target.getStage()
        if (!stage || event.target !== stage) return
        setPanDragging(true)
      }}
      onDragEnd={(event) => {
        // Only the Stage's own drag (pan) should reach here — an Object's
        // drag (`ObjectShape.tsx`'s Group) fires `dragend` on that Group.
        // The `event.target === stage` guard filters bubbled child drags.
        const stage = event.target.getStage()
        if (!stage || event.target !== stage) return
        setPanDragging(false)
        // Restore prop-truth after the imperative per-gesture enables
        // (middle-mouse/touch, below): react-konva only re-applies
        // `draggable` when the PROP changes between renders, so both an
        // imperative `draggable(true)` and a restore to the WRONG value
        // stick until some unrelated prop change — hence `stageDraggable`,
        // the same expression the prop uses.
        stage.draggable(stageDraggable)
        onPanEnd?.({ x: stage.x(), y: stage.y() })
      }}
      onWheel={(event) => {
        // Standard Konva zoom-on-wheel recipe: prevent the page from
        // scrolling, read the pointer's container-relative position, and
        // delegate the point-anchored math to `coordinates.ts`'s pure
        // `computeWheelZoom` so this handler stays thin plumbing.
        event.evt.preventDefault()
        const stage = event.target.getStage()
        if (!stage) return
        const pointer = stage.getPointerPosition()
        if (!pointer) return
        const next = computeWheelZoom({ zoom, position: stagePosition }, pointer, event.evt.deltaY)
        onZoomChange?.(next.zoom, next.position)
      }}
      onTouchMove={(event) => {
        // U11: two-finger pinch-to-zoom (R10's touch-support requirement).
        // Single-finger touch drag already pans via the Stage's own
        // `draggable` handling above — this only takes over once a SECOND
        // touch point appears.
        const touches = event.evt.touches
        if (touches.length !== 2) return
        event.evt.preventDefault()
        const stage = event.target.getStage()
        if (!stage) return
        const toContainerPoint = (touch: Touch): Point =>
          clientToContainerPoint(stage, touch.clientX, touch.clientY)
        const p1 = toContainerPoint(touches[0])
        const p2 = toContainerPoint(touches[1])
        const center: Point = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
        const distance = Math.hypot(p2.x - p1.x, p2.y - p1.y)

        const previous = pinchRef.current
        pinchRef.current = { lastDistance: distance }
        if (!previous || previous.lastDistance === 0) return

        // If a single-finger pan was already underway when the second
        // finger touched down, stop it first — Konva's own pinch sandbox
        // does the same, since dragging and pinching the Stage at once
        // would fight over its x/y.
        if (stage.isDragging()) stage.stopDrag()

        const current: ZoomPanState = { zoom, position: stagePosition }
        const next = computePinchZoom(current, center, distance / previous.lastDistance)
        onZoomChange?.(next.zoom, next.position)
      }}
      onTouchEnd={(event) => {
        if (event.evt.touches.length < 2) pinchRef.current = null
      }}
      onPointerDown={(event) => {
        const stage = event.target.getStage()
        if (!stage) return

        // U2: middle-mouse pan — works from any tool and over any target.
        // The `draggable` toggle + `startDrag()` must be imperative in this
        // same event: a React state commit lands too late for this
        // pointerdown to start a Konva drag. `preventDefault` suppresses
        // the browser's middle-click autoscroll. `Konva.dragButtons = [0]`
        // (module scope, above) keeps this press from ALSO starting a
        // native drag on a draggable Object under the cursor. Ignored
        // mid-marquee — the marquee gesture locks at its own pointerdown.
        if (event.evt.button === 1) {
          event.evt.preventDefault()
          if (!marquee.isActive) {
            stage.draggable(true)
            stage.startDrag()
          }
          return
        }

        // U2: Space-held pan owns the gesture — the Stage is already
        // `draggable` via the prop, so Konva's own drag bookkeeping takes
        // this pointerdown; nothing below (drawing, marquee) may start.
        // The pan tool is the same deal (canvas-tools follow-up): it IS
        // this gesture, as the idle mode.
        if (spaceHeld || panTool) return

        // U15: a shape tool is active — start (or, per Konva's docs,
        // implicitly restart) a drag-to-size instead of the marquee/pan
        // routing below.
        if (drawingShape) {
          const point = screenToStagePoint(stage, event.evt.clientX, event.evt.clientY)
          shapeTool.startDraw(activeTool, point)
          return
        }
        // U16: a line tool is active — point placement/finishing is driven
        // entirely by `onClick`/`onDblClick`/Escape below, not `pointerdown`.
        if (drawingLine) {
          return
        }
        // U8: Crop tool — a left-press starts (or, replacing any pending
        // region, restarts) the region drag. The objects layer is
        // non-listening while cropping (see the Layer gate below), so the
        // press always reaches the Stage regardless of what's under the
        // cursor; move/release are the window listeners above. Mouse-only,
        // like the marquee (v1).
        if (croppingTool) {
          // Code-review fix: touch keeps single-finger panning even while
          // the crop tool is active (region drawing stays mouse-only) —
          // the same per-gesture draggable enable as the Select-tool touch
          // path below, so a tablet user isn't left with an inert canvas.
          if (event.evt.pointerType === 'touch') {
            stage.draggable(true)
            return
          }
          if (event.evt.button === 0) {
            const pointer = stage.getPointerPosition()
            if (pointer) crop.begin(pointer)
          }
          return
        }
        // U7: Text tool — a left-press on EMPTY canvas creates a text
        // object there (the caller snaps/clamps, builds the draft, and
        // opens the edit overlay). A press on an existing object falls
        // through to that object's own click handling instead (the objects
        // layer stays listening for the text tool): existing TEXT objects
        // re-edit via `resolveObjectClickAction`, others just select. No
        // marquee starts while the text tool is active.
        if (textToolActive) {
          if (event.evt.button === 0 && event.target === stage) {
            onCreateTextAt?.(screenToStagePoint(stage, event.evt.clientX, event.evt.clientY))
          }
          return
        }

        // U2: touch is exempt from the pan rebind (plan) — single-finger
        // pan is preserved (the pinch handler in onTouchMove depends on the
        // stage drag via `isDragging()`/`stopDrag()`), and the marquee is
        // mouse-only in v1. DOM `pointerdown` fires BEFORE `touchstart`, so
        // flipping `draggable` here is early enough for Konva's own
        // touchstart drag bookkeeping (ready-status, drag-distance
        // threshold, "a draggable Object under the finger wins" bubbling)
        // to behave exactly as it did when the prop was statically true —
        // taps still select, and dragging an Object still beats panning.
        // `onDragEnd`/`onPointerUp` restore the prop-driven value after the
        // gesture. Tap-on-empty-canvas keeps U1's clear-at-pointerdown
        // behavior (no marquee commit will run for touch).
        if (event.evt.pointerType === 'touch') {
          stage.draggable(true)
          if (event.target === stage) {
            ;(onBackgroundDeselect ?? onClearSelection)()
          }
          return
        }

        // U2: plain left-press on empty canvas (Select tool, no pan) starts
        // the marquee. Selection is NO LONGER cleared here at pointerdown —
        // the release decides (zero-movement click clears, a drag selects;
        // see `resolveMarqueeCommit`), otherwise Shift+marquee could never
        // union with the selection this pointerdown would have wiped.
        if (event.evt.button === 0 && event.target === stage) {
          // Belt-and-suspenders: if a stray imperative enable survived (a
          // touch gesture that ended off-canvas), drop it now so the
          // upcoming mousedown can't ALSO start a native stage drag under
          // this marquee.
          if (stage.draggable()) stage.draggable(false)
          const pointer = stage.getPointerPosition()
          if (pointer) marquee.begin(pointer)
        }
      }}
      onPointerMove={(event) => {
        if (!drawingShape || !shapeTool.isDrawing) return
        const stage = event.target.getStage()
        if (!stage) return
        const point = screenToStagePoint(stage, event.evt.clientX, event.evt.clientY)
        shapeTool.updateDraw(point)
      }}
      onPointerUp={(event) => {
        // U2: end-of-gesture restore for the imperative touch enable in
        // onPointerDown (the drag path restores in onDragEnd too — this
        // covers taps, where no drag ever starts). Setting `draggable`
        // false mid-drag makes Konva end that drag cleanly (dragend fires,
        // so the pan still commits through onDragEnd above).
        if (event.evt.pointerType === 'touch') {
          event.target.getStage()?.draggable(stageDraggable)
        }
        if (!drawingShape || !shapeTool.isDrawing) return
        shapeTool.endDraw()
      }}
      onClick={(event) => {
        if (!drawingLine) return
        // U2: a zero-movement Space+click on the canvas still fires Konva's
        // click (drags only suppress it once movement starts) — Space owns
        // the gesture, so don't place a line point from it.
        if (spaceHeld) return
        // The browser fires `click` twice (detail 1, then detail 2) before
        // firing a single `dblclick` — without this guard, the second click
        // of a double-click-to-finish gesture would append a spurious extra
        // point immediately before `onDblClick` below finishes the draw.
        if (event.evt.detail >= 2) return
        const stage = event.target.getStage()
        if (!stage) return
        const point = screenToStagePoint(stage, event.evt.clientX, event.evt.clientY)
        lineTool.addPoint(activeTool as LineType, point)
      }}
      onDblClick={() => {
        if (!drawingLine) return
        lineTool.finishDraw()
      }}
      onContextMenu={(event) => {
        // U5: suppress the BROWSER menu and open ours instead. Konva only
        // dispatches this handler for events on the stage's own canvas
        // element, so DOM inputs (the property panel today, U7's text
        // overlay later) are never intercepted — their native context menu
        // stays, per the plan's text-editing rule.
        event.evt.preventDefault()
        // U8: no context menu while the crop tool is active — crop owns the
        // canvas interaction (its region drag, dim preview, and confirm
        // affordance), and keeping the menu out is what makes the
        // documented Escape order (menu ABOVE crop) hold by construction:
        // a menu can never open over a pending crop region, so the two
        // window-level Escape listeners can never race. Code-review fix:
        // the same reasoning applies to an in-progress line/shape draw and
        // an active marquee — CanvasStage's window Escape listener owns
        // those states, so the menu must never open over them (Escape
        // would otherwise be consumed by two owners at once, e.g. closing
        // the menu AND committing a half-drawn line).
        if (croppingTool || drawingLine || drawingShape || marquee.isActive) return
        const stage = event.target.getStage()
        if (!stage) return
        // Right-click selection rule FIRST (plan Key Technical Decision),
        // so the menu always acts on what the user visually targeted; then
        // report the click point up in both spaces (model for Paste's
        // paste point, viewport for positioning the DOM menu).
        const targetId = event.target === stage ? null : findObjectIdForNode(event.target, stage)
        const action = resolveContextMenuSelection(targetId, selectedItemIds, objects)
        if (action.kind === 'replace') {
          onReplaceSelection(action.ids)
        } else if (action.kind === 'clear') {
          onClearSelection()
        }
        onOpenContextMenu?.({
          stagePoint: screenToStagePoint(stage, event.evt.clientX, event.evt.clientY),
          clientPosition: { x: event.evt.clientX, y: event.evt.clientY },
        })
      }}
    >
      {/* Grid/background layer: static, non-interactive. */}
      <Layer listening={false}>
        <Rect x={0} y={0} width={width} height={height} fill="#f9fafb" />
        {gridLines.map((points, index) => (
          <Line key={index} points={points} stroke="#e5e7eb" strokeWidth={1} />
        ))}
      </Layer>

      {/* Interactive Objects layer. Non-listening while a shape or line tool
          is active (U15/U16): the user is drawing, not selecting/dragging
          existing items, so clicks/drags should fall through to the Stage's
          own drawing handlers above rather than selecting or repositioning
          an existing Object underneath the drag/click. Also non-listening
          while Space is held (U2): pan owns the gesture, so a Space+drag
          starting over an Object must reach the draggable Stage instead of
          dragging that Object. U8: the crop tool joins the drawing tools —
          a crop drag must start wherever the pointer is, objects
          underneath included. */}
      <Layer listening={!drawingShape && !drawingLine && !spaceHeld && !croppingTool}>
        {/* U18: render order comes from `sortObjectsByZIndex` (above) —
            deliberately NOT from imperative Konva `.moveToTop()`/`.zIndex()`
            calls, which react-konva's own docs warn will fight React's own
            re-renders. Render order must come from component/array order in
            state instead. */}
        {sortObjectsByZIndex(objects).map((object) => (
          <ObjectShape
            key={object.id}
            object={object}
            isSelected={selectedItemIds.includes(object.id)}
            onSelect={handleObjectSelect}
            onDoubleClick={handleObjectDoubleClick}
            gridSize={gridSize}
            canvasWidth={width}
            canvasHeight={height}
            onGeometryChange={onGeometryChange}
            allObjects={objects}
            zoom={zoom}
            onAlignmentGuidesChange={setGuides}
            // U3/U6: selected members drag through the relay (group-move
            // for 2+ selections, and — since U6 — the sole-selected box
            // case too, so Alt-drop duplication has one code path).
            // Unselected objects, and a sole-selected LINE, keep the plain
            // single-drag path bit-for-bit (see `dragRelayFor`).
            groupDrag={dragRelayFor(object)}
            // Pan is navigate-only: objects stay clickable (a click hands
            // the canvas to the select tool, below) but non-draggable, so a
            // press over one reaches the draggable Stage and pans.
            draggable={!panTool}
            // U7: the node being edited through the DOM text overlay hides
            // (the overlay's textarea is the visible text while editing).
            hidden={editingItemId != null && object.id === editingItemId}
            shapeRef={(node) => {
              if (node) {
                shapeNodesRef.current.set(object.id, node)
              } else {
                shapeNodesRef.current.delete(object.id)
              }
            }}
          />
        ))}
      </Layer>

      {/* UI overlay layer: SelectionTransformer (U8), Shape draw preview
          (U15), Line draw preview (U16), alignment guides (U19). Must remain
          listening (not `listening={false}` like the grid layer) since the
          Transformer's handles are interactive. */}
      <Layer>
        {selectedIsLine && selectedObject ? (
          <LineAnchorHandles
            object={selectedObject}
            points={parseLinePoints(selectedObject.properties)}
            gridSize={gridSize}
            canvasWidth={width}
            canvasHeight={height}
            onPointDragEnd={(id, pointIndex, point) => onLinePointDragEnd?.(id, pointIndex, point)}
            getLineNode={() => shapeNodesRef.current.get(selectedObject.id) as Konva.Line | undefined}
          />
        ) : (
          <SelectionTransformer
            selectedItemIds={selectedItemIds}
            getNode={(id) => shapeNodesRef.current.get(id)}
            canvasWidth={width}
            canvasHeight={height}
            // U3: every transform (single- and multi-node) commits as one
            // batched patch list — one history entry per gesture.
            onTransformEnd={(patches) => onItemsGeometryChange?.(patches)}
            allObjects={objects}
            zoom={zoom}
            onAlignmentGuidesChange={setGuides}
          />
        )}
        {shapeTool.isDrawing && shapeTool.drawType && shapeTool.previewGeometry && (
          <ShapePreview type={shapeTool.drawType} geometry={shapeTool.previewGeometry} />
        )}
        {lineTool.isDrawing && <LinePreview points={lineTool.points} />}
        {/* U2: the in-progress marquee, drawn from the shared
            selection-chrome token (solid stroke + translucent fill; U4's
            group outlines and U8's crop preview reuse the same token). The
            rect is MODEL-space (this layer inherits the stage transform),
            with the stroke divided by zoom so it stays 1px on screen. */}
        {marquee.rect && (
          <Rect
            x={marquee.rect.x}
            y={marquee.rect.y}
            width={marquee.rect.width}
            height={marquee.rect.height}
            fill={SELECTION_CHROME.fill}
            stroke={SELECTION_CHROME.stroke}
            strokeWidth={SELECTION_CHROME.strokeWidth / zoom}
            listening={false}
          />
        )}
        {/* U4's member-mode nested-outline cue: while exactly one grouped
            member is selected (double-click member-mode), a DASHED
            group-context outline — the shared selection-chrome token's dash
            variant, same language as the group transformer border — wraps
            the whole group's bbox, so "inside a group" always reads
            differently from a plain single selection. No fill: the member's
            own solid chrome nests inside it. */}
        {memberModeGroupBox && (
          <Rect
            x={memberModeGroupBox.x}
            y={memberModeGroupBox.y}
            width={memberModeGroupBox.width}
            height={memberModeGroupBox.height}
            stroke={SELECTION_CHROME.stroke}
            strokeWidth={SELECTION_CHROME.strokeWidth / zoom}
            // Dash lengths divided by zoom for the same reason strokeWidth
            // is: this layer inherits the stage transform, and the dash
            // rhythm should stay constant on SCREEN at every zoom level.
            dash={SELECTION_CHROME.dash.map((segment) => segment / zoom)}
            listening={false}
          />
        )}
        {/* U8: the crop preview — four dimming strips outside the region
            plus its border (shared selection-chrome token), live while the
            region is being dragged AND while it awaits confirm/cancel. */}
        {crop.region && (
          <CropRegionOverlay
            region={crop.region}
            canvasWidth={width}
            canvasHeight={height}
            zoom={zoom}
          />
        )}
        {/* U19: temporary dashed guide lines, matched during a drag/resize
            and destroyed on dragend/transformend (see the `guides` state
            above). */}
        <AlignmentGuideLines guides={guides} width={width} height={height} />
      </Layer>
    </Stage>
    {/* U8: the floating confirm/cancel affordance for a pending crop
        region — DOM (shadcn Buttons), so it renders OUTSIDE the Konva
        Stage, fixed-positioned at the region's bottom-right corner.
        Enter/Escape drive the same confirm/cancel via the window listener
        above. */}
    {crop.isPending && crop.region && (
      <CropConfirmControls
        region={crop.region}
        zoom={zoom}
        stagePosition={stagePosition}
        getStage={() => stageRef.current}
        onConfirm={crop.confirm}
        onCancel={crop.cancel}
      />
    )}
    </>
  )
})
