import {
  chooseTickIntervals,
  formatMeasurement,
  modelToReal,
  realPerPixel,
  type Unit,
} from './rulers'

/**
 * The canvas's edge rulers (canvas-rulers-scale R5-R8, AE1/AE4).
 *
 * Rendered in a workspace-clipped DOM layer that CanvasEditorPage pins to the
 * page origin (`stagePosition`) and translates each pan frame. So everything
 * here is measured from that origin (0,0 = the page's top-left): a model
 * coordinate `M` sits at `M * zoom` px in. No screen-coordinate math, no
 * `getBoundingClientRect`, no listeners — just arithmetic against the page.
 *
 * (It used to be a fixed-position overlay that re-derived screen rects every
 * frame and chased the canvas around. That approach caused every ruler bug on
 * this branch — overhang past the page, covering the page, jumpy panning, and
 * floating over the toolbar/sidebar. Positioning against the page origin, and
 * being clipped by the workspace, makes all of those structurally impossible.)
 *
 * CANONICAL METERS: `realSizePerGridSquare` is meters (U1); `modelToReal`
 * returns meters and `formatMeasurement` renders the display `unit`, so
 * switching units re-labels the same physical sizes (origin AE2).
 */

/** Ruler band thickness in px (the labeled strip along each edge). */
const RULER_THICKNESS = 22

export interface RulerTick {
  /** Offset along the axis in BOX pixels (model * zoom). */
  px: number
  /** Label for a major tick; null for an unlabeled minor tick. */
  label: string | null
}

/**
 * Ticks along one axis, from the page origin to `modelExtent` (the canvas's
 * model width/height). Pure, so the tick/label truth table is testable
 * without a DOM. Positions come back in box pixels — the caller just drops
 * each at `px`.
 */
// Pure helper exported from a .tsx for standalone testing — the repo
// convention (same as ObjectShape's `colorForType`).
// eslint-disable-next-line react-refresh/only-export-components
export function buildBoxTicks(
  modelExtent: number,
  zoom: number,
  gridSize: number,
  realSizePerGridSquare: number,
  unit: Unit,
): RulerTick[] {
  const perPixel = realPerPixel(realSizePerGridSquare, gridSize)
  if (!(zoom > 0) || perPixel <= 0 || !(modelExtent > 0)) return []

  const { major, minor } = chooseTickIntervals(zoom, gridSize, realSizePerGridSquare, unit)
  // Real-unit steps -> model-pixel strides. chooseTickIntervals guarantees
  // both are positive, and perPixel > 0 is checked above.
  const minorModel = minor / perPixel
  const majorModel = major / perPixel
  if (!(minorModel > 0)) return []

  const last = Math.floor(modelExtent / minorModel + 1e-9)
  // Safety bound so a pathological (tiny-step / huge-page) combination can't
  // spin — far more ticks than any page needs.
  if (last > 10000) return []

  const ticks: RulerTick[] = []
  for (let k = 0; k <= last; k += 1) {
    const model = k * minorModel
    const ratio = model / majorModel
    const isMajor = Math.abs(ratio - Math.round(ratio)) < 1e-6
    ticks.push({
      px: model * zoom,
      label: isMajor
        ? formatMeasurement(modelToReal(model, realSizePerGridSquare, gridSize), unit)
        : null,
    })
  }
  return ticks
}

export interface RulerOverlayProps {
  zoom: number
  gridSize: number
  /** The page's MODEL dimensions; the box renders them at `zoom`. */
  canvasWidth: number
  canvasHeight: number
  /** The plan's scale in CANONICAL METERS per grid square (U1). */
  realSizePerGridSquare: number
  unit: Unit
}

export function RulerOverlay({
  zoom,
  gridSize,
  canvasWidth,
  canvasHeight,
  realSizePerGridSquare,
  unit,
}: RulerOverlayProps) {
  const horizontal = buildBoxTicks(canvasWidth, zoom, gridSize, realSizePerGridSquare, unit)
  const vertical = buildBoxTicks(canvasHeight, zoom, gridSize, realSizePerGridSquare, unit)
  const boxWidth = canvasWidth * zoom
  const boxHeight = canvasHeight * zoom

  // Bands sit in the MARGIN just outside the page (negative offsets), so they
  // never cover canvas content.
  const bandStyle =
    'pointer-events-none absolute bg-background/95 text-[9px] text-muted-foreground select-none'

  return (
    <>
      {/* Top ruler — spans the page width, sitting just above its top edge */}
      <div
        data-testid="ruler-top"
        aria-hidden="true"
        className={`${bandStyle} border-b`}
        style={{ left: 0, top: -RULER_THICKNESS, width: boxWidth, height: RULER_THICKNESS }}
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
              left: tick.px,
              height: tick.label != null ? RULER_THICKNESS : RULER_THICKNESS / 2,
            }}
          >
            {tick.label != null && (
              <span className="absolute top-0 left-0.5 whitespace-nowrap">{tick.label}</span>
            )}
          </div>
        ))}
      </div>

      {/* Left ruler — spans the page height, just left of its left edge */}
      <div
        data-testid="ruler-left"
        aria-hidden="true"
        className={`${bandStyle} border-r`}
        style={{ left: -RULER_THICKNESS, top: 0, width: RULER_THICKNESS, height: boxHeight }}
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
              top: tick.px,
              width: tick.label != null ? RULER_THICKNESS : RULER_THICKNESS / 2,
            }}
          >
            {tick.label != null && (
              // Vertical text via writing-mode (a rotate transform pushed the
              // glyphs out past the band's edge).
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

      {/* Corner where the two rulers meet, off the page's top-left */}
      <div
        data-testid="ruler-corner"
        aria-hidden="true"
        className={`${bandStyle} border-r border-b`}
        style={{
          left: -RULER_THICKNESS,
          top: -RULER_THICKNESS,
          width: RULER_THICKNESS,
          height: RULER_THICKNESS,
        }}
      />
    </>
  )
}
