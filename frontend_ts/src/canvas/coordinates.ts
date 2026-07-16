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
} as const

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

/**
 * Rejects (falls back to `oldBox`) a resize/rotate that would shrink below
 * `minSize`, or push the item's post-rotation axis-aligned bounding box
 * outside `[0, canvasWidth] x [0, canvasHeight]`; otherwise passes `newBox`
 * through unchanged.
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

  const rotationDeg = (newBox.rotation * 180) / Math.PI
  const bbox = getRotatedBoundingBox({ x: newBox.x, y: newBox.y }, newBox.width, newBox.height, rotationDeg)

  if (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.width > canvasWidth || bbox.y + bbox.height > canvasHeight) {
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
  return tag === 'INPUT' || tag === 'TEXTAREA' || isContentEditable
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
