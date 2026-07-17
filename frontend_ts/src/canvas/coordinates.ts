import type Konva from 'konva'
import type { Point } from './types'

/**
 * Converts a raw screen-space point (e.g. `event.clientX/clientY`) into
 * stage-space coordinates, correctly accounting for zoom/pan.
 *
 * Per the plan's Key Technical Decisions: `stage.getPointerPosition()` alone
 * ignores the stage's current scale/position, so we invert the stage's
 * absolute transform ourselves. `clientX`/`clientY` are first made relative
 * to the stage container's bounding rect since the transform assumes
 * container-relative input.
 */
/** Converts a client (viewport) point into a point relative to the Stage's
 * container element — the first step both `screenToStagePoint` and any
 * multi-touch gesture math (e.g. pinch-zoom) need before doing anything
 * transform-aware. */
export function clientToContainerPoint(stage: Konva.Stage, clientX: number, clientY: number): Point {
  const rect = stage.container().getBoundingClientRect()
  return { x: clientX - rect.left, y: clientY - rect.top }
}

export function screenToStagePoint(stage: Konva.Stage, clientX: number, clientY: number): Point {
  const containerRelative = clientToContainerPoint(stage, clientX, clientY)
  const transform = stage.getAbsoluteTransform().copy().invert()
  return transform.point(containerRelative)
}

/**
 * Pure counterpart of `screenToStagePoint`'s second half: converts an
 * already-container-relative point (e.g. `stage.getPointerPosition()`, or
 * `clientToContainerPoint`'s output) into model/stage space given the
 * current zoom/pan. The Stage's absolute transform is exactly
 * `scale(zoom) . translate(position)` in this app (no independent axis
 * scaling, no nested stage transforms), so inverting it reduces to this
 * arithmetic — extracted Konva-free (U2) so the marquee's screen-to-model
 * conversion is unit-testable in jsdom, where a real `Konva.Stage` can't
 * mount.
 */
export function containerToStagePoint(containerPoint: Point, zoom: number, stagePosition: Point): Point {
  return {
    x: (containerPoint.x - stagePosition.x) / zoom,
    y: (containerPoint.y - stagePosition.y) / zoom,
  }
}

/** Rounds a point's coordinates to the nearest multiple of `gridSize`. */
export function snapToGrid(point: Point, gridSize: number): Point {
  if (gridSize <= 0) return point
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  }
}

/**
 * Clamps a point so that an object of the given `width`/`height` placed at
 * that point stays fully within `[0, canvasWidth] x [0, canvasHeight]`.
 *
 * Applied AFTER `snapToGrid` (snap-then-clamp order, per Key Technical
 * Decisions) so the bounds invariant always holds even when the grid-snapped
 * position would otherwise land outside the canvas.
 *
 * U8 (crop) note: an object left outside the canvas by a crop (R22 keeps
 * outside objects at their now-negative coordinates) teleports back in on
 * its first single-object drag, because this clamp runs on every dragmove
 * frame — the plan explicitly accepts that ("drag it back in" is the
 * recovery gesture). Transforms and group drags of out-of-bounds boxes are
 * the interactions that must NOT be blocked, and those are relaxed in
 * `constrainTransformBox`/`clampGroupDragDelta` below instead.
 */
export function clampToBounds(
  point: Point,
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
): Point {
  const maxX = Math.max(0, canvasWidth - width)
  const maxY = Math.max(0, canvasHeight - height)
  return {
    x: Math.min(Math.max(point.x, 0), maxX),
    y: Math.min(Math.max(point.y, 0), maxY),
  }
}

/** U8's Transformer `boundBoxFunc` minimum item size (10px), per the plan's
 * Key Technical Decisions. */
export const MIN_ITEM_SIZE = 10

/** U11's zoom range — a "sane min/max" per the plan's Approach, chosen to
 * keep the smallest zoom still legible and the largest still performant. */
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4

/** Clamps a raw scale factor into `[MIN_ZOOM, MAX_ZOOM]`. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** A Stage's current zoom/pan as far as this module's pure math cares:
 * `zoom` mirrors Konva's `scaleX`/`scaleY` (kept equal — no independent
 * axis scaling anywhere in this app), `position` mirrors `x`/`y`. */
export interface ZoomPanState {
  zoom: number
  position: Point
}

/**
 * The standard Konva zoom-to-point recipe (see Konva's documented
 * "Zooming on scroll/wheel" sandbox): converts `pointer` (a container-
 * relative screen point, e.g. from `stage.getPointerPosition()`) into
 * stage-space under the CURRENT transform, clamps `rawNewScale` into the
 * allowed zoom range, then repositions the stage so that same stage-space
 * point is still under `pointer` after the new scale is applied.
 *
 * Pure/Konva-independent (like every other helper in this module) so it's
 * unit-testable without a real Stage, and reusable by both wheel-zoom and
 * pinch-zoom (U11) without either driving the other's event plumbing.
 */
export function computeZoomAtPoint(current: ZoomPanState, pointer: Point, rawNewScale: number): ZoomPanState {
  const oldScale = current.zoom
  const pointerStagePoint: Point = {
    x: (pointer.x - current.position.x) / oldScale,
    y: (pointer.y - current.position.y) / oldScale,
  }
  const newScale = clampZoom(rawNewScale)
  return {
    zoom: newScale,
    position: {
      x: pointer.x - pointerStagePoint.x * newScale,
      y: pointer.y - pointerStagePoint.y * newScale,
    },
  }
}

/**
 * Mouse-wheel zoom: each wheel "tick" scales by `scaleBy` (default 1.05,
 * a gentle per-tick step), zooming in when `deltaY < 0` (scrolling up/away
 * from the user — the browser convention) and out when `deltaY > 0`.
 * Delegates the actual point-anchored math to `computeZoomAtPoint`.
 */
export function computeWheelZoom(
  current: ZoomPanState,
  pointer: Point,
  deltaY: number,
  scaleBy: number = 1.05,
): ZoomPanState {
  const rawNewScale = deltaY < 0 ? current.zoom * scaleBy : current.zoom / scaleBy
  return computeZoomAtPoint(current, pointer, rawNewScale)
}

/**
 * Two-finger pinch zoom: `distanceRatio` is `newTouchDistance / oldTouchDistance`
 * between the two touch points, and `center` is their midpoint
 * (container-relative). Scales the current zoom by that ratio directly
 * (unlike wheel-zoom's fixed per-tick step, a pinch's ratio already encodes
 * "how much" the fingers moved apart/together since the last sampled frame).
 */
export function computePinchZoom(current: ZoomPanState, center: Point, distanceRatio: number): ZoomPanState {
  return computeZoomAtPoint(current, center, current.zoom * distanceRatio)
}

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Computes the axis-aligned bounding box of a `width` x `height` rectangle
 * rotated by `rotationDeg` degrees around its own (x, y) top-left corner.
 *
 * This matches `ObjectShape`'s Konva `Group` convention: the Group's
 * `rotation` pivots around its own `x`/`y` (offsetX/offsetY are never set),
 * i.e. rotation around the rect's top-left corner, NOT its center.
 */
export function getRotatedBoundingBox(
  point: Point,
  width: number,
  height: number,
  rotationDeg: number,
): BoundingBox {
  const theta = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((corner) => ({
    x: point.x + corner.x * cos - corner.y * sin,
    y: point.y + corner.x * sin + corner.y * cos,
  }))

  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  }
}

/**
 * Normalizes two corner points (any two opposite corners, in any order —
 * e.g. a marquee's pointerdown origin and current pointer position) into a
 * `BoundingBox` with non-negative width/height (U2).
 */
export function rectFromPoints(a: Point, b: Point): BoundingBox {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

/**
 * Axis-aligned rectangle intersection — INTERSECTION, not containment (U2:
 * a marquee that merely clips an object's corner selects it, per the plan's
 * interaction defaults). Touching edges count as intersecting (`<=`), which
 * also keeps degenerate boxes selectable — a perfectly horizontal Line's
 * points-derived bbox has height 0 and must still be marquee-selectable.
 */
export function rectsIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  )
}

/**
 * U2: the shared selection-chrome token — one stroke/fill/dash language for
 * every "this region is selection UI" visual, so they read as one system:
 * the marquee rect (U2, solid stroke + translucent fill), U4's group
 * outlines (dashed stroke), and U8's crop preview all draw from these
 * values rather than minting their own colors.
 */
export const SELECTION_CHROME = {
  stroke: '#2563eb',
  fill: 'rgba(37, 99, 235, 0.08)',
  strokeWidth: 1,
  dash: [4, 4],
  /** U8: the crop preview's outside-the-region dimming fill (the four
   * translucent overlay strips) — part of the shared token so the crop
   * chrome stays in the same visual system as the marquee/group outlines
   * rather than minting its own color. */
  dimFill: 'rgba(15, 23, 42, 0.35)',
} as const

/**
 * U3: the axis-aligned union of several bounding boxes — the multi-selection's
 * COLLECTIVE bounding box a group drag is clamped against (see
 * `clampGroupDragDelta`). Returns `null` for an empty list so callers can
 * distinguish "no boxes" from a real zero-size box at the origin.
 */
export function unionBoundingBoxes(boxes: BoundingBox[]): BoundingBox | null {
  if (boxes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const box of boxes) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** One axis of `clampGroupDragDelta`: the translation that keeps
 * `[start, start + size]` within `[0, canvasSize]`.
 *
 * U8 (crop): an axis on which the box ALREADY violates the bounds is left
 * completely unclamped. Crop makes out-of-bounds objects a supported state
 * (R22: outside objects keep their now-negative coordinates), and clamping
 * such a box would either teleport it in (`min = -start > 0` forces a
 * rightward jump for a box past the left edge) or freeze it outright (the
 * old larger-than-canvas rule) — both would make a crop-stranded or
 * overhanging selection unmovable/jumpy. This also subsumes the previous
 * "freeze an oversized box" rule: a box larger than the canvas necessarily
 * violates at least one edge, so it now moves freely on that axis instead
 * of being stuck. In-bounds boxes clamp exactly as before. */
function clampAxisDelta(delta: number, start: number, size: number, canvasSize: number): number {
  if (start < 0 || start + size > canvasSize) return delta
  const min = -start
  const max = canvasSize - size - start
  return Math.min(Math.max(delta, min), max)
}

/**
 * U3's group-drag bounds rule: clamp the DELTA a multi-selection drag wants
 * to apply so the selection's COLLECTIVE bounding box stays inside
 * `[0, canvasWidth] x [0, canvasHeight]`. Clamping the shared delta (instead
 * of clamping each member's position individually, `clampToBounds`-style)
 * is what preserves the members' relative offsets at the canvas edge —
 * per-member clamping would let interior members keep moving while edge
 * members stop, distorting the arrangement. Mirrors
 * `constrainTransformBox`'s collective-box approach for resize.
 */
export function clampGroupDragDelta(
  delta: Point,
  collectiveBox: BoundingBox,
  canvasWidth: number,
  canvasHeight: number,
): Point {
  return {
    x: clampAxisDelta(delta.x, collectiveBox.x, collectiveBox.width, canvasWidth),
    y: clampAxisDelta(delta.y, collectiveBox.y, collectiveBox.height, canvasHeight),
  }
}

/** Rigidly translates every point by `delta` — how a co-moved Line member
 * follows a group drag (its `properties.points` are absolute canvas
 * coordinates, so translating the Line means translating each point; the
 * Line node's own x/y must stay at the origin — see `ObjectShape.tsx`'s
 * Line branch). */
export function translatePoints(points: Point[], delta: Point): Point[] {
  return points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y }))
}

/**
 * The node-transform subset Konva's Transformer mutates on each attached
 * node (`_fitNodesInto` decomposes the new transform into these attrs).
 * `rotation` is in DEGREES — `Konva.Node.rotation()`'s convention (unlike
 * `boundBoxFunc`'s radians, see `TransformBoundBox`).
 */
export interface NodeTransform {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
}

/**
 * U3 multi-node transform decomposition for LINE members: maps each local
 * point through the node's own transform, producing the new ABSOLUTE canvas
 * points to commit. Konva composes a node's transform as
 * translate → rotate → scale (scale innermost), so a point maps to
 * `T + R(θ) · (S · p)` — after committing these points and resetting the
 * node's transform to identity, the rendered geometry is exactly what the
 * transform displayed (points "scale proportionally", per the plan).
 * Pure/Konva-free so it's unit-testable in jsdom.
 */
export function applyNodeTransformToPoints(points: Point[], transform: NodeTransform): Point[] {
  const theta = (transform.rotation * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return points.map((point) => {
    const scaledX = point.x * transform.scaleX
    const scaledY = point.y * transform.scaleY
    return {
      x: transform.x + scaledX * cos - scaledY * sin,
      y: transform.y + scaledX * sin + scaledY * cos,
    }
  })
}

/**
 * The shape Konva's Transformer `boundBoxFunc` callback passes/expects:
 * `x`/`y` are the box's top-left position (pre-rotation-pivot, same
 * convention as `getRotatedBoundingBox`), and `rotation` is in RADIANS —
 * Konva's convention for this specific callback, unlike `node.rotation()`
 * elsewhere which is degrees.
 */
export interface TransformBoundBox {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

/** True when a box's post-rotation axis-aligned bounding box violates
 * `[0, canvasWidth] x [0, canvasHeight]` — shared by `constrainTransformBox`'s
 * old-box/new-box checks. */
function transformBoxOutOfBounds(
  box: TransformBoundBox,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  const rotationDeg = (box.rotation * 180) / Math.PI
  const bbox = getRotatedBoundingBox({ x: box.x, y: box.y }, box.width, box.height, rotationDeg)
  return bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.width > canvasWidth || bbox.y + bbox.height > canvasHeight
}

/**
 * Rejects (falls back to `oldBox`) a resize/rotate that would shrink below
 * `minSize`, or push the item's post-rotation axis-aligned bounding box
 * outside `[0, canvasWidth] x [0, canvasHeight]`; otherwise passes `newBox`
 * through unchanged.
 *
 * U8 (crop) exception: when the CURRENT box already violates the bounds —
 * a crop-stranded object outside the canvas, or a multi-selection whose
 * collective box overhangs the edge — the bounds rejection is skipped
 * entirely (only the min-size floor still applies). Crop makes
 * out-of-bounds a supported state (R22), so hard rejection is no longer a
 * valid invariant there: keeping it would leave stranded objects with dead
 * transformer handles. Transforms of in-bounds boxes behave exactly as
 * before.
 *
 * Pure and Konva-independent so `SelectionTransformer`'s `boundBoxFunc` (and
 * this logic's tests) don't need a real Konva `Transformer` instance.
 */
export function constrainTransformBox(
  oldBox: TransformBoundBox,
  newBox: TransformBoundBox,
  canvasWidth: number,
  canvasHeight: number,
  minSize: number = MIN_ITEM_SIZE,
): TransformBoundBox {
  if (newBox.width < minSize || newBox.height < minSize) {
    return oldBox
  }

  if (
    !transformBoxOutOfBounds(oldBox, canvasWidth, canvasHeight) &&
    transformBoxOutOfBounds(newBox, canvasWidth, canvasHeight)
  ) {
    return oldBox
  }

  return newBox
}

/**
 * Determines whether a `keydown` event should delete the current selection
 * (the WHOLE selection set, U1 — the caller deletes every selected id in
 * one batched action): only `Delete`/`Backspace`, only when the selection
 * is non-empty, and not while focus is in a text field (U10's Property
 * Panel inputs share the same window-level listener).
 */
/** True when the given element tag/contentEditable state means keyboard
 * shortcuts should be suppressed because the user is typing into a field —
 * shared by every keyboard-shortcut guard (Delete/Backspace here,
 * undo/redo in `useCanvasShortcuts.ts`) so the definition of "typing" can't
 * drift between them. */
export function isEditableTarget(activeElementTag: string | undefined, isContentEditable: boolean): boolean {
  const tag = activeElementTag?.toUpperCase()
  // SELECT counts as editable (code-review fix): the property panel's font
  // dropdown is a native <select> — Delete while it's focused must not
  // delete the object being styled, and Space must open the dropdown, not
  // arm canvas panning.
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || isContentEditable
}

export function shouldHandleDeleteKey(
  key: string,
  selectedItemIds: readonly unknown[],
  activeElementTag: string | undefined,
  isContentEditable = false,
): boolean {
  if (selectedItemIds.length === 0) return false
  if (key !== 'Delete' && key !== 'Backspace') return false
  if (isEditableTarget(activeElementTag, isContentEditable)) return false
  return true
}
