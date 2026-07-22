import { useEffect, useReducer } from 'react'
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
 * from the store transform, no live Konva node). An in-transform Konva
 * layer would scroll a `model y=0` band off-screen on pan; a DOM overlay
 * pins the ruler bands to the workspace VIEWPORT edges while the tick
 * numbers within them track the canvas, and it stays out of the PNG export
 * tree (rulers are editor chrome).
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
 * - The STAGE container rect (`getStage().container()`) locates a model
 *   coordinate on screen: `screenX = stageRect.left + stagePosition.x +
 *   modelX * zoom` (the exact `TextEditOverlay` formula). Its left/top
 *   already shift as the workspace scrolls, so ticks track scroll for free
 *   once we re-render on scroll.
 * - The WORKSPACE viewport rect (the `overflow-auto` ancestor, tagged
 *   `data-canvas-workspace`) is where the ruler BANDS pin and defines the
 *   visible pixel window ticks are culled to (R7 — only render what's on
 *   screen, and the count must adapt with zoom, AE1).
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
  /** The plan's scale in CANONICAL METERS per grid square (U1). */
  realSizePerGridSquare: number
  unit: Unit
}

export function RulerOverlay({
  getStage,
  zoom,
  stagePosition,
  gridSize,
  realSizePerGridSquare,
  unit,
}: RulerOverlayProps) {
  // Browser SCROLL of the overflow-auto workspace (and window resize)
  // changes neither `zoom` nor `stagePosition` and fires no store
  // re-render, yet moves the canvas under this fixed overlay — so without
  // this the ticks drift between pans (review-pass find). A forced
  // re-render on scroll/resize re-reads the container rect and re-aligns.
  const [, forceTick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const container = getStage()?.container()
    const workspace = container?.closest('[data-canvas-workspace]') as HTMLElement | null
    const onChange = () => forceTick()
    workspace?.addEventListener('scroll', onChange, { passive: true })
    window.addEventListener('resize', onChange)
    return () => {
      workspace?.removeEventListener('scroll', onChange)
      window.removeEventListener('resize', onChange)
    }
  }, [getStage])

  const rects = resolveRects(getStage)
  if (!rects) return null

  const { stage, view } = rects
  const horizontal = buildAxisTicks(
    zoom,
    gridSize,
    realSizePerGridSquare,
    unit,
    stage.left,
    stagePosition.x,
    view.left + RULER_THICKNESS, // start of the drawable area (past the corner/left band)
    view.left + view.width,
  )
  const vertical = buildAxisTicks(
    zoom,
    gridSize,
    realSizePerGridSquare,
    unit,
    stage.top,
    stagePosition.y,
    view.top + RULER_THICKNESS,
    view.top + view.height,
  )

  const bandStyle =
    'pointer-events-none fixed z-30 bg-background/95 text-[9px] text-muted-foreground select-none'

  return (
    <>
      {/* Top (horizontal) ruler band */}
      <div
        data-testid="ruler-top"
        aria-hidden="true"
        className={`${bandStyle} border-b`}
        style={{
          left: view.left + RULER_THICKNESS,
          top: view.top,
          width: Math.max(0, view.width - RULER_THICKNESS),
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
              left: tick.screen - (view.left + RULER_THICKNESS),
              height: tick.label != null ? RULER_THICKNESS : RULER_THICKNESS / 2,
            }}
          >
            {tick.label != null && (
              <span className="absolute top-0 left-0.5 whitespace-nowrap">{tick.label}</span>
            )}
          </div>
        ))}
      </div>

      {/* Left (vertical) ruler band */}
      <div
        data-testid="ruler-left"
        aria-hidden="true"
        className={`${bandStyle} border-r`}
        style={{
          left: view.left,
          top: view.top + RULER_THICKNESS,
          width: RULER_THICKNESS,
          height: Math.max(0, view.height - RULER_THICKNESS),
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
              top: tick.screen - (view.top + RULER_THICKNESS),
              width: tick.label != null ? RULER_THICKNESS : RULER_THICKNESS / 2,
            }}
          >
            {tick.label != null && (
              // Rotated so the label reads along the vertical ruler.
              <span
                className="absolute top-0.5 left-0 origin-top-left whitespace-nowrap"
                style={{ transform: 'rotate(90deg)' }}
              >
                {tick.label}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Corner box where the two rulers meet */}
      <div
        data-testid="ruler-corner"
        aria-hidden="true"
        className={`${bandStyle} border-r border-b`}
        style={{ left: view.left, top: view.top, width: RULER_THICKNESS, height: RULER_THICKNESS }}
      />
    </>
  )
}
