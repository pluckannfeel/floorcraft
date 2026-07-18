import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
import { cn } from '@/lib/utils'
import { useCanvasStore, type ActiveTool } from '../state/canvasStore'
import { colorForType } from './ObjectShape'
import { clampToBounds, screenToStagePoint, snapToGrid } from './coordinates'
import { SYMBOLS } from './symbols'
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
 * mode every other tool toggles back to. `label` is the accessible name
 * (aria-label + tooltip — tests and screen readers see the full name);
 * `short` is the tiny caption under the icon, abbreviated where the full
 * label wouldn't fit a grid cell. */
const TOOL_BUTTONS: { type: ActiveTool; label: string; short: string; Icon: LucideIcon }[] = [
  { type: 'pan', label: 'Pan', short: 'Pan', Icon: Hand },
  { type: 'select', label: 'Select', short: 'Select', Icon: MousePointer2 },
  { type: 'shape_rectangle', label: 'Rectangle', short: 'Rect', Icon: RectangleHorizontal },
  { type: 'shape_square', label: 'Square', short: 'Square', Icon: Square },
  { type: 'shape_circle', label: 'Circle', short: 'Circle', Icon: Circle },
  { type: 'line_straight', label: 'Line', short: 'Line', Icon: Minus },
  { type: 'line_curved', label: 'Curved Line', short: 'Curve', Icon: Spline },
  { type: 'line_s_curve', label: 'S-Curve Line', short: 'S-Curve', Icon: Waves },
  { type: 'text', label: 'Text', short: 'Text', Icon: Type },
  { type: 'crop', label: 'Crop', short: 'Crop', Icon: Crop },
]

/** Matches the backend `Objects` model's default `width`/`height` (40) —
 * see Key Technical Decisions: all catalog types share this default. */
export const DEFAULT_ITEM_SIZE = 40

/** Resizable-sidebar bounds (final-polish round): the default is the
 * regridded design width; the minimum keeps the 5-column tool grid's
 * captions legible; the maximum stops the sidebar from squeezing the
 * canvas into a sliver on laptop screens. */
export const DEFAULT_SIDEBAR_WIDTH = 360
export const MIN_SIDEBAR_WIDTH = 240
export const MAX_SIDEBAR_WIDTH = 600

/** One clamp shared by every width writer (edge drag + arrow keys). */
// Non-component export colocated with the width bounds it reads from; same
// pattern as ObjectShape.tsx's `colorForType` export.
// eslint-disable-next-line react-refresh/only-export-components
export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

/** Arrow-key resize step for the handle's keyboard support. */
const SIDEBAR_KEYBOARD_RESIZE_STEP = 16

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
  // Resizable width (final-polish round): dragged via the right-edge
  // handle below. Transient local state like the collapsible sections —
  // a fresh mount starts back at the design default.
  const [width, setWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement | null>(null)
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

  // Edge-drag resize: same window-listener convention as the catalog drag
  // above (subscribed only while a resize is in flight). Width follows the
  // pointer's distance from the sidebar's left edge, clamped; body-level
  // cursor/user-select overrides keep the col-resize cursor and suppress
  // text selection while the pointer sweeps over the sidebar's content.
  useEffect(() => {
    if (!resizing) return undefined

    function handlePointerMove(event: PointerEvent) {
      const left = asideRef.current?.getBoundingClientRect().left ?? 0
      setWidth(clampSidebarWidth(event.clientX - left))
    }
    function handlePointerUp() {
      setResizing(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [resizing])

  function toggleSection(title: string) {
    setOpenSections((current) => ({ ...current, [title]: !current[title] }))
  }

  return (
    // The aside itself doesn't scroll — the inner div does — so the
    // absolutely-positioned resize handle stays pinned to the visible
    // right edge instead of scrolling away with the catalog.
    <aside
      ref={asideRef}
      aria-label="Object catalog"
      className="relative flex shrink-0 border-r bg-background"
      // Dynamic value: the user-dragged width can't be a static class.
      style={{ width }}
    >
      <div className="flex-1 overflow-y-auto p-4">
      {/* U9 tool strip, regridded (canvas-tools follow-up): a 5-column
          palette of stacked icon+caption buttons — the editor-program
          convention — instead of the original one-per-row text list.
          Selecting a tool sets `activeTool` (the draw tools watch it from
          ShapeTool/LineTool/TextTool/CropTool via CanvasStage); clicking
          the already-active tool toggles back to the idle `'pan'` mode so
          a tool can be cancelled — a plain drag then navigates the canvas.
          The active tool is signalled via the filled primary treatment
          (plus `aria-pressed`); `'pan'` leads the grid as that idle home.
          `aria-label` carries the FULL tool name (the visible caption may
          be abbreviated), so accessible names are unchanged from the list
          layout. */}
      <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Tools
      </h2>
      <div className="mb-5 grid grid-cols-5 gap-1.5">
        {TOOL_BUTTONS.map(({ type, label, short, Icon }) => {
          const isActive = activeTool === type
          return (
            <button
              key={type}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={isActive}
              // Clicking the ACTIVE tool deselects it, landing on the idle
              // pan mode where a plain drag navigates the canvas.
              onClick={() => setActiveTool(isActive ? 'pan' : type)}
              className={cn(
                'flex flex-col items-center justify-center gap-1 rounded-md border py-2 outline-none transition-all select-none focus-visible:ring-2 focus-visible:ring-ring/50',
                isActive
                  ? 'border-primary bg-primary text-primary-foreground shadow-inner'
                  : 'border-border bg-card text-muted-foreground shadow-xs hover:border-ring/40 hover:bg-muted hover:text-foreground hover:shadow-sm active:translate-y-px',
              )}
            >
              <Icon className="size-4.5" aria-hidden="true" />
              <span className="text-[10px] leading-none font-medium">{short}</span>
            </button>
          )
        })}
      </div>

      <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Catalog
      </h2>
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
              <ul className="grid grid-cols-2 gap-1.5">
                {/* Card treatment (canvas-tools follow-up): a color chip +
                    label on a bordered card, in a 2-column grid — replacing
                    the original full-width solid-color blocks. Same custom
                    pointer-drag flow; only the presentation changed. */}
                {types.map((type) => (
                  <li key={type}>
                    <div
                      role="button"
                      tabIndex={0}
                      data-testid={`catalog-item-${type}`}
                      onPointerDown={(event) => handlePointerDown(type, event)}
                      className="flex cursor-grab items-center gap-2 rounded-md border bg-card px-2 py-2 shadow-xs transition-all select-none touch-none hover:border-ring/40 hover:shadow-sm active:translate-y-px"
                    >
                      {/* U4 (object-visuals, R5): the card's thumbnail is
                          the type's top-down symbol as an inline SVG — the
                          SAME path data + viewBox the canvas Konva.Path
                          branch renders (symbols.ts, one source of truth),
                          tinted with the same `colorForType()` palette the
                          old color chip used (R3). `fill` on the <svg>
                          inherits to every child <path> (filled-geometry
                          contract: the data carries no styling of its own). */}
                      <svg
                        aria-hidden="true"
                        className="size-5 shrink-0"
                        viewBox={`0 0 ${SYMBOLS[type].viewBox.width} ${SYMBOLS[type].viewBox.height}`}
                        fill={colorForType(type)}
                      >
                        {SYMBOLS[type].paths.map((data, index) => (
                          <path key={index} d={data} />
                        ))}
                      </svg>
                      <span className="truncate text-xs font-medium">{CATALOG_LABELS[type]}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
      </div>

      {/* Right-edge resize handle: ARIA window-splitter shape (separator +
          value range) with arrow-key support; the pointer flow lives in the
          `resizing` effect above. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          // No native default to speak of, but preventDefault stops a
          // text-selection start racing the first pointermove.
          event.preventDefault()
          setResizing(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            const delta =
              event.key === 'ArrowLeft' ? -SIDEBAR_KEYBOARD_RESIZE_STEP : SIDEBAR_KEYBOARD_RESIZE_STEP
            setWidth((current) => clampSidebarWidth(current + delta))
          }
        }}
        className={cn(
          'absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none outline-none transition-colors hover:bg-ring/40 focus-visible:bg-ring/60',
          resizing && 'bg-ring/60',
        )}
      />

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
