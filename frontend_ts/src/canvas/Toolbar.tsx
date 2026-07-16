import type Konva from 'konva'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { redo, undo, useCanvasStore } from '../state/canvasStore'
import { exportStageToPng } from './export'
import type { CanvasObject, LineType, ShapeType } from './types'

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

/** Thin vertical rule separating the toolbar's control groups. */
function ToolbarDivider() {
  return <div className="mx-1 w-px self-stretch bg-border" aria-hidden="true" />
}

/**
 * Canvas editor toolbar (U9: undo/redo; U15: shape drawing tools; U16: line
 * drawing tools; U12: PNG export; U18: z-order). Later units append more
 * controls to this same component per the plan's Output Structure, rather
 * than each unit creating a separate toolbar.
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
  /** U18: the currently-selected Object's id, or `null` when nothing is
   * selected — "Bring to front"/"Send to back" are only meaningful (and
   * only rendered enabled) when an Object is selected, same
   * selection-gating `Toolbar.tsx` would use for a Delete button if one
   * lived here (U8's Delete is instead a keyboard shortcut on
   * `CanvasStage.tsx`, but the gating logic mirrors it: no-op without a
   * selection). */
  selectedItemId: CanvasObject['id'] | null
  /** U18: commits a z-order change for the selected item — thin delegation
   * to the store's `reorderZIndex` action, matching how `onGeometryChange`/
   * `onDeleteSelected` delegate their store writes from `CanvasStage.tsx`. */
  onReorderZIndex: (id: CanvasObject['id'], direction: 'front' | 'back') => void
}

export function Toolbar({ getStage, selectedItemId, onReorderZIndex }: ToolbarProps) {
  const canUndo = useStore(useCanvasStore.temporal, (state) => state.pastStates.length > 0)
  const canRedo = useStore(useCanvasStore.temporal, (state) => state.futureStates.length > 0)
  const activeTool = useCanvasStore((state) => state.activeTool)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)
  const zoom = useCanvasStore((state) => state.zoom)
  const zoomIn = useCanvasStore((state) => state.zoomIn)
  const zoomOut = useCanvasStore((state) => state.zoomOut)
  const resetZoom = useCanvasStore((state) => state.resetZoom)
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
    <div className="flex gap-2 border-b px-4 py-2">
      <Button type="button" variant="outline" size="sm" onClick={() => undo()} disabled={!canUndo}>
        Undo
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => redo()} disabled={!canRedo}>
        Redo
      </Button>

      <ToolbarDivider />

      {/* Selecting a shape tool sets `activeTool` (U9's field); ShapeTool
          watches it to drive the draw interaction. Clicking the
          already-active tool toggles back to `'select'` so a tool can be
          cancelled without drawing anything. The active tool is signalled
          via the filled `default` variant (plus `aria-pressed`). */}
      {SHAPE_TOOLS.map(({ type, label }) => {
        const isActive = activeTool === type
        return (
          <Button
            key={type}
            type="button"
            variant={isActive ? 'default' : 'outline'}
            size="sm"
            aria-pressed={isActive}
            onClick={() => setActiveTool(isActive ? 'select' : type)}
          >
            {label}
          </Button>
        )
      })}

      <ToolbarDivider />

      {/* U16: selecting a line tool sets `activeTool` the same way shape
          tools do; LineTool/CanvasStage watch it to drive the click-per-point
          draw interaction. Same toggle-back-to-'select' behavior (and same
          active-variant signalling) as shape tools above. */}
      {LINE_TOOLS.map(({ type, label }) => {
        const isActive = activeTool === type
        return (
          <Button
            key={type}
            type="button"
            variant={isActive ? 'default' : 'outline'}
            size="sm"
            aria-pressed={isActive}
            onClick={() => setActiveTool(isActive ? 'select' : type)}
          >
            {label}
          </Button>
        )
      })}

      <ToolbarDivider />

      {/* U11: zoom in/out/reset — the button-driven alternative to wheel
          scroll/pinch. Anchored at the current pan position (no cursor
          position exists for a button click, unlike wheel/pinch's
          zoom-to-point behavior); Reset returns to 1x at the origin. */}
      <Button type="button" variant="outline" size="icon-sm" onClick={() => zoomOut()} aria-label="Zoom out">
        −
      </Button>
      <span className="min-w-12 self-center text-center text-sm tabular-nums">{Math.round(zoom * 100)}%</span>
      <Button type="button" variant="outline" size="icon-sm" onClick={() => zoomIn()} aria-label="Zoom in">
        +
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => resetZoom()} aria-label="Reset zoom">
        Reset
      </Button>

      <ToolbarDivider />

      {/* U12: exports the current floor plan as a PNG download. */}
      <Button type="button" variant="outline" size="sm" onClick={handleExport}>
        Export PNG
      </Button>

      <ToolbarDivider />

      {/* U18: z-order controls, gated on a selection existing — clicking
          sets the selected Object's z_index to one past the current
          max/min among `items` (see `canvasStore.ts`'s `reorderZIndex`).
          Purely a local `items` state change (no backend persistence yet —
          that's U13); render order itself comes from `CanvasStage.tsx`
          sorting `objects` by `z_index`, not from anything these buttons do
          directly. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => selectedItemId != null && onReorderZIndex(selectedItemId, 'front')}
        disabled={selectedItemId == null}
      >
        Bring to Front
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => selectedItemId != null && onReorderZIndex(selectedItemId, 'back')}
        disabled={selectedItemId == null}
      >
        Send to Back
      </Button>
    </div>
  )
}
