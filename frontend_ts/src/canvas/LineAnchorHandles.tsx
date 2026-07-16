import type Konva from 'konva'
import { Circle, Group } from 'react-konva'
import { clampToBounds, snapToGrid } from './coordinates'
import { flattenPoints } from './LineTool'
import type { CanvasObject, Point } from './types'

/**
 * U17: renders one small draggable `Konva.Circle` per point of a selected
 * Line's `properties.points` array, in place of U8's `SelectionTransformer`
 * (Lines have no width/height "box" to resize — see `ObjectShape.tsx`'s
 * Line branch and the plan's Key Technical Decisions).
 *
 * Each circle is positioned at the point's own absolute canvas coordinates
 * (matching the underlying `Konva.Line`'s own points, which are absolute —
 * the `Line` node's `x`/`y` stays at the Group's origin, never transformed
 * as a whole). Dragging a circle does NOT move the `Line` node itself;
 * instead:
 *   - `dragBoundFunc` snaps to grid and clamps to canvas bounds during the
 *     drag, exactly like any other Object's drag (R25) — reusing the same
 *     `snapToGrid`/`clampToBounds` helpers `ObjectShape.tsx` and
 *     `LineTool.tsx` already use.
 *   - `onDragMove` imperatively updates the live `Konva.Line` node's
 *     `points` from the ref (cheap native Konva movement, no React
 *     re-render per frame) so the rendered path visually follows the
 *     handle during the drag — the same "ref-during-drag" pattern U8's
 *     `SelectionTransformer` uses for resize/rotate.
 *   - `onDragEnd` commits the final point to the store via
 *     `onPointDragEnd(index, point)` — wired by the caller to
 *     `canvasStore`'s `updateLinePoints` (undo-tracked; see that store's
 *     "U17 decision" doc comment for the reasoning).
 *
 * Adding new points after initial placement is explicitly unsupported
 * (R26) — there is no click-on-the-line-to-insert-a-point affordance here.
 */

const ANCHOR_RADIUS = 5
const ANCHOR_FILL = '#ffffff'
const ANCHOR_STROKE = '#111827'

export interface LineAnchorHandlesProps {
  object: CanvasObject
  points: Point[]
  gridSize: number
  canvasWidth: number
  canvasHeight: number
  /** Commits the final (already snapped/clamped) position of the point at
   * `pointIndex` on `dragend`. */
  onPointDragEnd: (id: CanvasObject['id'], pointIndex: number, point: Point) => void
  /** The live `Konva.Line` node this Line renders as (`ObjectShape.tsx`'s
   * `shapeRef`-registered node) — updated imperatively during drag for
   * live visual feedback. Optional so tests/callers that don't need live
   * feedback (e.g. before the Line's node has mounted) can omit it. */
  getLineNode?: () => Konva.Line | undefined | null
}

/**
 * Builds the `dragBoundFunc` an anchor `Circle` drags through: snap-then-
 * clamp, exactly `coordinates.ts`'s established order (Key Technical
 * Decisions). A point has no width/height of its own — clamping with 0/0
 * simply keeps the point itself within `[0, canvasWidth] x [0, canvasHeight]`,
 * matching `LineTool.tsx`'s `addPoint` convention for the same reason.
 * Exported (alongside `updatePointAt`) so the actual snap/clamp decision
 * logic is directly unit-testable without mounting a real Konva `Circle`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function anchorDragBoundFunc(gridSize: number, canvasWidth: number, canvasHeight: number) {
  return function dragBoundFunc(this: Konva.Node, pos: Point): Point {
    return clampToBounds(snapToGrid(pos, gridSize), 0, 0, canvasWidth, canvasHeight)
  }
}

/**
 * Returns a copy of `points` with the entry at `index` replaced by
 * `newPoint`, leaving every other point's coordinates unchanged. Pure and
 * Konva-independent so the "only the dragged point changes" behavior is
 * directly testable without mounting a real `Circle`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function updatePointAt(points: Point[], index: number, newPoint: Point): Point[] {
  return points.map((point, i) => (i === index ? newPoint : point))
}

export function LineAnchorHandles({
  object,
  points,
  gridSize,
  canvasWidth,
  canvasHeight,
  onPointDragEnd,
  getLineNode,
}: LineAnchorHandlesProps) {
  const dragBoundFunc = anchorDragBoundFunc(gridSize, canvasWidth, canvasHeight)

  return (
    <Group>
      {points.map((point, index) => (
        <Circle
          key={index}
          x={point.x}
          y={point.y}
          radius={ANCHOR_RADIUS}
          fill={ANCHOR_FILL}
          stroke={ANCHOR_STROKE}
          strokeWidth={1.5}
          draggable
          dragBoundFunc={dragBoundFunc}
          onDragMove={(event) => {
            const node = event.target
            const liveNode = getLineNode?.()
            if (!liveNode) return
            const nextPoints = updatePointAt(points, index, { x: node.x(), y: node.y() })
            liveNode.points(flattenPoints(nextPoints))
            liveNode.getLayer()?.batchDraw()
          }}
          onDragEnd={(event) => {
            const node = event.target
            onPointDragEnd(object.id, index, { x: node.x(), y: node.y() })
          }}
        />
      ))}
    </Group>
  )
}
