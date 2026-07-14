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
export function screenToStagePoint(stage: Konva.Stage, clientX: number, clientY: number): Point {
  const container = stage.container()
  const rect = container.getBoundingClientRect()
  const containerRelative: Point = {
    x: clientX - rect.left,
    y: clientY - rect.top,
  }

  const transform = stage.getAbsoluteTransform().copy().invert()
  return transform.point(containerRelative)
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
