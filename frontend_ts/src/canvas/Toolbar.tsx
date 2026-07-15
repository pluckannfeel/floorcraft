import type Konva from 'konva'
import { useStore } from 'zustand'
import { redo, undo, useCanvasStore } from '../state/canvasStore'
import { exportStageToPng } from './export'
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
 * drawing tools; U12: PNG export). Later units append more controls to this
 * same component — z-order (U18/U19) — per the plan's Output Structure,
 * rather than each unit creating a separate toolbar.
 *
 * Undo/redo availability comes from zundo's temporal store
 * (`useCanvasStore.temporal`), a separate vanilla store from the main
 * `useCanvasStore` — subscribed here via zustand's `useStore` so the
 * buttons re-render as `pastStates`/`futureStates` change.
 */
interface ToolbarProps {
  /** Returns the live Konva.Stage instance for U12's export button. Passed
   * in as a prop rather than Toolbar owning a ref itself, since the Stage
   * instance is created (and its ref held) by `CanvasEditorPage` — the same
   * getStage-as-prop pattern `Sidebar.tsx` already uses for its
   * drop-coordinate conversion. */
  getStage: () => Konva.Stage | null
}

export function Toolbar({ getStage }: ToolbarProps) {
  const canUndo = useStore(useCanvasStore.temporal, (state) => state.pastStates.length > 0)
  const canRedo = useStore(useCanvasStore.temporal, (state) => state.futureStates.length > 0)
  const activeTool = useCanvasStore((state) => state.activeTool)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)
  const zoom = useCanvasStore((state) => state.zoom)
  const zoomIn = useCanvasStore((state) => state.zoomIn)
  const zoomOut = useCanvasStore((state) => state.zoomOut)
  const resetZoom = useCanvasStore((state) => state.resetZoom)
  const selectedItemId = useCanvasStore((state) => state.selectedItemId)
  const selectItem = useCanvasStore((state) => state.selectItem)

  // U12: clears selection (detaching Transformer/anchor handles), waits for
  // that to actually redraw, then downloads a PNG snapshot — see
  // `export.ts`'s doc comment for why the clear-then-wait sequencing is
  // needed instead of exporting immediately.
  const handleExport = () => {
    const stage = getStage()
    if (!stage) return
    exportStageToPng(stage, selectedItemId, selectItem)
  }

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

      <div style={{ width: 1, backgroundColor: '#e5e7eb', margin: '0 4px' }} aria-hidden="true" />

      {/* U11: zoom in/out/reset — the button-driven alternative to wheel
          scroll/pinch. Anchored at the current pan position (no cursor
          position exists for a button click, unlike wheel/pinch's
          zoom-to-point behavior); Reset returns to 1x at the origin. */}
      <button type="button" onClick={() => zoomOut()} aria-label="Zoom out">
        −
      </button>
      <span style={{ minWidth: 48, textAlign: 'center', alignSelf: 'center' }}>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => zoomIn()} aria-label="Zoom in">
        +
      </button>
      <button type="button" onClick={() => resetZoom()} aria-label="Reset zoom">
        Reset
      </button>

      <div style={{ width: 1, backgroundColor: '#e5e7eb', margin: '0 4px' }} aria-hidden="true" />

      {/* U12: exports the current floor plan as a PNG download. */}
      <button type="button" onClick={handleExport}>
        Export PNG
      </button>
    </div>
  )
}
