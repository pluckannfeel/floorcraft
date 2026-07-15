import { forwardRef, useEffect, useRef } from 'react'
import type Konva from 'konva'
import { Layer, Line, Rect, Stage } from 'react-konva'
import { computePinchZoom, computeWheelZoom, screenToStagePoint, shouldHandleDeleteKey } from './coordinates'
import type { ZoomPanState } from './coordinates'
import { LineAnchorHandles } from './LineAnchorHandles'
import { isLineTool, LinePreview, parseLinePoints, useLineTool } from './LineTool'
import { ObjectShape } from './ObjectShape'
import { SelectionTransformer } from './SelectionTransformer'
import type { TransformGeometryPatch } from './SelectionTransformer'
import { isShapeTool, ShapePreview, useShapeTool } from './ShapeTool'
import type { ShapeGeometry } from './ShapeTool'
import type { ActiveTool } from '../state/canvasStore'
import type { CanvasObject, LineType, Point, ShapeType } from './types'

interface CanvasStageProps {
  width: number
  height: number
  gridSize: number
  objects: CanvasObject[]
  selectedItemId: CanvasObject['id'] | null
  onSelectObject: (id: CanvasObject['id'] | null) => void
  /** Commits a drag-reposition's or resize/rotate's final geometry to the
   * store (U8). Optional so callers/tests that don't exercise
   * select/drag/transform can omit it. */
  onGeometryChange?: (
    id: CanvasObject['id'],
    patch: Partial<Pick<CanvasObject, 'x' | 'y' | 'width' | 'height' | 'rotation'>>,
  ) => void
  /** Deletes the currently-selected item (U8's Delete/Backspace shortcut). */
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
 * 3-layer Konva Stage (grid/background, interactive Objects, UI overlay) —
 * NOT the originally-discussed 4-layer grid/structural/interactive/UI split.
 * Per the plan's Key Technical Decisions: once Objects were unified into one
 * model/array, a separate "structural" layer would have no distinct content
 * to hold (e.g. "outlines" is just another catalog type living alongside
 * everything else in the interactive layer), so it's dropped.
 *
 * The UI overlay layer is currently empty — Transformer (U8) and alignment
 * guides (U9/U28) render into it in later units.
 */
export const CanvasStage = forwardRef<Konva.Stage, CanvasStageProps>(function CanvasStage(
  {
    width,
    height,
    gridSize,
    objects,
    selectedItemId,
    onSelectObject,
    onGeometryChange,
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
  // U11: drag-to-pan is only appropriate in 'select' mode — a shape/line
  // tool being active means clicks/drags are for drawing, not navigating,
  // same "route by activeTool" rule the shape/line pointerdown branches
  // below already follow.
  const panEnabled = !drawingShape && !drawingLine

  // U11: two-finger pinch-zoom state. Kept in a ref (not React state) since
  // it's write-only bookkeeping between consecutive `touchmove` events, not
  // something any render depends on — same rationale as `shapeNodesRef`
  // below for why this is a ref instead of state.
  const pinchRef = useRef<{ lastDistance: number } | null>(null)

  // U17: the selected item, when it's a Line, gets `LineAnchorHandles`
  // instead of `SelectionTransformer` — Lines have no box to resize (see
  // `ObjectShape.tsx`'s Line branch). This is the "which selection UI to
  // show" branch point the plan calls out; it lives here (not inside
  // `ObjectShape`) because `SelectionTransformer` itself is already only
  // ever rendered once, at this Stage level, resolving the selected node
  // from the same `shapeNodesRef` Map `ObjectShape`'s `shapeRef` populates.
  const selectedObject = objects.find((object) => object.id === selectedItemId) ?? null
  const selectedIsLine = selectedObject != null && isLineTool(selectedObject.type)

  // Map<id, Konva.Node> resolving the selected item's live node for
  // SelectionTransformer's `.nodes([ref])` attach — populated/cleared by
  // each ObjectShape's `shapeRef` callback as items mount/unmount.
  const shapeNodesRef = useRef(new Map<CanvasObject['id'], Konva.Node>())

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
      const activeElementTag = document.activeElement?.tagName
      if (shouldHandleDeleteKey(event.key, selectedItemId, activeElementTag)) {
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
  }, [selectedItemId, onDeleteSelected, drawingLine, lineTool.finishDraw])

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
      ref={ref}
      width={width}
      height={height}
      scaleX={zoom}
      scaleY={zoom}
      x={stagePosition.x}
      y={stagePosition.y}
      draggable={panEnabled}
      onDragEnd={(event) => {
        // Only the Stage's own drag (empty-canvas pan) should reach here —
        // an Object's drag (`ObjectShape.tsx`'s Group) stops at that Group
        // and never bubbles a `dragend` up to the Stage, since Konva
        // dispatches `dragend` on the node that was actually being dragged,
        // not every ancestor. The `event.target === stage` guard below is
        // therefore belt-and-suspenders should that assumption ever change.
        if (!panEnabled) return
        const stage = event.target.getStage()
        if (!stage || event.target !== stage) return
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
        const container = stage.container()
        const rect = container.getBoundingClientRect()
        const toContainerPoint = (touch: Touch): Point => ({
          x: touch.clientX - rect.left,
          y: touch.clientY - rect.top,
        })
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
        // U15: a shape tool is active — start (or, per Konva's docs,
        // implicitly restart) a drag-to-size instead of the normal
        // click-to-select-or-clear behavior below.
        if (drawingShape) {
          const stage = event.target.getStage()
          if (!stage) return
          const point = screenToStagePoint(stage, event.evt.clientX, event.evt.clientY)
          shapeTool.startDraw(activeTool, point)
          return
        }
        // U16: a line tool is active — point placement/finishing is driven
        // entirely by `onClick`/`onDblClick`/Escape below, not `pointerdown`;
        // just suppress the normal click-to-clear-selection behavior below
        // so an in-progress draw's clicks don't also clear selection.
        if (drawingLine) {
          return
        }
        // Clicking empty stage space clears selection.
        if (event.target === event.target.getStage()) {
          onSelectObject(null)
        }
      }}
      onPointerMove={(event) => {
        if (!drawingShape || !shapeTool.isDrawing) return
        const stage = event.target.getStage()
        if (!stage) return
        const point = screenToStagePoint(stage, event.evt.clientX, event.evt.clientY)
        shapeTool.updateDraw(point)
      }}
      onPointerUp={() => {
        if (!drawingShape || !shapeTool.isDrawing) return
        shapeTool.endDraw()
      }}
      onClick={(event) => {
        if (!drawingLine) return
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
          an existing Object underneath the drag/click. */}
      <Layer listening={!drawingShape && !drawingLine}>
        {objects.map((object) => (
          <ObjectShape
            key={object.id}
            object={object}
            isSelected={object.id === selectedItemId}
            onSelect={onSelectObject}
            gridSize={gridSize}
            canvasWidth={width}
            canvasHeight={height}
            onGeometryChange={onGeometryChange}
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
          (U15), Line draw preview (U16); alignment guides land here in a
          later unit. Must remain
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
            selectedItemId={selectedItemId}
            getNode={(id) => shapeNodesRef.current.get(id)}
            canvasWidth={width}
            canvasHeight={height}
            onTransformEnd={(id, patch: TransformGeometryPatch) => onGeometryChange?.(id, patch)}
          />
        )}
        {shapeTool.isDrawing && shapeTool.drawType && shapeTool.previewGeometry && (
          <ShapePreview type={shapeTool.drawType} geometry={shapeTool.previewGeometry} />
        )}
        {lineTool.isDrawing && <LinePreview points={lineTool.points} />}
      </Layer>
    </Stage>
  )
})
