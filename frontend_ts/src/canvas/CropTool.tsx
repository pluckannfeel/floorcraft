import { useCallback, useState } from 'react'
import type Konva from 'konva'
import { Rect } from 'react-konva'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { containerToStagePoint, rectFromPoints, SELECTION_CHROME } from './coordinates'
import type { BoundingBox } from './coordinates'
import type { Point } from './types'

/**
 * U8 (canvas-tools): the crop tool — draw a region, confirm/cancel, and the
 * caller applies `canvasStore.applyCrop(region)`.
 *
 * Mirrors `useMarquee`'s split (the marquee is the closest existing
 * gesture): `useCropTool` below is the Konva-free state machine
 * (begin → update* → release → confirm | cancel), tested directly with
 * `renderHook`; `CanvasStage` wires pointer/keyboard events into it and
 * renders the two visual halves — `CropRegionOverlay` (Konva: four
 * translucent dimming strips OUTSIDE the region plus the region border,
 * all drawn from the shared `SELECTION_CHROME` token) and
 * `CropConfirmControls` (DOM: floating Apply/Cancel shadcn buttons near the
 * region, the visible counterpart to the Enter/Escape shortcuts).
 *
 * Coordinate spaces follow the marquee's single-space rule: the gesture is
 * tracked in CONTAINER space (screen px) and converted to model space at
 * exactly one boundary (`containerToStagePoint` on both corners).
 */

/** Container-space movement below which a crop drag is treated as a stray
 * click and produces no region — same 4px screen-space boundary as the
 * marquee's `MARQUEE_CLICK_THRESHOLD_PX` (defined locally to avoid a
 * CropTool ⇄ CanvasStage import cycle). */
export const CROP_CLICK_THRESHOLD_PX = 4

/**
 * Intersects a raw model-space rect with the canvas `[0, width] x
 * [0, height]` and rounds it to INTEGER coordinates, or `null` when nothing
 * croppable remains. Two deliberate policies:
 * - Clamped to the CURRENT canvas: crop only trims (R21/F4 — growing the
 *   canvas is not this tool's job), so a drag past the edge crops to the
 *   edge.
 * - Integer-rounded: the backend persists dims as positive integers (the
 *   sync PUT's `canvas` validation), so the region — which becomes both the
 *   new dims and the coordinate shift — is snapped to whole units here,
 *   at the gesture boundary, keeping the store math exact. It is NOT
 *   grid-snapped: a crop origin off the grid de-aligns previously snapped
 *   objects, which the plan accepts (the next drag re-snaps them).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function clampCropRegionToCanvas(
  rect: BoundingBox,
  canvasWidth: number,
  canvasHeight: number,
): BoundingBox | null {
  const x = Math.round(Math.max(0, rect.x))
  const y = Math.round(Math.max(0, rect.y))
  const width = Math.round(Math.min(canvasWidth, rect.x + rect.width)) - x
  const height = Math.round(Math.min(canvasHeight, rect.y + rect.height)) - y
  if (width < 1 || height < 1) return null
  return { x, y, width, height }
}

export interface ResolveCropRegionArgs {
  /** Gesture endpoints in CONTAINER space (screen px, pre-zoom/pan). */
  origin: Point
  current: Point
  zoom: number
  stagePosition: Point
  canvasWidth: number
  canvasHeight: number
}

/**
 * The complete release decision for a crop drag, pure for jsdom tests:
 * sub-threshold movement is a stray click (no region); otherwise both
 * corners convert to model space and the rect clamps/rounds per
 * `clampCropRegionToCanvas` (which may itself return `null` for a drag
 * entirely outside the canvas).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveCropRegion({
  origin,
  current,
  zoom,
  stagePosition,
  canvasWidth,
  canvasHeight,
}: ResolveCropRegionArgs): BoundingBox | null {
  const movedPx = Math.max(Math.abs(current.x - origin.x), Math.abs(current.y - origin.y))
  if (movedPx < CROP_CLICK_THRESHOLD_PX) return null
  const rect = rectFromPoints(
    containerToStagePoint(origin, zoom, stagePosition),
    containerToStagePoint(current, zoom, stagePosition),
  )
  return clampCropRegionToCanvas(rect, canvasWidth, canvasHeight)
}

interface UseCropToolArgs {
  zoom: number
  stagePosition: Point
  canvasWidth: number
  canvasHeight: number
  /** The confirmed region (model space, integer-rounded). The caller owns
   * the store write (`applyCrop`) AND the switch back to the select tool —
   * the same delegation as `onCreateShape`/`onCreateLine`. */
  onApplyCrop?: (region: BoundingBox) => void
}

/**
 * The crop gesture state machine. Two phases:
 * - DRAWING (`isDrawing`): pointerdown `begin`s it, window pointermove
 *   `update`s it, window pointerup `release`s it — into PENDING when the
 *   drag produced a real region, back to idle otherwise.
 * - PENDING (`isPending`): the drawn region awaits `confirm` (Enter or the
 *   floating Apply button → `onApplyCrop`) or `cancel` (Escape or the
 *   Cancel button → discard, no state change anywhere else). Starting a new
 *   drag while pending replaces the region.
 *
 * `region` is the model-space rect to render (live-clamped during drawing
 * so the preview always shows exactly what a release would keep).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useCropTool({
  zoom,
  stagePosition,
  canvasWidth,
  canvasHeight,
  onApplyCrop,
}: UseCropToolArgs) {
  const [gesture, setGesture] = useState<{ origin: Point; current: Point } | null>(null)
  const [pending, setPending] = useState<BoundingBox | null>(null)

  const begin = useCallback((containerPoint: Point) => {
    setPending(null)
    setGesture({ origin: containerPoint, current: containerPoint })
  }, [])

  const update = useCallback((containerPoint: Point) => {
    setGesture((active) => (active ? { ...active, current: containerPoint } : active))
  }, [])

  const release = useCallback(() => {
    if (!gesture) return
    setGesture(null)
    setPending(
      resolveCropRegion({
        origin: gesture.origin,
        current: gesture.current,
        zoom,
        stagePosition,
        canvasWidth,
        canvasHeight,
      }),
    )
  }, [gesture, zoom, stagePosition, canvasWidth, canvasHeight])

  const confirm = useCallback(() => {
    if (!pending) return
    setPending(null)
    onApplyCrop?.(pending)
  }, [pending, onApplyCrop])

  const cancel = useCallback(() => {
    setGesture(null)
    setPending(null)
  }, [])

  const region =
    pending ??
    (gesture
      ? clampCropRegionToCanvas(
          rectFromPoints(
            containerToStagePoint(gesture.origin, zoom, stagePosition),
            containerToStagePoint(gesture.current, zoom, stagePosition),
          ),
          canvasWidth,
          canvasHeight,
        )
      : null)

  return {
    isDrawing: gesture != null,
    isPending: pending != null,
    region,
    begin,
    update,
    release,
    confirm,
    cancel,
  }
}

interface CropRegionOverlayProps {
  region: BoundingBox
  canvasWidth: number
  canvasHeight: number
  /** Stage zoom — divides stroke width so the border stays 1px on SCREEN
   * (this renders on a stage-transformed layer), same convention as the
   * marquee rect. */
  zoom: number
}

/**
 * The Konva half of the crop preview: four translucent strips dim
 * everything OUTSIDE the region (top/bottom full-width, left/right filling
 * the middle band) and a solid border marks the region itself — all from
 * the shared `SELECTION_CHROME` token. Rendered by `CanvasStage` on the UI
 * overlay layer (model space); zero-size strips (a region touching a canvas
 * edge) are skipped.
 */
export function CropRegionOverlay({ region, canvasWidth, canvasHeight, zoom }: CropRegionOverlayProps) {
  const strips: BoundingBox[] = [
    { x: 0, y: 0, width: canvasWidth, height: region.y },
    {
      x: 0,
      y: region.y + region.height,
      width: canvasWidth,
      height: canvasHeight - (region.y + region.height),
    },
    { x: 0, y: region.y, width: region.x, height: region.height },
    {
      x: region.x + region.width,
      y: region.y,
      width: canvasWidth - (region.x + region.width),
      height: region.height,
    },
  ]
  return (
    <>
      {strips
        .filter((strip) => strip.width > 0 && strip.height > 0)
        .map((strip, index) => (
          <Rect
            key={index}
            x={strip.x}
            y={strip.y}
            width={strip.width}
            height={strip.height}
            fill={SELECTION_CHROME.dimFill}
            listening={false}
          />
        ))}
      <Rect
        x={region.x}
        y={region.y}
        width={region.width}
        height={region.height}
        stroke={SELECTION_CHROME.stroke}
        strokeWidth={SELECTION_CHROME.strokeWidth / zoom}
        listening={false}
      />
    </>
  )
}

interface CropConfirmControlsProps {
  /** The pending region (model space) the controls hug. */
  region: BoundingBox
  zoom: number
  stagePosition: Point
  /** Returns the live Konva.Stage so the viewport position can be computed
   * from the container rect + stage transform per render — the
   * `TextEditOverlay` positioning approach (a getter, not a ref read
   * during render, per the react-hooks/refs rule). */
  getStage: () => Konva.Stage | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The DOM half of the crop affordance (plan: a VISIBLE control, not
 * keyboard-only): floating Apply/Cancel shadcn buttons near the pending
 * region's bottom-right corner (right-aligned to it via a -100%
 * x-translate). Enter/Escape drive the same `confirm`/`cancel` through
 * `CanvasStage`'s window listener. Rendered OUTSIDE the Konva `<Stage>`
 * (Konva trees can't contain DOM), fixed-positioned like the context
 * menu/text overlay.
 */
export function CropConfirmControls({
  region,
  zoom,
  stagePosition,
  getStage,
  onConfirm,
  onCancel,
}: CropConfirmControlsProps) {
  // Viewport position: container origin + the stage transform applied to
  // the region's bottom-right corner (TextEditOverlay's math — no Konva
  // node needed beyond the container rect).
  const containerRect = getStage()?.container().getBoundingClientRect()
  const left = (containerRect?.left ?? 0) + stagePosition.x + (region.x + region.width) * zoom
  const top =
    (containerRect?.top ?? 0) + stagePosition.y + (region.y + region.height) * zoom + 8
  return (
    <div
      className="fixed z-50 flex -translate-x-full gap-1 rounded-md border bg-background p-1 shadow-md"
      style={{ left, top }}
      role="group"
      aria-label="Confirm crop"
    >
      <Button type="button" size="sm" onClick={onConfirm} aria-label="Apply crop">
        <Check /> Apply
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onCancel} aria-label="Cancel crop">
        <X /> Cancel
      </Button>
    </div>
  )
}
