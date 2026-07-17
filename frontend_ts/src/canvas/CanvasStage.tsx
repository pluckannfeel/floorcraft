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
   * with `[id]` (and U2's marquee will pass its full hit set). Wired to the
   * store's `replaceSelection` by the caller — same delegation as
   * `onGeometryChange`/`onDeleteSelected`. */
  onReplaceSelection: (ids: CanvasObject['id'][]) => void
  /** U1 click routing: ctrl(/meta)+click toggles one id's membership in
   * the selection. Wired to the store's `toggleInSelection`. */
  onToggleInSelection: (id: CanvasObject['id']) => void
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
  const hits = selectIdsInRect(rect, objects)
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

interface UseMarqueeArgs {
  zoom: number
  stagePosition: Point
  objects: CanvasObject[]
  selectedItemIds: CanvasObject['id'][]
  onReplaceSelection: (ids: CanvasObject['id'][]) => void
  onClearSelection: () => void
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
        onClearSelection()
      } else if (action.kind === 'select') {
        onReplaceSelection(action.ids)
      }
      setGesture(null)
    },
    [gesture, zoom, stagePosition, objects, selectedItemIds, onReplaceSelection, onClearSelection],
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
    onToggleInSelection,
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
  },
  ref,
) {
  const gridLines = buildGridLines(width, height, gridSize)
  const drawingShape = isShapeTool(activeTool)
  const drawingLine = isLineTool(activeTool)

  // U2: plain drag on empty canvas is the marquee now; panning is
  // pan-active-only. The Stage is natively `draggable` ONLY while Space is
  // held (window key listeners below); middle-mouse and touch gestures
  // enable dragging imperatively per-event inside `onPointerDown` — a React
  // state toggle commits too late for the same pointerdown to start a Konva
  // drag.
  const [spaceHeld, setSpaceHeld] = useState(false)
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

  // U1: basic selection click routing (the plan's U1-owned contract —
  // U2 layers the marquee on top; U4 later makes this group-aware via a
  // shared expansion helper, keeping the store's selection the literal
  // operand set). Plain click REPLACES the selection with the clicked
  // object; ctrl(/meta, for macOS)+click TOGGLES its membership.
  const handleObjectSelect = (id: CanvasObject['id'], modifiers?: SelectionClickModifiers) => {
    if (modifiers?.ctrlKey || modifiers?.metaKey) {
      onToggleInSelection(id)
    } else {
      onReplaceSelection([id])
    }
  }

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

  // U2 cursor language: crosshair while a marquee is being drawn;
  // grab/grabbing while pan is available/active (Space held or an actual
  // pan drag, including middle-mouse); default arrow otherwise (the plan
  // explicitly allows keeping the arrow for the idle Select tool).
  useEffect(() => {
    const container = stageRef.current?.container()
    if (!container) return
    container.style.cursor = marqueeActive ? 'crosshair' : panDragging ? 'grabbing' : spaceHeld ? 'grab' : ''
  }, [marqueeActive, panDragging, spaceHeld])

  // Map<id, Konva.Node> resolving the selected item's live node for
  // SelectionTransformer's `.nodes([ref])` attach — populated/cleared by
  // each ObjectShape's `shapeRef` callback as items mount/unmount.
  const shapeNodesRef = useRef(new Map<CanvasObject['id'], Konva.Node>())

  // U19: the currently-matched alignment guide(s), reported up by whichever
  // ObjectShape is being dragged or by SelectionTransformer during a resize,
  // on every dragmove/transform frame; reset to `NO_GUIDES` on
  // dragend/transformend. Plain `useState` (not a ref) since this drives
  // what `AlignmentGuideLines` renders below — re-rendering every drag frame
  // is the accepted, unthrottled cost the plan flags (Risks & Dependencies).
  const [guides, setGuides] = useState<GuideLines>(NO_GUIDES)

  // U3: group drag — dragging any member of a 2+ selection moves the whole
  // selection as one. `ObjectShape` relays the dragged member's
  // dragmove/dragend here (see `GroupDragHandlers`); these handlers are the
  // thin Konva plumbing around the pure policy in `resolveGroupDragUpdate`/
  // `buildGroupDragPatches` above: per frame, force the dragged node to its
  // snapped+collectively-clamped position and apply the SAME delta to every
  // co-selected node imperatively via `shapeNodesRef` (never a Konva.Group
  // re-parent, never `shouldOverdrawWholeArea` — the plan's Key Technical
  // Decision; `SelectionTransformer`'s attach effect also unbinds Konva's
  // own proxy-drag so nothing fights this). Co-moved LINE members translate
  // by rewriting their `points` (the `LineAnchorHandles` onDragMove
  // pattern), never via node.x()/y() — a Line's position isn't a React
  // prop, so an offset would survive the commit and double the translation.
  const groupDragActive = selectedItemIds.length >= 2

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
    onDragEnd: (draggedId, node) => {
      setGuides(NO_GUIDES)
      const dragged = objects.find((object) => object.id === draggedId)
      if (!dragged) return
      // The dragged node sits at its final (already snapped/clamped — every
      // dragmove frame went through `resolveGroupDragUpdate`) position; the
      // final shared delta falls straight out of it.
      const origin: Point = isLineTool(dragged.type) ? { x: 0, y: 0 } : { x: dragged.x, y: dragged.y }
      const delta: Point = { x: node.x() - origin.x, y: node.y() - origin.y }
      const patches = buildGroupDragPatches(delta, objects, selectedItemIds)
      // A dragged LINE moved via its node's position offset (Konva's own
      // drag) — bake the translation into its points and zero the offset in
      // this same dragend, BEFORE the store commit re-renders: the
      // committed points already carry the translation, and a surviving
      // offset would apply it twice (Line x/y aren't React-controlled).
      if (isLineTool(dragged.type)) {
        const committedPoints = patches.find((patch) => patch.id === draggedId)?.patch.points
        if (committedPoints) (node as Konva.Line).points(flattenPoints(committedPoints))
        node.position({ x: 0, y: 0 })
      }
      // ONE batched store action for the whole gesture — a single undo
      // entry restores every member (AE2).
      onItemsGeometryChange?.(patches)
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
      if (event.key === 'Escape' && drawingLine) {
        lineTool.finishDraw()
        return
      }
      const activeElement = document.activeElement as HTMLElement | null
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
  }, [selectedItemIds, onDeleteSelected, drawingLine, lineTool.finishDraw])

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
    <Stage
      ref={setStageRef}
      width={width}
      height={height}
      scaleX={zoom}
      scaleY={zoom}
      x={stagePosition.x}
      y={stagePosition.y}
      draggable={spaceHeld}
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
        // `draggable` when the PROP changes between renders, so an
        // imperative `draggable(true)` would otherwise stick forever.
        stage.draggable(spaceHeld)
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
        if (spaceHeld) return

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
            onClearSelection()
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
          event.target.getStage()?.draggable(spaceHeld)
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
          dragging that Object. */}
      <Layer listening={!drawingShape && !drawingLine && !spaceHeld}>
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
            gridSize={gridSize}
            canvasWidth={width}
            canvasHeight={height}
            onGeometryChange={onGeometryChange}
            allObjects={objects}
            zoom={zoom}
            onAlignmentGuidesChange={setGuides}
            // U3: members of a 2+ selection drag as a group — the relay is
            // passed ONLY to selected members, so unselected objects (and
            // any object under a single selection) keep the pre-U3
            // single-drag path bit-for-bit.
            groupDrag={
              groupDragActive && selectedItemIds.includes(object.id) ? groupDragHandlers : undefined
            }
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
        {/* U19: temporary dashed guide lines, matched during a drag/resize
            and destroyed on dragend/transformend (see the `guides` state
            above). */}
        <AlignmentGuideLines guides={guides} width={width} height={height} />
      </Layer>
    </Stage>
  )
})
