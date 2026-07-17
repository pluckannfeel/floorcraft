import type Konva from 'konva'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { redo, undo, useCanvasStore } from '../state/canvasStore'
import { resolveAlignmentAvailability } from './alignment'
import type { AlignKind, DistributeAxis } from './alignment'
import { exportStageToPng } from './export'
import type { CanvasObject } from './types'

/** U6's six align actions, in the conventional left→right then top→bottom
 * order, with lucide's object-alignment icons ("start/end vertical" = the
 * vertical reference edge objects align their left/right sides to, etc.). */
const ALIGN_ACTIONS: { kind: AlignKind; label: string; Icon: LucideIcon }[] = [
  { kind: 'left', label: 'Align left', Icon: AlignStartVertical },
  { kind: 'centerH', label: 'Align horizontal center', Icon: AlignCenterVertical },
  { kind: 'right', label: 'Align right', Icon: AlignEndVertical },
  { kind: 'top', label: 'Align top', Icon: AlignStartHorizontal },
  { kind: 'middleV', label: 'Align vertical middle', Icon: AlignCenterHorizontal },
  { kind: 'bottom', label: 'Align bottom', Icon: AlignEndHorizontal },
]

/** U6's two distribute actions. */
const DISTRIBUTE_ACTIONS: { axis: DistributeAxis; label: string; Icon: LucideIcon }[] = [
  { axis: 'horizontal', label: 'Distribute horizontally', Icon: AlignHorizontalDistributeCenter },
  { axis: 'vertical', label: 'Distribute vertically', Icon: AlignVerticalDistributeCenter },
]

/** The disabled distribute buttons' tooltip (U6): distributing spaces box
 * CENTERS between the two extremes, so it needs at least 3 boxes — a group
 * counts as ONE box, matching `resolveAlignmentAvailability`. */
const DISTRIBUTE_DISABLED_TOOLTIP = 'needs 3+ objects'

/** Thin vertical rule separating the toolbar's control groups. */
function ToolbarDivider() {
  return <div className="mx-1 w-px self-stretch bg-border" aria-hidden="true" />
}

/**
 * Canvas editor toolbar: undo/redo, zoom (U11), PNG export (U12), z-order
 * (U18), and align/distribute (U6). The DRAWING tools (shapes, lines, text,
 * crop) lived here through canvas-tools U8; U9 moved them into
 * `Sidebar.tsx`'s tool strip (R24), so this component now holds only the
 * non-tool controls.
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
  /** U18/U1: the current selection set — "Bring to front"/"Send to back"
   * are only meaningful (and only rendered enabled) when at least one
   * Object is selected, same selection-gating `Toolbar.tsx` would use for
   * a Delete button if one lived here (U8's Delete is instead a keyboard
   * shortcut on `CanvasStage.tsx`, but the gating logic mirrors it: no-op
   * without a selection). */
  selectedItemIds: CanvasObject['id'][]
  /** U18/U1: commits a z-order change for the WHOLE selection — thin
   * delegation to the store's batched `reorderZIndexItems` action (one
   * history entry however many items are selected; front preserves the
   * batch's relative order above the previous max, back below the min),
   * matching how `onGeometryChange`/`onDeleteSelected` delegate their
   * store writes from `CanvasStage.tsx`. */
  onReorderZIndex: (ids: CanvasObject['id'][], direction: 'front' | 'back') => void
  /** U6: aligns the current selection (one batched `updateItemsGeometry`
   * entry — see `alignment.ts`'s `buildAlignPatches`). Thin delegation like
   * `onReorderZIndex`. */
  onAlignSelection: (kind: AlignKind) => void
  /** U6: distributes the current selection's boxes (one batched entry —
   * `buildDistributePatches`). */
  onDistributeSelection: (axis: DistributeAxis) => void
}

export function Toolbar({
  getStage,
  selectedItemIds,
  onReorderZIndex,
  onAlignSelection,
  onDistributeSelection,
}: ToolbarProps) {
  const canUndo = useStore(useCanvasStore.temporal, (state) => state.pastStates.length > 0)
  const canRedo = useStore(useCanvasStore.temporal, (state) => state.futureStates.length > 0)
  const zoom = useCanvasStore((state) => state.zoom)
  const zoomIn = useCanvasStore((state) => state.zoomIn)
  const zoomOut = useCanvasStore((state) => state.zoomOut)
  const resetZoom = useCanvasStore((state) => state.resetZoom)
  const clearSelection = useCanvasStore((state) => state.clearSelection)
  // U6: the align section's gating needs the items themselves (a group
  // collapses to ONE distribute box, and ghost selection ids must not
  // count) — read straight off the store like `activeTool`/`zoom` above.
  const items = useCanvasStore((state) => state.items)
  const alignment = resolveAlignmentAvailability(selectedItemIds, items)

  // U12: clears selection (detaching Transformer/anchor handles), waits for
  // that to actually redraw, then downloads a PNG snapshot — see
  // `export.ts`'s doc comment for why the clear-then-wait sequencing is
  // needed instead of exporting immediately.
  const handleExport = () => {
    const stage = getStage()
    if (!stage) return
    exportStageToPng(stage, selectedItemIds, clearSelection)
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

      {/* U18/U1: z-order controls, gated on a non-empty selection —
          clicking renumbers EVERY selected Object past the current max/min
          among `items`, preserving the selection's own relative order, in
          one history entry (see `canvasStore.ts`'s `reorderZIndexItems`).
          Purely a local `items` state change (persists on explicit Save);
          render order itself comes from `CanvasStage.tsx` sorting
          `objects` by `z_index`, not from anything these buttons do
          directly. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => selectedItemIds.length > 0 && onReorderZIndex(selectedItemIds, 'front')}
        disabled={selectedItemIds.length === 0}
      >
        Bring to Front
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => selectedItemIds.length > 0 && onReorderZIndex(selectedItemIds, 'back')}
        disabled={selectedItemIds.length === 0}
      >
        Send to Back
      </Button>

      {/* U6: align/distribute. The whole section renders only for 2+
          selected items (plan: no point showing alignment for 0-1
          objects); within it, the distribute buttons use the shadcn
          disabled treatment until the selection partitions into 3+ BOXES
          (a persistent group counts as one box) — the same
          disabled-not-hidden convention the context menu's entries follow.
          The tooltip rides a wrapping span because the Button's disabled
          state includes pointer-events-none, which would swallow a title
          set on the button itself. */}
      {alignment.canAlign && (
        <>
          <ToolbarDivider />
          {ALIGN_ACTIONS.map(({ kind, label, Icon }) => (
            <Button
              key={kind}
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={label}
              title={label}
              onClick={() => onAlignSelection(kind)}
            >
              <Icon />
            </Button>
          ))}
          {DISTRIBUTE_ACTIONS.map(({ axis, label, Icon }) => (
            <span
              key={axis}
              className="inline-flex"
              title={alignment.canDistribute ? label : DISTRIBUTE_DISABLED_TOOLTIP}
            >
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={label}
                disabled={!alignment.canDistribute}
                onClick={() => onDistributeSelection(axis)}
              >
                <Icon />
              </Button>
            </span>
          ))}
        </>
      )}
    </div>
  )
}
