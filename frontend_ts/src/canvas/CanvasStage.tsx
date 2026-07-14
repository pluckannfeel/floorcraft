import { forwardRef } from 'react'
import type Konva from 'konva'
import { Layer, Line, Rect, Stage } from 'react-konva'
import { ObjectShape } from './ObjectShape'
import type { CanvasObject } from './types'

interface CanvasStageProps {
  width: number
  height: number
  gridSize: number
  objects: CanvasObject[]
  selectedItemId: CanvasObject['id'] | null
  onSelectObject: (id: CanvasObject['id'] | null) => void
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
  { width, height, gridSize, objects, selectedItemId, onSelectObject },
  ref,
) {
  const gridLines = buildGridLines(width, height, gridSize)

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
          />
        ))}
      </Layer>

      {/* UI overlay layer: Transformer/alignment guides land here in later units. */}
      <Layer listening={false} />
    </Stage>
  )
})
