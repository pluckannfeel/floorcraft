import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type Konva from 'konva'
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Crop,
  LoaderCircle,
  MousePointer2,
  Minus,
  Move,
  Plus,
  Spline,
  Square,
  RectangleHorizontal,
  Type,
  Waves,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Tooltip } from '@/components/Tooltip'
import {
  clientUploadRejection,
  useDeleteVariant,
  useUploadVariant,
  useVariants,
  type ObjectVariant,
} from '../hooks/useVariants'
import { useToast } from '../notifications/ToastContext'
import { useCanvasStore, type ActiveTool } from '../state/canvasStore'
import { colorForType } from './ObjectShape'
import { clampToBounds, screenToStagePoint, snapToGrid } from './coordinates'
import { EXTRA_SYMBOL_PRESETS, SYMBOLS } from './symbols'
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
  { type: 'pan', label: 'Pan', short: 'Pan', Icon: Move },
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

/**
 * U5 (object-visuals): the optional variant reference a drag carries into
 * `onDrop` — the placed variant's server id plus its pipeline-recorded
 * NATURAL dimensions, which U6's aspect-fit drop math needs synchronously
 * (the drop handler computes final width/height from these — image-load
 * completion must never touch the store; institutional learning). A plain
 * value snapshot, deliberately not the whole ObjectVariant row.
 */
export interface VariantDragRef {
  id: number
  width: number
  height: number
}

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
   * point once a drag ends over the canvas; variant drags (U5) additionally
   * carry the variant reference. The widened optional third parameter is
   * contravariant-compatible with the existing two-parameter
   * CanvasEditorPage handler — U6 wires the consumer, nothing changes for
   * default drops today. */
  onDrop: (type: CatalogType, point: Point, variant?: VariantDragRef, preset?: string) => void
}

interface DragState {
  type: CatalogType
  /** Present exactly when a VARIANT tile started the drag (U5). */
  variant?: VariantDragRef
  /** Present exactly when a built-in PRESET tile started the drag. */
  preset?: string
  /** The variant's thumbnail URL for the floating preview; the tinted
   * square stays painted beneath it as the loading/failed fallback. */
  previewUrl?: string
  /** Where the pointer went down — the click-vs-drag threshold anchor
   * (object-visuals follow-up: tiles are click-to-ARM buttons first,
   * draggable second; only movement past the threshold starts a drag). */
  startX: number
  startY: number
  /** False until the pointer travels past `DRAG_START_THRESHOLD_PX` — the
   * floating preview renders (and a drop can commit) only while true. A
   * press-release under the threshold is a CLICK (arms the placement). */
  dragging: boolean
  clientX: number
  clientY: number
}

/** Movement (px) before a tile press becomes a drag instead of a click. */
const DRAG_START_THRESHOLD_PX = 4

/**
 * R9/R24/R25: sidebar hosting the tool strip (U9 — Select, shapes, lines,
 * Text, Crop, moved from the toolbar with the same toggle/active-variant/
 * `aria-pressed` conventions) above the catalog of the 7 droppable Object
 * types, grouped into collapsible sections.
 *
 * Each draggable tile starts a custom pointer-based drag on `onPointerDown`
 * (NOT native HTML `draggable`, which doesn't give us the
 * sub-pixel/transform-aware control needed for grid-snapping against a
 * zoomed/panned Konva stage) — a floating preview `div` follows the
 * pointer, and on global `pointerup` the drop position is computed only if
 * the release happened over the canvas container's bounding rect. That flow
 * is untouched by U9's regrouping: a collapsed section simply doesn't
 * render its entries, and re-expanding restores the exact same nodes.
 *
 * U5 (object-visuals; R6–R9, R12, R18; F1/F3), reshaped by the follow-up
 * rounds: each catalog entry is a HEADER (small symbol + type label,
 * non-interactive) over ONE horizontally-scrollable tile row —
 * [default symbol tile][built-in preset tiles…][uploaded variant tiles…]
 * [+ upload tile]. Every tile is a square click-to-ARM button (press-
 * release under the drag threshold arms a placement; the next canvas
 * click places it) that still drag-and-drops once the pointer crosses the
 * threshold; variant tiles carry the R18 delete behind the confirm.
 * Pointer ownership lives on the individual tiles (doc-review: design) so
 * the +/delete buttons can never start a ghost drag.
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
  // Object-visuals follow-up: the armed catalog placement (click-to-arm
  // tiles below) — untracked store state, like the tool itself.
  const placement = useCanvasStore((state) => state.placement)
  const setPlacement = useCanvasStore((state) => state.setPlacement)

  // U5 (object-visuals): the personal variant catalog — a PLAIN query
  // resource (never store-mirrored; institutional learning) grouped by type
  // below, plus the upload/delete mutations and the R18 confirm state.
  const variantsQuery = useVariants()
  const uploadVariant = useUploadVariant()
  const deleteVariant = useDeleteVariant()
  const { showError } = useToast()
  const [confirmDelete, setConfirmDelete] = useState<ObjectVariant | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Which type's [+] opened the picker — a ref, not state: nothing renders
  // from it, it only routes the chosen file to its type on change.
  const pendingUploadTypeRef = useRef<CatalogType | null>(null)

  // Resilience (U5): defaults have ZERO network dependency — the catalog is
  // never gated on the query, so `?? []` degrades loading/errored states to
  // "no strips" while every default tile keeps rendering and dragging. Zero
  // variants for a type → no strip row at all (no empty tray).
  const variantsByType = useMemo(() => {
    const grouped = new Map<CatalogType, ObjectVariant[]>()
    for (const variant of variantsQuery.data ?? []) {
      const list = grouped.get(variant.object_type)
      if (list) list.push(variant)
      else grouped.set(variant.object_type, [variant])
    }
    return grouped
  }, [variantsQuery.data])

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
      // U5: variant drags carry their reference + natural dims through to
      // the drop (U6's aspect-fit consumer); default drops keep the exact
      // two-argument call so the existing contract is bit-identical.
      if (active.variant) onDrop(active.type, clamped, active.variant)
      else if (active.preset) onDrop(active.type, clamped, undefined, active.preset)
      else onDrop(active.type, clamped)
    },
    [getStage, gridSize, canvasWidth, canvasHeight, onDrop],
  )

  // Re-subscribed whenever `drag` changes so the handlers below always close
  // over the current drag state without needing a ref.
  useEffect(() => {
    if (!drag) return undefined

    function handlePointerMove(event: PointerEvent) {
      setDrag((current) => {
        if (!current) return current
        // Threshold gate (object-visuals follow-up): the press stays a
        // potential CLICK until the pointer travels far enough — then it
        // commits to being a drag and the preview appears.
        if (!current.dragging) {
          const travelled = Math.hypot(
            event.clientX - current.startX,
            event.clientY - current.startY,
          )
          if (travelled < DRAG_START_THRESHOLD_PX) return current
          return { ...current, dragging: true, clientX: event.clientX, clientY: event.clientY }
        }
        return { ...current, clientX: event.clientX, clientY: event.clientY }
      })
    }

    function handlePointerUp(event: PointerEvent) {
      if (drag?.dragging) {
        endDrag(drag, event.clientX, event.clientY)
        // The browser fires a `click` on the tile right after this
        // pointerup — swallow it (the gesture was a DRAG, arming now
        // would surprise). One-shot flag, consumed by handleTileClick.
        suppressClickRef.current = true
      }
      setDrag(null)
    }

    // Final review pass: pointercancel (OS dialogs, edge gestures, palm
    // rejection — touch never delivers a pointerup after one) must reset
    // the machine, or the NEXT unrelated pointerup anywhere would commit a
    // spurious drop at that point.
    function handlePointerCancel() {
      setDrag(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [drag, endDrag])

  // Pointer ownership (U5, doc-review: design — CRITICAL): the card level
  // owns NO pointerdown. Each tile (the default symbol tile and every
  // variant tile) starts its OWN potential-drag and stops propagation; the
  // [+] and delete buttons stop propagation on pointerdown and act on
  // click — so pressing + or delete can never start a ghost drag.
  // Object-visuals follow-up: a press is a CLICK (arms the placement)
  // until it travels past the drag threshold — see the drag effect.
  function handlePointerDown(type: CatalogType, event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation()
    // Final review pass: a drag that ended over the CANVAS never fires a
    // tile click, so a stale suppress flag from it would swallow the NEXT
    // genuine click — every new press starts with a clean flag (its own
    // click can still be suppressed by ITS drag).
    suppressClickRef.current = false
    setDrag({
      type,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      clientX: event.clientX,
      clientY: event.clientY,
    })
  }

  /** U5: a variant tile's press — same flow as the default tile, plus the
   * reference payload (id + natural dims for U6's aspect-fit) and the
   * thumbnail URL for the floating preview. */
  function handleVariantPointerDown(
    type: CatalogType,
    variant: ObjectVariant,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    event.stopPropagation()
    suppressClickRef.current = false
    setDrag({
      type,
      variant: { id: variant.id, width: variant.width, height: variant.height },
      previewUrl: variant.file_url,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      clientX: event.clientX,
      clientY: event.clientY,
    })
  }

  /** A built-in preset tile's press — the default-tile flow plus the
   * preset id payload. */
  function handlePresetPointerDown(
    type: CatalogType,
    presetId: string,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    event.stopPropagation()
    suppressClickRef.current = false
    setDrag({
      type,
      preset: presetId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      clientX: event.clientX,
      clientY: event.clientY,
    })
  }

  /** Object-visuals follow-up: click-to-ARM. A sub-threshold press-release
   * toggles the tile's placement: armed -> disarm (back to pan); anything
   * else -> arm this tile ('place' tool; the next canvas click creates the
   * item — CanvasStage routes it to `onPlaceAt`). A completed DRAG
   * suppresses the click that follows its pointerup. */
  const suppressClickRef = useRef(false)
  function handleTileClick(
    type: CatalogType,
    variant: ObjectVariant | null,
    presetId: string | null = null,
  ) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const variantId = variant?.id ?? null
    const isArmed =
      activeTool === 'place' &&
      placement?.type === type &&
      (placement?.variant?.id ?? null) === variantId &&
      (placement?.preset ?? null) === presetId
    if (isArmed) {
      setPlacement(null)
    } else {
      setPlacement({
        type,
        variant: variant
          ? { id: variant.id, width: variant.width, height: variant.height }
          : null,
        preset: presetId,
      })
    }
  }

  /** U5 (F1): the [+] routes through one hidden file input shared by all
   * cards — the pressed type is remembered in a ref until `change` fires. */
  function handleUploadClick(type: CatalogType) {
    // In-flight guard (doc-review): while an upload is pending the [+] is
    // disabled with a spinner — a second click must no-op, never
    // double-submit against the R19 quota. The disabled attribute already
    // blocks this; the guard is belt-and-suspenders for programmatic calls.
    if (uploadVariant.isPending) return
    pendingUploadTypeRef.current = type
    fileInputRef.current?.click()
  }

  function handleFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    const type = pendingUploadTypeRef.current
    // Reset so re-choosing the SAME file later still fires `change`.
    event.target.value = ''
    if (!file || !type) return
    // AE2 (client half): extension/size pre-check BEFORE any request — the
    // rejection routes through the same toast convention as server
    // rejections, with the same friendly wording (useVariants.ts mirrors
    // the serializer's messages), so the user can't tell which layer
    // caught it and never sees a raw proxy error.
    const rejection = clientUploadRejection(file)
    if (rejection) {
      showError(rejection)
      return
    }
    uploadVariant.mutate({ objectType: type, file })
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

    function handlePointerCancel() {
      setResizing(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
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
          // Pan is the DEFAULT idle mode, so it is "active" most of the
          // time — a permanently-filled primary button reads as shouting
          // (user feedback). Pan-active gets a calm muted treatment; the
          // deliberately-engaged tools keep the filled primary pop.
          const isPan = type === 'pan'
          return (
            <Tooltip key={type} label={label}>
            <button
              type="button"
              aria-label={label}
              aria-pressed={isActive}
              // Clicking the ACTIVE tool deselects it, landing on the idle
              // pan mode where a plain drag navigates the canvas.
              onClick={() => setActiveTool(isActive ? 'pan' : type)}
              className={cn(
                'flex flex-col items-center justify-center gap-1 rounded-md border py-2 outline-none transition-all select-none focus-visible:ring-2 focus-visible:ring-ring/50',
                isActive
                  ? isPan
                    ? 'border-ring/60 bg-muted text-foreground shadow-inner'
                    : 'border-primary bg-primary text-primary-foreground shadow-inner'
                  : 'border-border bg-card text-muted-foreground shadow-xs hover:border-ring/40 hover:bg-muted hover:text-foreground hover:shadow-sm active:translate-y-px',
              )}
            >
              <Icon className="size-4.5" aria-hidden="true" />
              <span className="text-[10px] leading-none font-medium">{short}</span>
            </button>
            </Tooltip>
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
              /* U5 (object-visuals, doc-review: card anatomy): the 2-column
                 grid became a SINGLE-COLUMN stack — variant strips make the
                 cards variable-height, and half-width ragged cards would
                 fight the strip's horizontal scroll. */
              <ul className="flex flex-col gap-1.5">
                {types.map((type) => {
                  const typeVariants = variantsByType.get(type) ?? []
                  const isUploadingThisType =
                    uploadVariant.isPending && uploadVariant.variables?.objectType === type
                  return (
                    <li key={type}>
                      {/* Object-visuals follow-up (user feedback): each
                          type is a HEADER over a horizontal, scrollable
                          tile row — [default symbol tile][variant tiles…]
                          [+ tile]. Tiles are square click-to-ARM buttons
                          (press-release under the drag threshold toggles
                          the placement; the next canvas click places it),
                          and still drag-to-drop once the pointer travels
                          past the threshold. The card carries no
                          pointerdown — ownership stays on the tiles. */}
                      <div className="rounded-md border bg-card shadow-xs transition-all hover:border-ring/40 hover:shadow-sm">
                        <div className="flex items-center gap-2 border-b px-2 py-1.5">
                          {/* U4 (R5): the header thumbnail is the type's
                              top-down symbol as an inline SVG — the SAME
                              path data + viewBox the canvas Konva.Path
                              branch renders (symbols.ts, one source of
                              truth), tinted with the same palette (R3). */}
                          <svg
                            aria-hidden="true"
                            className="size-4 shrink-0"
                            viewBox={`0 0 ${SYMBOLS[type].viewBox.width} ${SYMBOLS[type].viewBox.height}`}
                            fill={colorForType(type)}
                          >
                            {SYMBOLS[type].paths.map((data, index) => (
                              <path key={index} d={data} />
                            ))}
                          </svg>
                          <span className="truncate text-xs font-medium">{CATALOG_LABELS[type]}</span>
                        </div>
                        <div
                          data-testid={`catalog-tiles-${type}`}
                          className="flex gap-1.5 overflow-x-auto p-1.5"
                        >
                          {/* The DEFAULT tile: first in every row, keeps
                              its historical testid (the drag contract and
                              its tests carry over — drags still work via
                              the threshold). aria-pressed reflects the
                              armed placement. */}
                          {(() => {
                            const defaultArmed =
                              activeTool === 'place' &&
                              placement?.type === type &&
                              placement?.variant === null &&
                              (placement?.preset ?? null) === null
                            return (
                              <Tooltip label={`Place ${CATALOG_LABELS[type]}`}>
                              <div
                                role="button"
                                tabIndex={0}
                                data-testid={`catalog-item-${type}`}
                                aria-label={`Place ${CATALOG_LABELS[type]}`}
                                aria-pressed={defaultArmed}
                                onPointerDown={(event) => handlePointerDown(type, event)}
                                onClick={() => handleTileClick(type, null)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    handleTileClick(type, null)
                                  }
                                }}
                                className={cn(
                                  'flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md border bg-background outline-none transition-all select-none touch-none focus-visible:ring-2 focus-visible:ring-ring/50',
                                  defaultArmed
                                    ? 'border-primary shadow-inner ring-2 ring-primary/40'
                                    : 'hover:border-ring/40 active:translate-y-px',
                                )}
                              >
                                <svg
                                  aria-hidden="true"
                                  className="size-6"
                                  viewBox={`0 0 ${SYMBOLS[type].viewBox.width} ${SYMBOLS[type].viewBox.height}`}
                                  fill={colorForType(type)}
                                >
                                  {SYMBOLS[type].paths.map((data, index) => (
                                    <path key={index} d={data} />
                                  ))}
                                </svg>
                              </div>
                              </Tooltip>
                            )
                          })()}
                          {/* Built-in PRESET tiles (user feedback: extra
                              stock looks — round table, AC unit) — same
                              click-to-arm/drag behavior as the default,
                              carrying the preset id instead of a variant. */}
                          {(EXTRA_SYMBOL_PRESETS[type] ?? []).map((preset) => {
                            const presetArmed =
                              activeTool === 'place' &&
                              placement?.type === type &&
                              placement?.variant === null &&
                              placement?.preset === preset.id
                            return (
                              <Tooltip key={preset.id} label={`Place ${preset.label}`}>
                              <div
                                role="button"
                                tabIndex={0}
                                data-testid={`preset-item-${type}-${preset.id}`}
                                aria-label={`Place ${preset.label}`}
                                aria-pressed={presetArmed}
                                onPointerDown={(event) =>
                                  handlePresetPointerDown(type, preset.id, event)
                                }
                                onClick={() => handleTileClick(type, null, preset.id)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    handleTileClick(type, null, preset.id)
                                  }
                                }}
                                className={cn(
                                  'flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md border bg-background outline-none transition-all select-none touch-none focus-visible:ring-2 focus-visible:ring-ring/50',
                                  presetArmed
                                    ? 'border-primary shadow-inner ring-2 ring-primary/40'
                                    : 'hover:border-ring/40 active:translate-y-px',
                                )}
                              >
                                <svg
                                  aria-hidden="true"
                                  className="size-6"
                                  viewBox={`0 0 ${preset.viewBox.width} ${preset.viewBox.height}`}
                                  fill={colorForType(type)}
                                >
                                  {preset.paths.map((data, index) => (
                                    <path key={index} d={data} />
                                  ))}
                                </svg>
                              </div>
                              </Tooltip>
                            )
                          })}
                          {/* R7/R12: the user's uploaded variants for this
                              type — same click-to-arm/drag tiles, thumbnail
                              contain-fit, named by `original_name`
                              (tooltip + aria), each with its always-
                              visible, keyboard-focusable delete (R18). */}
                          {typeVariants.map((variant) => {
                            const variantArmed =
                              activeTool === 'place' &&
                              placement?.type === type &&
                              placement?.variant?.id === variant.id
                            return (
                              <div key={variant.id} className="relative shrink-0">
                                <Tooltip label={variant.original_name}>
                                <div
                                  role="button"
                                  tabIndex={0}
                                  data-testid={`variant-item-${variant.id}`}
                                  aria-label={`Place ${variant.original_name}`}
                                  aria-pressed={variantArmed}
                                  onPointerDown={(event) =>
                                    handleVariantPointerDown(type, variant, event)
                                  }
                                  onClick={() => handleTileClick(type, variant)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault()
                                      handleTileClick(type, variant)
                                    }
                                  }}
                                  className={cn(
                                    'flex size-10 cursor-pointer items-center justify-center overflow-hidden rounded-md border bg-background outline-none transition-all select-none touch-none focus-visible:ring-2 focus-visible:ring-ring/50',
                                    variantArmed
                                      ? 'border-primary shadow-inner ring-2 ring-primary/40'
                                      : 'hover:border-ring/40 active:translate-y-px',
                                  )}
                                >
                                  {/* alt="" — decorative; the accessible
                                      name lives on the tile button above. */}
                                  <img
                                    src={variant.file_url}
                                    alt=""
                                    draggable={false}
                                    className="max-h-full max-w-full object-contain"
                                  />
                                </div>
                                </Tooltip>
                                {/* F3/R18: ALWAYS-VISIBLE, keyboard-
                                    focusable delete — hover-reveal would be
                                    unreachable on touch and invisible to
                                    keyboard users (doc-review: a11y).
                                    Opens the R18 confirm; never deletes
                                    directly, never starts a drag. */}
                                <button
                                  type="button"
                                  aria-label={`Remove ${variant.original_name}`}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={() => setConfirmDelete(variant)}
                                  className="absolute top-0 right-0 flex size-4 items-center justify-center rounded-tr-md rounded-bl-md border-b border-l bg-background/90 text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50"
                                >
                                  <X className="size-3" aria-hidden="true" />
                                </button>
                              </div>
                            )
                          })}
                          {/* R6 (F1): the [+] upload tile closes every row.
                              Disabled with a spinner while an upload is in
                              flight (doc-review: no double-submits burning
                              R19 quota); stopPropagation on pointerdown so
                              a press can never start a ghost drag. */}
                          <Tooltip label={`Upload ${CATALOG_LABELS[type]} image`}>
                          <button
                            type="button"
                            aria-label={`Upload ${CATALOG_LABELS[type]} image`}
                            disabled={uploadVariant.isPending}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => handleUploadClick(type)}
                            className="flex size-10 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground outline-none transition-colors select-none hover:border-ring/40 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
                          >
                            {isUploadingThisType ? (
                              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <Plus className="size-4" aria-hidden="true" />
                            )}
                          </button>
                          </Tooltip>
                        </div>
                      </div>
                    </li>
                  )
                })}
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

      {drag?.dragging && (
        <div
          aria-hidden="true"
          data-testid="catalog-drag-preview"
          className="pointer-events-none fixed z-50 overflow-hidden rounded opacity-70"
          // Dynamic values: the preview follows the live pointer position,
          // and its size/color derive from the DEFAULT_ITEM_SIZE constant
          // and `colorForType()` — none of these can be static classes.
          // U5: the tinted square is ALWAYS painted — for default drags it
          // IS the preview (unchanged), for variant drags it is the
          // fallback showing through until/unless the thumbnail below has
          // decoded (usually instant: the strip already rendered it).
          style={{
            left: drag.clientX - DEFAULT_ITEM_SIZE / 2,
            top: drag.clientY - DEFAULT_ITEM_SIZE / 2,
            width: DEFAULT_ITEM_SIZE,
            height: DEFAULT_ITEM_SIZE,
            backgroundColor: colorForType(drag.type),
          }}
        >
          {drag.previewUrl && (
            <img src={drag.previewUrl} alt="" className="h-full w-full object-contain" />
          )}
        </div>
      )}

      {/* U5 (F1): one hidden file input shared by every card's [+] — the
          picker is native, the pressed type rides pendingUploadTypeRef.
          `accept` is a UX hint only; clientUploadRejection() is the real
          client-side gate (and the serializer the authoritative one). */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".svg,.png,.jpg,.jpeg"
        className="hidden"
        data-testid="variant-upload-input"
        tabIndex={-1}
        onChange={handleFileChosen}
      />

      {/* R18 (F3): variant deletion sits behind the shared ConfirmDialog
          with the plan's copy VERBATIM — stating placed objects keep the
          image and NOT implying the file is erased (soft-delete retention:
          the upload keeps counting toward quota). Confirm fires the
          mutation (cache-filter + toast handled in useVariants); Cancel
          keeps everything. */}
      {confirmDelete && (
        <ConfirmDialog
          title="Remove from catalog?"
          message="Remove this item from your catalog? Objects already placed keep this image, and the upload still counts toward your storage."
          confirmLabel="Remove"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            deleteVariant.mutate(confirmDelete.id)
            setConfirmDelete(null)
          }}
        />
      )}
    </aside>
  )
}
