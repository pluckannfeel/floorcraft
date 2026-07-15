import { useStore } from 'zustand'
import { redo, undo, useCanvasStore } from '../state/canvasStore'

/**
 * Canvas editor toolbar (U9: undo/redo only). Later units append more
 * controls to this same component — zoom (U11/U12), drawing tools
 * (U15/U16), export (U18), z-order (U18/U19) — per the plan's Output
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
    </div>
  )
}
