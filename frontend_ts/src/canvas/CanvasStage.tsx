import { forwardRef, useEffect, useRef } from 'react'
import type Konva from 'konva'
import { Layer, Line, Rect, Stage } from 'react-konva'
import { screenToStagePoint, shouldHandleDeleteKey } from './coordinates'
import { isLineTool, LinePreview, useLineTool } from './LineTool'
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
  },
  ref,
) {
  const gridLines = buildGridLines(width, height, gridSize)
  const drawingShape = isShapeTool(activeTool)
  const drawingLine = isLineTool(activeTool)

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
        <SelectionTransformer
          selectedItemId={selectedItemId}
          getNode={(id) => shapeNodesRef.current.get(id)}
          canvasWidth={width}
          canvasHeight={height}
          onTransformEnd={(id, patch: TransformGeometryPatch) => onGeometryChange?.(id, patch)}
        />
        {shapeTool.isDrawing && shapeTool.drawType && shapeTool.previewGeometry && (
          <ShapePreview type={shapeTool.drawType} geometry={shapeTool.previewGeometry} />
        )}
        {lineTool.isDrawing && <LinePreview points={lineTool.points} />}
      </Layer>
    </Stage>
  )
})
