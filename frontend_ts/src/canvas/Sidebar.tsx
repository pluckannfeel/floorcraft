import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type Konva from 'konva'
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Crop,
  Hand,
  MousePointer2,
  Minus,
  Spline,
  Square,
  RectangleHorizontal,
  Type,
  Waves,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCanvasStore, type ActiveTool } from '../state/canvasStore'
import { colorForType } from './ObjectShape'
import { clampToBounds, screenToStagePoint, snapToGrid } from './coordinates'
import type { CatalogType, Point } from './types'

const CATALOG_LABELS: Record<CatalogType, string> = {
  outlines: 'Outline',
  tables: 'Table',
  doors: 'Door',
  chairs: 'Chair',
  furnitures: 'Furniture',
  appliances: 'Appliance',
  lighting: 'Lighting',
}

/** U9 (canvas-tools): the catalog's collapsible sections. The taxonomy is
 * purely presentational (R25 leaves the grouping to the implementer):
 * building fabric first, then the furniture people arrange, then fixed
 * equipment. Every `CatalogType` appears in exactly one section. */
const CATALOG_SECTIONS: { title: string; types: CatalogType[] }[] = [
  { title: 'Structure', types: ['outlines', 'doors'] },
  { title: 'Furniture', types: ['tables', 'chairs', 'furnitures'] },
  { title: 'Fixtures', types: ['appliances', 'lighting'] },
]

/** U9 (canvas-tools): the sidebar tool strip — an explicit Select button
 * plus every drawing tool (U15 shapes, U16 lines, U7 text, U8 crop), moved
 * here from `Toolbar.tsx`. Labels and lucide icons carry over unchanged
 * (only Crop had an icon in the toolbar). */
/** Every tool carries an icon (canvas-tools follow-up: icon + label reads
 * faster than a wall of text labels). `'pan'` leads because it's the idle
 * mode every other tool toggles back to. */
const TOOL_BUTTONS: { type: ActiveTool; label: string; Icon: LucideIcon }[] = [
  { type: 'pan', label: 'Pan', Icon: Hand },
  { type: 'select', label: 'Select', Icon: MousePointer2 },
  { type: 'shape_rectangle', label: 'Rectangle', Icon: RectangleHorizontal },
  { type: 'shape_square', label: 'Square', Icon: Square },
  { type: 'shape_circle', label: 'Circle', Icon: Circle },
  { type: 'line_straight', label: 'Line', Icon: Minus },
  { type: 'line_curved', label: 'Curved Line', Icon: Spline },
  { type: 'line_s_curve', label: 'S-Curve Line', Icon: Waves },
  { type: 'text', label: 'Text', Icon: Type },
  { type: 'crop', label: 'Crop', Icon: Crop },
]

/** Matches the backend `Objects` model's default `width`/`height` (40) —
 * see Key Technical Decisions: all catalog types share this default. */
export const DEFAULT_ITEM_SIZE = 40

interface SidebarProps {
  /** Returns the live Konva.Stage instance so drop coordinates can be
   * computed against its current transform (zoom/pan-aware). */
  getStage: () => Konva.Stage | null
  gridSize: number
  /** U8 (canvas-tools): fed from the STORE's live `canvasSize` (not the
   * floor-plan query) so drops clamp against the possibly-cropped canvas
   * the user is actually looking at. */
  canvasWidth: number
  canvasHeight: number
  /** Called with the catalog type and the snapped/clamped stage-space drop
   * point once a drag ends over the canvas. */
  onDrop: (type: CatalogType, point: Point) => void
}

interface DragState {
  type: CatalogType
  clientX: number
  clientY: number
}

/**
 * R9/R24/R25: sidebar hosting the tool strip (U9 — Select, shapes, lines,
 * Text, Crop, moved from the toolbar with the same toggle/active-variant/
 * `aria-pressed` conventions) above the catalog of the 7 droppable Object
 * types, grouped into collapsible sections.
 *
 * Each catalog entry starts a custom pointer-based drag on `onPointerDown`
 * (NOT native HTML `draggable`, which doesn't give us the
 * sub-pixel/transform-aware control needed for grid-snapping against a
 * zoomed/panned Konva stage) — a floating preview `div` follows the
 * pointer, and on global `pointerup` the drop position is computed only if
 * the release happened over the canvas container's bounding rect. That flow
 * is untouched by U9's regrouping: a collapsed section simply doesn't
 * render its entries, and re-expanding restores the exact same nodes.
 */
export function Sidebar({ getStage, gridSize, canvasWidth, canvasHeight, onDrop }: SidebarProps) {
  const [drag, setDrag] = useState<DragState | null>(null)
  // U9: one open/closed flag per section, default all open. Plain local
  // state (no persistence) — collapsing is a transient browse aid.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CATALOG_SECTIONS.map(({ title }) => [title, true])),
  )
  const activeTool = useCanvasStore((state) => state.activeTool)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)

  const endDrag = useCallback(
    (active: DragState, clientX: number, clientY: number) => {
      const stage = getStage()
      if (!stage) return

      const rect = stage.container().getBoundingClientRect()
      const overCanvas =
        clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
      if (!overCanvas) return

      const stagePoint = screenToStagePoint(stage, clientX, clientY)
      const snapped = snapToGrid(stagePoint, gridSize)
      const clamped = clampToBounds(snapped, DEFAULT_ITEM_SIZE, DEFAULT_ITEM_SIZE, canvasWidth, canvasHeight)
      onDrop(active.type, clamped)
    },
    [getStage, gridSize, canvasWidth, canvasHeight, onDrop],
  )

  // Re-subscribed whenever `drag` changes so the handlers below always close
  // over the current drag state without needing a ref.
  useEffect(() => {
    if (!drag) return undefined

    function handlePointerMove(event: PointerEvent) {
      setDrag((current) =>
        current ? { ...current, clientX: event.clientX, clientY: event.clientY } : current,
      )
    }

    function handlePointerUp(event: PointerEvent) {
      if (drag) endDrag(drag, event.clientX, event.clientY)
      setDrag(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [drag, endDrag])

  function handlePointerDown(type: CatalogType, event: ReactPointerEvent<HTMLDivElement>) {
    setDrag({ type, clientX: event.clientX, clientY: event.clientY })
  }

  function toggleSection(title: string) {
    setOpenSections((current) => ({ ...current, [title]: !current[title] }))
  }

  return (
    <aside aria-label="Object catalog" className="w-[180px] overflow-y-auto border-r p-3">
      {/* U9 tool strip. Selecting a tool sets `activeTool` (the draw tools
          watch it from ShapeTool/LineTool/TextTool/CropTool via
          CanvasStage); clicking the already-active tool toggles back to the
          idle `'pan'` mode (canvas-tools follow-up) so a tool can be
          cancelled — a plain drag then navigates the canvas. The active
          tool is signalled via the filled `default` variant (plus
          `aria-pressed`); `'pan'` leads the list as that idle home. */}
      <h2 className="mb-2 text-sm font-medium">Tools</h2>
      <div className="mb-4 flex flex-col gap-1">
        {TOOL_BUTTONS.map(({ type, label, Icon }) => {
          const isActive = activeTool === type
          return (
            <Button
              key={type}
              type="button"
              variant={isActive ? 'default' : 'outline'}
              size="sm"
              className="justify-start"
              aria-pressed={isActive}
              // Clicking the ACTIVE tool deselects it, landing on the idle
              // pan mode where a plain drag navigates the canvas.
              onClick={() => setActiveTool(isActive ? 'pan' : type)}
            >
              <Icon aria-hidden="true" /> {label}
            </Button>
          )
        })}
      </div>

      <h2 className="mb-2 text-sm font-medium">Catalog</h2>
      {CATALOG_SECTIONS.map(({ title, types }) => {
        const isOpen = openSections[title]
        return (
          <section key={title} className="mb-2">
            {/* shadcn-styled collapsible header (ghost-button treatment +
                chevron); `aria-expanded` mirrors the open flag. */}
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggleSection(title)}
              className="mb-1 flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors select-none hover:bg-muted hover:text-foreground"
            >
              {isOpen ? (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              )}
              {title}
            </button>
            {isOpen && (
              <ul className="flex flex-col gap-2">
                {types.map((type) => (
                  <li key={type}>
                    <div
                      role="button"
                      tabIndex={0}
                      data-testid={`catalog-item-${type}`}
                      onPointerDown={(event) => handlePointerDown(type, event)}
                      className="cursor-grab touch-none rounded px-2.5 py-2 text-[13px] text-white select-none"
                      // Dynamic value: each catalog entry's fill comes from
                      // `colorForType()` (the same per-type palette the Konva
                      // shapes use), so it can't be a static Tailwind class.
                      style={{ backgroundColor: colorForType(type) }}
                    >
                      {CATALOG_LABELS[type]}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}

      {drag && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 rounded opacity-70"
          // Dynamic values: the preview follows the live pointer position,
          // and its size/color derive from the DEFAULT_ITEM_SIZE constant
          // and `colorForType()` — none of these can be static classes.
          style={{
            left: drag.clientX - DEFAULT_ITEM_SIZE / 2,
            top: drag.clientY - DEFAULT_ITEM_SIZE / 2,
            width: DEFAULT_ITEM_SIZE,
            height: DEFAULT_ITEM_SIZE,
            backgroundColor: colorForType(drag.type),
          }}
        />
      )}
    </aside>
  )
}
