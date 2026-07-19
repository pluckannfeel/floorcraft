import { useCallback, useState } from 'react'
import { Ellipse, Rect } from 'react-konva'
import { clampToBounds, MIN_ITEM_SIZE, snapToGrid } from './coordinates'
import type { Point, ShapeType } from './types'

/**
 * U15: click-drag-to-size Shape drawing (`shape_rectangle`/`shape_square`/
 * `shape_circle`), driven by `activeTool` (U9's field, unused until now).
 *
 * Mirrors the split established by `coordinates.ts`/`SelectionTransformer.tsx`:
 * pure, Konva-independent geometry math lives here and is thoroughly unit
 * tested; the thin Konva-prop plumbing (reading pointer positions, rendering
 * a preview node) delegates all decisions to that pure math.
 */

export type ShapeGeometry = { x: number; y: number; width: number; height: number }

/** Narrows `ActiveTool` to the three shape-drawing tools this unit adds.
 * Non-component export colocated with the module it belongs to — same
 * pattern as `ObjectShape.tsx`'s `colorForType`. */
// eslint-disable-next-line react-refresh/only-export-components
export function isShapeTool(tool: string): tool is ShapeType {
  return tool === 'shape_rectangle' || tool === 'shape_square' || tool === 'shape_circle'
}

/**
 * Computes the final (snapped, min-size-enforced, bounds-clamped) geometry
 * for a Shape dragged from `start` to `end` (both stage-space points).
 *
 * Order of operations:
 * 1. Snap both corners to the grid independently (matches U7/U8's
 *    snap-then-clamp convention — each corner is a point being placed).
 * 2. Normalize into a top-left `x`/`y` + non-negative `width`/`height` (the
 *    user can drag in any of the four directions from the start point).
 * 3. Degenerate-drag policy (implementer's call per the plan): a drag whose
 *    snapped width/height comes out below `minSize` — including a plain
 *    click with zero movement — is clamped UP to `minSize` rather than
 *    rejected. This keeps the interaction uniform with U8's resize-below-
 *    minimum clamp (same constant, same "clamp, don't reject" policy) and
 *    means a single click always places an immediately-visible, resizable
 *    Shape instead of silently doing nothing.
 * 4. `shape_square` additionally forces `width === height` (the larger of
 *    the two dragged dimensions), since a square's defining constraint is
 *    equal sides — rectangle and circle keep independent width/height.
 * 5. Bounds-clamp the resulting box the same way `coordinates.ts`'s
 *    `clampToBounds` clamps catalog-Object placement.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function computeShapeGeometry(
  type: ShapeType,
  start: Point,
  end: Point,
  gridSize: number,
  canvasWidth: number,
  canvasHeight: number,
  minSize: number = MIN_ITEM_SIZE,
): ShapeGeometry {
  const snappedStart = snapToGrid(start, gridSize)
  const snappedEnd = snapToGrid(end, gridSize)

  const rawX = Math.min(snappedStart.x, snappedEnd.x)
  const rawY = Math.min(snappedStart.y, snappedEnd.y)
  let width = Math.max(Math.abs(snappedEnd.x - snappedStart.x), minSize)
  let height = Math.max(Math.abs(snappedEnd.y - snappedStart.y), minSize)

  if (type === 'shape_square') {
    const side = Math.max(width, height)
    width = side
    height = side
  }

  const clamped = clampToBounds({ x: rawX, y: rawY }, width, height, canvasWidth, canvasHeight)
  return { x: clamped.x, y: clamped.y, width, height }
}

export interface ShapeDrawState {
  type: ShapeType
  start: Point
  current: Point
}

interface UseShapeToolArgs {
  gridSize: number
  canvasWidth: number
  canvasHeight: number
  /** Called with the finished (snapped/clamped) geometry on pointer-up.
   * The caller is responsible for creating the item and resetting
   * `activeTool` back to `'select'` (both live in `canvasStore`, which this
   * hook doesn't reach into directly, matching `Sidebar.tsx`'s `onDrop`
   * callback pattern). */
  onCommit: (type: ShapeType, geometry: ShapeGeometry) => void
}

/**
 * Drives the draw-a-Shape interaction: `pointerdown` records a start point,
 * `pointermove` updates a live preview, `pointerup` commits via `onCommit`.
 * Returns Konva-event handlers to attach to the `Stage` plus the current
 * preview geometry (or `null` when not drawing) for rendering.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useShapeTool({ gridSize, canvasWidth, canvasHeight, onCommit }: UseShapeToolArgs) {
  const [draw, setDraw] = useState<ShapeDrawState | null>(null)

  const startDraw = useCallback((type: ShapeType, point: Point) => {
    setDraw({ type, start: point, current: point })
  }, [])

  const updateDraw = useCallback((point: Point) => {
    setDraw((current) => (current ? { ...current, current: point } : current))
  }, [])

  const endDraw = useCallback(() => {
    setDraw((current) => {
      if (current) {
        const geometry = computeShapeGeometry(
          current.type,
          current.start,
          current.current,
          gridSize,
          canvasWidth,
          canvasHeight,
        )
        onCommit(current.type, geometry)
      }
      return null
    })
  }, [gridSize, canvasWidth, canvasHeight, onCommit])

  const cancelDraw = useCallback(() => setDraw(null), [])

  const previewGeometry: ShapeGeometry | null = draw
    ? computeShapeGeometry(draw.type, draw.start, draw.current, gridSize, canvasWidth, canvasHeight)
    : null

  return {
    isDrawing: draw != null,
    drawType: draw?.type ?? null,
    previewGeometry,
    startDraw,
    updateDraw,
    endDraw,
    cancelDraw,
  }
}

interface ShapePreviewProps {
  type: ShapeType
  geometry: ShapeGeometry
}

/** Live-sizing preview rendered while a Shape is being dragged out — a
 * dashed, semi-transparent treatment (not yet a real Object) so it reads
 * as "in progress" and distinct from committed Objects. Circles render as
 * a true ellipse inscribed in the drag box; rectangle/square render as the
 * box itself. Committed shapes render OUTLINE-ONLY in `ObjectShape` (no
 * fill, no label — fill/border styling is planned as its own feature), so
 * the dashed fill here is deliberately the in-progress affordance, not a
 * promise about the committed look. */
export function ShapePreview({ type, geometry }: ShapePreviewProps) {
  const commonProps = {
    stroke: '#2563eb',
    strokeWidth: 1,
    dash: [4, 4],
    fill: 'rgba(37, 99, 235, 0.15)',
    listening: false,
  }

  if (type === 'shape_circle') {
    return (
      // Ellipse, not Circle (review of user feedback): Konva's Circle only
      // understands `radius` — the radiusX/radiusY props it was given were
      // silently ignored, so the draw preview rendered nothing visible.
      <Ellipse
        x={geometry.x + geometry.width / 2}
        y={geometry.y + geometry.height / 2}
        radiusX={geometry.width / 2}
        radiusY={geometry.height / 2}
        {...commonProps}
      />
    )
  }

  return <Rect x={geometry.x} y={geometry.y} width={geometry.width} height={geometry.height} {...commonProps} />
}
