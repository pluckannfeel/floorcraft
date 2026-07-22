/**
 * U2 (canvas-rulers-scale): the pure ruler math module — Konva-FREE by design.
 *
 * Three responsibilities, all referentially transparent so the U3 DOM overlay
 * is thin plumbing over them (the `coordinates.ts` / `symbols.ts` convention):
 *   1. model-pixel -> real-unit conversion (R6),
 *   2. zoom-adaptive, grid-aligned tick-interval selection (R7/R8, AE1),
 *   3. per-unit measurement formatting (R9, AE2).
 *
 * WHY a single pure helper set with a pinned truth table: the pan-tool
 * learning (docs/solutions/ui-bugs/pan-tool-stale-imperative-stage-draggable-
 * restore-2026-07-18.md) showed that positioning canvas chrome imperatively
 * from a live node diverges on the next pan and never self-heals. The fix is
 * to derive tick positions/labels DECLARATIVELY from `zoom`/`stagePosition`
 * every render — which is only safe if the transform + tick math lives in one
 * exported, truth-table-tested pure module (this file) that the overlay reads.
 * No Konva import lives here; the overlay owns the DOM.
 *
 * SCREEN<->MODEL boundary: this module deliberately does NO screen<->model
 * conversion. That transform is the `stagePosition + model * zoom` mapping
 * (its inverse, screen -> model, is `coordinates.ts`'s `containerToStagePoint`).
 * The U3 overlay applies the model -> screen direction INLINE — the same
 * one-line `containerRect.left + stagePosition.x + modelX * zoom` form
 * `TextEditOverlay`/`CropTool` already use — because `coordinates.ts` exports
 * only the screen -> model inverse (a shared `modelToScreen` helper across
 * those overlays is a reasonable later extraction, not forked here). This
 * file owns neither direction: it only maps an ALREADY-model coordinate to
 * its real-world value and chooses the real-unit steps the overlay lays out.
 */

/**
 * The measurement units a plan can display in — mirrors the backend
 * `FloorPlan.unit` choices (`meters` | `feet_inches`, U1). Declared as a
 * `const` tuple + derived union (the `types.ts` `CATALOG_TYPES` convention) so
 * an exhaustive switch stays a compile error when a unit is added and the
 * runtime list is available to the control's selector (U4).
 */
export const UNITS = ['meters', 'feet_inches'] as const

/** Feet per meter (1 / 0.3048). All stored scale/geometry is in canonical
 * meters (U1); imperial display converts through this. */
export const FEET_PER_METER = 1 / 0.3048
export type Unit = (typeof UNITS)[number]

/** Smallest allowed real size per grid square, in canonical meters. Mirrors
 * the backend `FloorPlan.real_size_per_grid_square` `MinValueValidator(0.0001)`
 * so the U4 scale control rejects a sub-floor value client-side rather than
 * round-tripping it to a 400 (a scale at/below this collapses the ruler). */
export const MIN_REAL_SIZE_PER_GRID_SQUARE = 0.0001

/**
 * Minimum on-screen pixel gap the LABELED (major) ticks target so adjacent
 * labels never overlap (R7/AE1). Chosen at 72px — mid-range of the plan's
 * ~60-80px target: a "2.00 m" / "11' 6\"" label is ~40-55px wide at the
 * overlay's font size, so 72px leaves a clear channel between labels while
 * still labeling as densely as legibility allows. This is the knob AE1's
 * no-crowding guarantee rests on: `chooseTickIntervals` never returns a major
 * step whose on-screen span is below this.
 */
export const MIN_LABEL_GAP_PX = 72

/**
 * Feet-inches labels ("11' 6\"") render wider than metric ("2.00 m"), so the
 * imperial ruler needs more breathing room to stay non-overlapping at the same
 * font size. This is the sole reason `chooseTickIntervals` consumes `unit`:
 * the interval MATH is unit-agnostic (it always works in canonical METERS —
 * the stored scale is meters, U1), but the crowding threshold is
 * label-width-sensitive, and imperial labels are the wide ones.
 */
export const MIN_LABEL_GAP_PX_IMPERIAL = 84

/**
 * Real-world units per MODEL pixel: `realSizePerGridSquare / gridSize`.
 * One grid square spans `gridSize` model pixels and represents
 * `realSizePerGridSquare` real units, so each model pixel is their ratio.
 * E.g. 1 square = 0.5 m over gridSize 20 -> 0.025 m/px.
 *
 * Guards a non-positive `gridSize` by returning 0 (no scale) rather than
 * dividing by zero — mirrors `coordinates.ts` `snapToGrid`'s `gridSize <= 0`
 * no-op guard so a not-yet-seeded plan can't emit `Infinity`/`NaN` ticks.
 */
export function realPerPixel(realSizePerGridSquare: number, gridSize: number): number {
  if (gridSize <= 0) return 0
  return realSizePerGridSquare / gridSize
}

/**
 * Maps a MODEL-space coordinate (already in canvas/stage space — the overlay
 * runs `containerToStagePoint` first if it starts from screen space) to its
 * real-world value: `modelCoord * realPerPixel(...)`. The ruler measures from
 * the canvas origin (top-left model 0,0 -> real 0), so this is the whole of
 * R6's "true measurement from the origin" for a single axis.
 * E.g. model x 80 px at 1 square = 0.5 m, gridSize 20 -> 2.0 m (feeds AE4).
 */
export function modelToReal(modelCoord: number, realSizePerGridSquare: number, gridSize: number): number {
  return modelCoord * realPerPixel(realSizePerGridSquare, gridSize)
}

/** The real-unit step sizes a ruler axis renders. `major` ticks are LABELED;
 * `minor` ticks are unlabeled subdivisions. Invariant (relied on by the
 * overlay): `major` is an integer multiple of `minor`, and both are multiples
 * of the grid's real size — so every major tick coincides with a minor tick
 * and every tick lands on a grid line (R8). */
export interface TickIntervals {
  /** Real-unit distance between labeled ticks. */
  major: number
  /** Real-unit distance between unlabeled subdivision ticks (`<= major`). */
  minor: number
}

/**
 * Smallest "nice" number (mantissa in {1, 2, 5}) times a power of ten that is
 * `>= value` — the standard 1/2/5×10^n ladder used for axis ticks. Keeps
 * labeled real values readable (…0.2, 0.5, 1, 2, 5, 10…) before grid-snapping.
 * Guards `value <= 0` (returns 0) so `log10` is never fed a non-positive.
 */
function niceCeil(value: number): number {
  if (value <= 0) return 0
  const exponent = Math.floor(Math.log10(value))
  const base = Math.pow(10, exponent)
  const fraction = value / base // in [1, 10)
  let niceFraction: number
  if (fraction <= 1) niceFraction = 1
  else if (fraction <= 2) niceFraction = 2
  else if (fraction <= 5) niceFraction = 5
  else niceFraction = 10
  return niceFraction * base
}

/**
 * Snaps a real-unit step UP to the nearest whole multiple of the grid's real
 * size, so labeled ticks always land on grid lines (R8). At least one grid
 * square (you can't align finer than the grid). The `- 1e-9` slack keeps an
 * already-exact multiple (e.g. 2.0 / 0.5 = 4) from rounding up a spurious
 * extra square on float dust.
 */
function snapUpToGridMultiple(realStep: number, gridReal: number): number {
  const squares = Math.max(1, Math.ceil(realStep / gridReal - 1e-9))
  return squares * gridReal
}

/**
 * Picks the UNLABELED minor step subdividing `major` into a nice count of
 * grid-aligned pieces. Preference order 5 -> 4 -> 2 subdivisions (the usual
 * ruler feel), each only taken when it divides the major's grid-square count
 * evenly (so minor stays a whole number of grid squares). When no clean
 * subdivision exists (e.g. major is exactly 1 grid square, or a prime count of
 * them) minor collapses to major — i.e. every tick is labeled and there are no
 * separate minors. This guarantees `major` is an integer multiple of `minor`.
 */
function chooseMinorStep(major: number, gridReal: number): number {
  const majorSquares = Math.round(major / gridReal)
  for (const subdivisions of [5, 4, 2]) {
    if (majorSquares % subdivisions === 0) {
      return (majorSquares / subdivisions) * gridReal
    }
  }
  return major
}

/**
 * Chooses the zoom-adaptive, grid-aligned tick intervals for a ruler axis
 * (R7/R8, AE1). Returns REAL-unit steps; the overlay converts them to screen
 * via `modelX * zoom`.
 *
 * Pipeline:
 *   1. `screenPerReal = zoom * gridSize / realSizePerGridSquare` — on-screen
 *      pixels per real unit under the current transform.
 *   2. `minRealStep = minLabelGap / screenPerReal` — the smallest real step
 *      whose labels are at least `minLabelGap` px apart (no crowding, AE1).
 *   3. Round that up the 1/2/5×10^n nice ladder, then snap up to a grid
 *      multiple (R8). Because both steps only ever INCREASE the value, the
 *      final major step's on-screen span is always `>= minLabelGap`.
 *   4. Derive the minor step as a clean grid-aligned subdivision of major.
 *
 * `unit` selects the crowding threshold (imperial labels are wider — see
 * `MIN_LABEL_GAP_PX_IMPERIAL`); the interval arithmetic itself is unit-
 * agnostic and always works in canonical METERS (the stored scale is
 * meters, U1); only label formatting converts to the display unit.
 *
 * Non-positive `zoom`/`gridSize`/`realSizePerGridSquare` degrade to a single
 * grid-square step (or 1 when even that is undefined) so a not-yet-seeded plan
 * renders a determinate — never `NaN`/`Infinity` — tick set.
 */
export function chooseTickIntervals(
  zoom: number,
  gridSize: number,
  realSizePerGridSquare: number,
  unit: Unit,
): TickIntervals {
  const gridReal = realSizePerGridSquare // finest grid-aligned real step = one square
  if (!(zoom > 0) || !(gridSize > 0) || !(gridReal > 0)) {
    const fallback = gridReal > 0 ? gridReal : 1
    return { major: fallback, minor: fallback }
  }

  const minLabelGap = unit === 'feet_inches' ? MIN_LABEL_GAP_PX_IMPERIAL : MIN_LABEL_GAP_PX
  const screenPerReal = (zoom * gridSize) / gridReal
  const minRealStep = minLabelGap / screenPerReal

  const niceStep = niceCeil(minRealStep)
  const major = snapUpToGridMultiple(niceStep, gridReal)
  const minor = chooseMinorStep(major, gridReal)
  return { major, minor }
}

/**
 * Formats a real-world value for a ruler label per `unit` (R9, AE2).
 *
 * - `meters`: always 2-decimal meters ("0.90 m", "2.00 m"). Resolves the
 *   plan's deferred cm-threshold question in favour of the v1 default —
 *   ALWAYS meters, never dropping to centimeters below a threshold — so a
 *   sub-metre value reads "0.05 m", not "5 cm". One format for the whole
 *   ruler keeps label widths predictable.
 * - `feet_inches`: architectural feet-and-inches. `realValue` arrives in
 *   canonical METERS (the stored scale is always meters — U1; `unit` is a
 *   display choice, not the scalar's unit) and is CONVERTED to feet here,
 *   then rendered as whole feet + inches rounded to the nearest inch,
 *   carrying 12 inches up into the next foot. So the SAME physical value
 *   reads "0.91 m" or "3' 0\"" depending on unit (origin AE2), never a
 *   different physical size. Zero renders as "0' 0\"" — the uniform
 *   feet+inches shape every other label already uses (chosen over a bare
 *   "0\"" for consistent label geometry). Values are non-negative (the ruler
 *   measures from the origin), so a tiny negative from float dust is clamped
 *   to 0 rather than producing a "-0' 0\"".
 */
export function formatMeasurement(realValue: number, unit: Unit): string {
  const value = Number.isFinite(realValue) ? realValue : 0

  if (unit === 'feet_inches') {
    const feet = Math.max(0, value) * FEET_PER_METER
    const totalInches = Math.round(feet * 12)
    const wholeFeet = Math.floor(totalInches / 12)
    const inches = totalInches % 12
    return `${wholeFeet}' ${inches}"`
  }

  // meters (default)
  return `${value.toFixed(2)} m`
}
