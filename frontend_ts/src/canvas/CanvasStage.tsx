import { forwardRef, useEffect, useRef } from 'react'
import type Konva from 'konva'
import { Layer, Line, Rect, Stage } from 'react-konva'
import { shouldHandleDeleteKey } from './coordinates'
import { ObjectShape } from './ObjectShape'
import { SelectionTransformer } from './SelectionTransformer'
import type { TransformGeometryPatch } from './SelectionTransformer'
import type { CanvasObject } from './types'

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
  { width, height, gridSize, objects, selectedItemId, onSelectObject, onGeometryChange, onDeleteSelected },
  ref,
) {
  const gridLines = buildGridLines(width, height, gridSize)

  // Map<id, Konva.Node> resolving the selected item's live node for
  // SelectionTransformer's `.nodes([ref])` attach — populated/cleared by
  // each ObjectShape's `shapeRef` callback as items mount/unmount.
  const shapeNodesRef = useRef(new Map<CanvasObject['id'], Konva.Node>())

  // U8: Delete/Backspace removes the selected item. A window-level listener
  // (not a Stage keydown handler) since Konva Stages aren't natively
  // focusable/don't receive keyboard events by default.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const activeElementTag = document.activeElement?.tagName
      if (shouldHandleDeleteKey(event.key, selectedItemId, activeElementTag)) {
        onDeleteSelected?.()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedItemId, onDeleteSelected])

  return (
    <Stage
      ref={ref}
      width={width}
      height={height}
      onMouseDown={(event) => {
        // Clicking empty stage space clears selection.
        if (event.target === event.target.getStage()) {
          onSelectObject(null)
        }
      }}
    >
      {/* Grid/background layer: static, non-interactive. */}
      <Layer listening={false}>
        <Rect x={0} y={0} width={width} height={height} fill="#f9fafb" />
        {gridLines.map((points, index) => (
          <Line key={index} points={points} stroke="#e5e7eb" strokeWidth={1} />
        ))}
      </Layer>

      {/* Interactive Objects layer. */}
      <Layer>
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

      {/* UI overlay layer: SelectionTransformer (U8); alignment guides land
          here in a later unit. Must remain listening (not `listening={false}`
          like the grid layer) since the Transformer's handles are interactive. */}
      <Layer>
        <SelectionTransformer
          selectedItemId={selectedItemId}
          getNode={(id) => shapeNodesRef.current.get(id)}
          canvasWidth={width}
          canvasHeight={height}
          onTransformEnd={(id, patch: TransformGeometryPatch) => onGeometryChange?.(id, patch)}
        />
      </Layer>
    </Stage>
  )
})
