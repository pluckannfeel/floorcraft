import { useEffect, useReducer, useState } from 'react'
import type Konva from 'konva'
import type { Point } from './types'
import {
  chooseTickIntervals,
  formatMeasurement,
  modelToReal,
  realPerPixel,
  type Unit,
} from './rulers'

/**
 * U3 (canvas-rulers-scale): the top + left edge rulers (R5-R8, AE1/AE4).
 *
 * A fixed-position DOM overlay rendered OUTSIDE the Konva `<Stage>` — the
 * `TextEditOverlay` pattern (fixed-positioned, coordinates derived purely
 * from the store transform, no live Konva node). Keeping it a DOM overlay
 * (rather than an in-transform Konva layer) keeps the rulers out of the PNG
 * export tree — they're editor chrome. The bands hug the CANVAS's own top
 * and left edges (so `0,0` sits at the canvas corner and the ticks read
 * against the content), clamped to the viewport so they stay visible when
 * the canvas is scrolled or panned partly off-screen.
 *
 * Everything here is DECLARATIVE: tick positions and labels are computed
 * from `zoom`/`stagePosition`/scale every render — no imperative DOM/node
 * writes that could diverge from the transform (the pan-tool learning,
 * docs/solutions/ui-bugs/pan-tool-stale-imperative-stage-draggable-
 * restore-2026-07-18.md).
 *
 * CANONICAL METERS: `realSizePerGridSquare` is meters (U1); `modelToReal`
 * returns meters and `formatMeasurement` converts to the display `unit`.
 * Switching the unit re-labels the same physical sizes (origin AE2).
 *
 * Two coordinate frames (why both rects are resolved):
 * - The STAGE container rect (`getStage().container()`) is the canvas: it
 *   both anchors the ruler bands (their edges) AND locates a model
 *   coordinate on screen: `screenX = stageRect.left + stagePosition.x +
 *   modelX * zoom` (the exact `TextEditOverlay` formula). Its left/top shift
 *   as the workspace scrolls, so the bands and ticks track scroll together.
 * - The WORKSPACE viewport rect (the `overflow-auto` ancestor, tagged
 *   `data-canvas-workspace`) is the CLAMP: it bounds where the bands may sit
 *   and the pixel window ticks are culled to, so a band never leaves the
 *   visible area and off-screen ticks aren't rendered (R7 — only draw what's
 *   on screen, count adapting with zoom, AE1).
 */

/** Ruler band thickness in px (the labeled strip along each edge). */
const RULER_THICKNESS = 22

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface RulerRects {
  /** Stage container rect — the tick origin (moves with scroll/pan/zoom). */
  stage: Rect
  /** Workspace viewport rect — where the bands pin and the cull window. */
  view: Rect
}

/** Resolves both rects from the live stage, or null when unavailable
 * (pre-mount, or jsdom without a mocked stage). Kept as a plain function so
 * the component stays declarative and tests can supply a fake `getStage`
 * whose `container()` exposes `getBoundingClientRect` + `closest`. */
function resolveRects(getStage: () => Konva.Stage | null): RulerRects | null {
  const container = getStage()?.container()
  if (!container) return null
  const workspace = container.closest('[data-canvas-workspace]') as HTMLElement | null
  const stage = container.getBoundingClientRect()
  const view = (workspace ?? container).getBoundingClientRect()
  return {
    stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height },
    view: { left: view.left, top: view.top, width: view.width, height: view.height },
  }
}

interface AxisTick {
  /** Screen position (px) along the axis. */
  screen: number
  /** Label text for a major tick; null for an unlabeled minor tick. */
  label: string | null
}

/**
 * Pure tick generator for one axis (exported for direct truth-table
 * testing, the repo's pure-helper convention): given the transform, the
 * scale, and the on-screen window, returns the ticks to draw with their
 * screen positions and (for majors) labels. Culls to `[viewStart, viewEnd]`
 * and never emits below the canvas origin (model 0). Meters in, display
 * unit out via `formatMeasurement`.
 */
// Pure helper exported from a .tsx for standalone testing — the repo
// convention (same as ObjectShape's `colorForType`).
// eslint-disable-next-line react-refresh/only-export-components
export function buildAxisTicks(
  zoom: number,
  gridSize: number,
  realSizePerGridSquare: number,
  unit: Unit,
  stageOrigin: number,
  stageOffset: number,
  viewStart: number,
  viewEnd: number,
): AxisTick[] {
  const perPixel = realPerPixel(realSizePerGridSquare, gridSize)
  if (!(zoom > 0) || perPixel <= 0 || viewEnd <= viewStart) return []

  const { major, minor } = chooseTickIntervals(zoom, gridSize, realSizePerGridSquare, unit)
  // Real-unit step -> model-pixel step. Both steps are always positive
  // (chooseTickIntervals' degenerate fallback returns gridReal or 1) and
  // perPixel > 0 was established by the early return above, so these are
  // finite positive strides; a pathological tiny step is still bounded by
  // the `last - first` cap below.
  const minorModel = minor / perPixel
  const majorModel = major / perPixel

  // Screen(modelX) = stageOrigin + stageOffset + modelX * zoom. Invert to
  // find the model range covering [viewStart, viewEnd], clamped at model 0
  // (the ruler measures from the origin — no negative ticks).
  const base = stageOrigin + stageOffset
  const modelStart = Math.max(0, (viewStart - base) / zoom)
  const modelEnd = (viewEnd - base) / zoom
  if (modelEnd < modelStart) return []

  const ticks: AxisTick[] = []
  const first = Math.ceil(modelStart / minorModel - 1e-9)
  const last = Math.floor(modelEnd / minorModel + 1e-9)
  // Safety bound so a pathological (tiny-step / huge-range) combination
  // can't spin — far more than any real screen holds.
  if (last - first > 10000) return []
  for (let k = first; k <= last; k += 1) {
    const modelCoord = k * minorModel
    const screen = base + modelCoord * zoom
    // A major (labeled) tick when this position is also a multiple of the
    // major step (within float slack).
    const majorRatio = modelCoord / majorModel
    const isMajor = Math.abs(majorRatio - Math.round(majorRatio)) < 1e-6
    ticks.push({
      screen,
      label: isMajor
        ? formatMeasurement(modelToReal(modelCoord, realSizePerGridSquare, gridSize), unit)
        : null,
    })
  }
  return ticks
}

export interface RulerOverlayProps {
  /** Resolves the live Stage for its container rect + the workspace
   * ancestor. Nullable (jsdom / pre-mount) — the overlay renders nothing. */
  getStage: () => Konva.Stage | null
  zoom: number
  stagePosition: Point
  gridSize: number
  /** The canvas DOCUMENT size in MODEL pixels (the page the user sees). Its
   * on-screen rect — `(0,0)→(canvasWidth,canvasHeight)` through the same
   * origin+offset+`zoom` transform the ticks use — is what the ruler bands
   * hug, NOT the Stage container div (which stays this size in CSS px while
   * the content scales/pans inside it). */
  canvasWidth: number
  canvasHeight: number
  /** The plan's scale in CANONICAL METERS per grid square (U1). */
  realSizePerGridSquare: number
  unit: Unit
}

export function RulerOverlay({
  getStage,
  zoom,
  stagePosition,
  gridSize,
  canvasWidth,
  canvasHeight,
  realSizePerGridSquare,
  unit,
}: RulerOverlayProps) {
  // Browser SCROLL of the overflow-auto workspace (and window resize)
  // changes neither `zoom` nor `stagePosition` and fires no store
  // re-render, yet moves the canvas under this fixed overlay — so without
  // this the ticks drift between pans (review-pass find). A forced
  // re-render on scroll/resize re-reads the container rect and re-aligns.
  const [, forceTick] = useReducer((n: number) => n + 1, 0)
  // True during an active drag-to-pan gesture. The store's `stagePosition`
  // only commits on the pan's `dragend` (CanvasStage `onPanEnd`), so DURING
  // the pan we read the live offset off the Stage node instead — and mask
  // the numeric labels, which would otherwise reflow every frame; they
  // reappear at their settled positions when the gesture ends.
  const [panning, setPanning] = useState(false)

  // The Stage ref attaches during commit — AFTER this component's first
  // render, which therefore saw `getStage() === null` and drew nothing. A
  // ref assignment fires no re-render, so without nudging one the rulers stay
  // blank on initial page load until an unrelated re-render happens to occur.
  // Track readiness and flip it once the stage exists: that re-render draws
  // the rulers AND (via the deps below) attaches the scroll/pan listeners to
  // the live stage. Polls a few frames in case the ref lands a tick late.
  const [stageReady, setStageReady] = useState(() => Boolean(getStage()))
  useEffect(() => {
    if (stageReady) return
    let raf = 0
    const poll = () => {
      if (getStage()) setStageReady(true)
      else raf = requestAnimationFrame(poll)
    }
    poll()
    return () => cancelAnimationFrame(raf)
  }, [stageReady, getStage])

  useEffect(() => {
    const stage = getStage()
    const container = stage?.container()
    const workspace = container?.closest('[data-canvas-workspace]') as HTMLElement | null
    const onChange = () => forceTick()
    workspace?.addEventListener('scroll', onChange, { passive: true })
    window.addEventListener('resize', onChange)

    // Track a live Konva-stage PAN so the ticks follow the canvas mid-drag.
    // Only the Stage's OWN drag is a pan (object drags fire on their node —
    // the `event.target === stage` guard mirrors CanvasStage). `.on` is
    // feature-detected so non-Konva test stubs are a no-op. Namespaced
    // handlers so cleanup removes only ours.
    let detachStage = () => {}
    if (stage && typeof stage.on === 'function') {
      const isPan = (event: Konva.KonvaEventObject<DragEvent>) => event.target === stage
      stage.on('dragstart.rulers', (event) => {
        if (isPan(event)) setPanning(true)
      })
      stage.on('dragmove.rulers', (event) => {
        if (isPan(event)) forceTick()
      })
      stage.on('dragend.rulers', (event) => {
        if (isPan(event)) setPanning(false)
      })
      detachStage = () => stage.off('.rulers')
    }

    return () => {
      workspace?.removeEventListener('scroll', onChange)
      window.removeEventListener('resize', onChange)
      detachStage()
    }
  }, [getStage, stageReady])

  const rects = resolveRects(getStage)
  if (!rects) return null

  const { stage, view } = rects

  // The pan offset. During an ACTIVE drag-to-pan we read it LIVE off the Stage
  // node (`.x()/.y()`), because the store's `stagePosition` only commits on
  // `dragend` — so the node is the only current source mid-gesture. Otherwise
  // we trust the `stagePosition` PROP: on a store-driven change like a
  // wheel-zoom, `zoom` and `stagePosition` update together, but the Konva
  // node's x/y lag the props by one commit — reading them there would pair a
  // NEW zoom with an OLD offset and drift the ticks off the freshly-scaled
  // grid (the zoom bug). Prop and node agree at rest, so this only matters
  // mid-gesture. `.x` is feature-detected for non-Konva test stubs.
  const stageNode = getStage()
  const offsetX =
    panning && typeof stageNode?.x === 'function' ? stageNode.x() : stagePosition.x
  const offsetY =
    panning && typeof stageNode?.y === 'function' ? stageNode.y() : stagePosition.y

  // The bands hug the CANVAS DOCUMENT — the white page the user sees — NOT
  // the Stage container div. The container stays `canvasWidth×canvasHeight`
  // CSS px while the content scales by `zoom` and pans by `stagePosition`
  // INSIDE it, so the document is a sub-rectangle of the container whenever
  // zoomed or panned; hugging the container drifted the ruler off the page
  // (the review photo). The document's on-screen rect is model
  // `(0,0)→(canvasWidth,canvasHeight)` through the SAME origin+offset+zoom
  // transform the ticks use, so `docLeft` is exactly the model-0 tick — the
  // ruler's `0,0` lands on the page's own corner. Clamp each edge to the
  // viewport so a band never leaves the visible area on scroll/pan.
  const viewRight = view.left + view.width
  const viewBottom = view.top + view.height
  const docLeft = stage.left + offsetX
  const docTop = stage.top + offsetY
  const docRight = docLeft + canvasWidth * zoom
  const docBottom = docTop + canvasHeight * zoom
  const canvasLeft = Math.max(view.left, docLeft)
  const canvasTop = Math.max(view.top, docTop)
  const canvasRight = Math.min(viewRight, docRight)
  const canvasBottom = Math.min(viewBottom, docBottom)

  // Drawable spans begin one thickness past the corner so the top and left
  // bands don't overlap where they meet.
  const topStart = canvasLeft + RULER_THICKNESS
  const leftStart = canvasTop + RULER_THICKNESS

  const horizontal = buildAxisTicks(
    zoom,
    gridSize,
    realSizePerGridSquare,
    unit,
    stage.left,
    offsetX,
    topStart,
    canvasRight,
  )
  const vertical = buildAxisTicks(
    zoom,
    gridSize,
    realSizePerGridSquare,
    unit,
    stage.top,
    offsetY,
    leftStart,
    canvasBottom,
  )

  const bandStyle =
    'pointer-events-none fixed z-30 bg-background/95 text-[9px] text-muted-foreground select-none'

  return (
    <>
      {/* Top (horizontal) ruler band — overlays the canvas's top edge */}
      <div
        data-testid="ruler-top"
        aria-hidden="true"
        className={`${bandStyle} border-b`}
        style={{
          left: topStart,
          top: canvasTop,
          width: Math.max(0, canvasRight - topStart),
          height: RULER_THICKNESS,
        }}
      >
        {horizontal.map((tick, index) => (
          <div
            key={index}
            data-tick={tick.label != null ? 'major' : 'minor'}
            className={
              tick.label != null
                ? 'absolute bottom-0 border-l border-border'
                : 'absolute bottom-0 border-l border-border/50'
            }
            style={{
              left: tick.screen - topStart,
              height: tick.label != null ? RULER_THICKNESS : RULER_THICKNESS / 2,
            }}
          >
            {tick.label != null && !panning && (
              <span className="absolute top-0 left-0.5 whitespace-nowrap">{tick.label}</span>
            )}
          </div>
        ))}
      </div>

      {/* Left (vertical) ruler band — overlays the canvas's left edge */}
      <div
        data-testid="ruler-left"
        aria-hidden="true"
        className={`${bandStyle} border-r`}
        style={{
          left: canvasLeft,
          top: leftStart,
          width: RULER_THICKNESS,
          height: Math.max(0, canvasBottom - leftStart),
        }}
      >
        {vertical.map((tick, index) => (
          <div
            key={index}
            data-tick={tick.label != null ? 'major' : 'minor'}
            className={
              tick.label != null
                ? 'absolute right-0 border-t border-border'
                : 'absolute right-0 border-t border-border/50'
            }
            style={{
              top: tick.screen - leftStart,
              width: tick.label != null ? RULER_THICKNESS : RULER_THICKNESS / 2,
            }}
          >
            {tick.label != null && !panning && (
              // Vertical text laid out INSIDE the band via writing-mode — the
              // old `rotate(90deg)` around top-left pushed the glyphs ~9px past
              // the band's left edge into the gutter (the stray mark). This
              // keeps the label within the 22px band, reading top-to-bottom
              // beside its tick, mirroring how the top ruler's labels sit.
              <span
                className="absolute left-0.5 top-1 whitespace-nowrap leading-none"
                style={{ writingMode: 'vertical-rl' }}
              >
                {tick.label}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Corner box where the two rulers meet — the canvas's top-left corner */}
      <div
        data-testid="ruler-corner"
        aria-hidden="true"
        className={`${bandStyle} border-r border-b`}
        style={{ left: canvasLeft, top: canvasTop, width: RULER_THICKNESS, height: RULER_THICKNESS }}
      />
    </>
  )
}
