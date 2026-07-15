import { useStore } from 'zustand'
import { redo, undo, useCanvasStore } from '../state/canvasStore'
import type { LineType, ShapeType } from './types'

/** U15's three shape-drawing tools, with their toolbar labels. */
const SHAPE_TOOLS: { type: ShapeType; label: string }[] = [
  { type: 'shape_rectangle', label: 'Rectangle' },
  { type: 'shape_square', label: 'Square' },
  { type: 'shape_circle', label: 'Circle' },
]

/** U16's three line-drawing tools, with their toolbar labels. */
const LINE_TOOLS: { type: LineType; label: string }[] = [
  { type: 'line_straight', label: 'Line' },
  { type: 'line_curved', label: 'Curved Line' },
  { type: 'line_s_curve', label: 'S-Curve Line' },
]

/**
 * Canvas editor toolbar (U9: undo/redo; U15: shape drawing tools; U16: line
 * drawing tools). Later units append more controls to this same component —
 * zoom (U11/U12), export (U18), z-order (U18/U19) — per the plan's Output
 * Structure, rather than each unit creating a separate toolbar.
 *
 * Undo/redo availability comes from zundo's temporal store
 * (`useCanvasStore.temporal`), a separate vanilla store from the main
 * `useCanvasStore` — subscribed here via zustand's `useStore` so the
 * buttons re-render as `pastStates`/`futureStates` change.
 */
export function Toolbar() {
  const canUndo = useStore(useCanvasStore.temporal, (state) => state.pastStates.length > 0)
  const canRedo = useStore(useCanvasStore.temporal, (state) => state.futureStates.length > 0)
  const activeTool = useCanvasStore((state) => state.activeTool)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 16px',
        borderBottom: '1px solid #e5e7eb',
      }}
    >
      <button type="button" onClick={() => undo()} disabled={!canUndo}>
        Undo
      </button>
      <button type="button" onClick={() => redo()} disabled={!canRedo}>
        Redo
      </button>

      <div style={{ width: 1, backgroundColor: '#e5e7eb', margin: '0 4px' }} aria-hidden="true" />

      {/* Selecting a shape tool sets `activeTool` (U9's field); ShapeTool
          watches it to drive the draw interaction. Clicking the
          already-active tool toggles back to `'select'` so a tool can be
          cancelled without drawing anything. */}
      {SHAPE_TOOLS.map(({ type, label }) => {
        const isActive = activeTool === type
        return (
          <button
            key={type}
            type="button"
            aria-pressed={isActive}
            onClick={() => setActiveTool(isActive ? 'select' : type)}
            style={{
              fontWeight: isActive ? 700 : 400,
              backgroundColor: isActive ? '#dbeafe' : undefined,
              border: isActive ? '1px solid #2563eb' : '1px solid #d1d5db',
            }}
          >
            {label}
          </button>
        )
      })}

      <div style={{ width: 1, backgroundColor: '#e5e7eb', margin: '0 4px' }} aria-hidden="true" />

      {/* U16: selecting a line tool sets `activeTool` the same way shape
          tools do; LineTool/CanvasStage watch it to drive the click-per-point
          draw interaction. Same toggle-back-to-'select' behavior as shape
          tools above. */}
      {LINE_TOOLS.map(({ type, label }) => {
        const isActive = activeTool === type
        return (
          <button
            key={type}
            type="button"
            aria-pressed={isActive}
            onClick={() => setActiveTool(isActive ? 'select' : type)}
            style={{
              fontWeight: isActive ? 700 : 400,
              backgroundColor: isActive ? '#fee2e2' : undefined,
              border: isActive ? '1px solid #dc2626' : '1px solid #d1d5db',
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
