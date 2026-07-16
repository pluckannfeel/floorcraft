import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type Konva from 'konva'
import { colorForType } from './ObjectShape'
import { clampToBounds, screenToStagePoint, snapToGrid } from './coordinates'
import { CATALOG_TYPES, type CatalogType, type Point } from './types'

const CATALOG_LABELS: Record<CatalogType, string> = {
  outlines: 'Outline',
  tables: 'Table',
  doors: 'Door',
  chairs: 'Chair',
  furnitures: 'Furniture',
  appliances: 'Appliance',
  lighting: 'Lighting',
}

/** Matches the backend `Objects` model's default `width`/`height` (40) —
 * see Key Technical Decisions: all catalog types share this default. */
export const DEFAULT_ITEM_SIZE = 40

interface SidebarProps {
  /** Returns the live Konva.Stage instance so drop coordinates can be
   * computed against its current transform (zoom/pan-aware). */
  getStage: () => Konva.Stage | null
  gridSize: number
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
 * R9: sidebar listing the 7 catalog Object types. Each entry starts a
 * custom pointer-based drag on `onPointerDown` (NOT native HTML
 * `draggable`, which doesn't give us the sub-pixel/transform-aware control
 * needed for grid-snapping against a zoomed/panned Konva stage) — a
 * floating preview `div` follows the pointer, and on global `pointerup` the
 * drop position is computed only if the release happened over the canvas
 * container's bounding rect.
 */
export function Sidebar({ getStage, gridSize, canvasWidth, canvasHeight, onDrop }: SidebarProps) {
  const [drag, setDrag] = useState<DragState | null>(null)

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

  return (
    <aside aria-label="Object catalog" className="w-[180px] border-r p-3">
      <h2 className="mb-2 text-sm font-medium">Catalog</h2>
      <ul className="flex flex-col gap-2">
        {CATALOG_TYPES.map((type) => (
          <li key={type}>
            <div
              role="button"
              tabIndex={0}
              data-testid={`catalog-item-${type}`}
              onPointerDown={(event) => handlePointerDown(type, event)}
              className="cursor-grab touch-none rounded px-2.5 py-2 text-[13px] text-white select-none"
              // Dynamic value: each catalog entry's fill comes from
              // `colorForType()` (the same per-type palette the Konva shapes
              // use), so it can't be a static Tailwind class.
              style={{ backgroundColor: colorForType(type) }}
            >
              {CATALOG_LABELS[type]}
            </div>
          </li>
        ))}
      </ul>

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
