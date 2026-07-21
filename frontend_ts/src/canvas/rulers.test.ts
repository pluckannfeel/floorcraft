import { describe, expect, it } from 'vitest'
import {
  MIN_LABEL_GAP_PX,
  MIN_LABEL_GAP_PX_IMPERIAL,
  UNITS,
  chooseTickIntervals,
  formatMeasurement,
  modelToReal,
  realPerPixel,
} from './rulers'
import type { Unit } from './rulers'

/**
 * U2 (canvas-rulers-scale): truth-table tests for the pure ruler math module.
 * Mirrors the `coordinates.test.ts` / `symbols.test.ts` convention — jsdom
 * can't mount a Konva `Stage`, so every value the U3 DOM overlay will feed
 * into tick positions/labels (real-unit conversion, zoom-adaptive interval
 * selection, unit formatting) is asserted standalone here. Per the pan-tool
 * learning (docs/solutions/ui-bugs/pan-tool-stale-imperative-stage-draggable-
 * restore-2026-07-18.md): the transform + tick math is ONE exported pure
 * helper set with its truth table pinned, so the overlay stays declarative
 * plumbing that can't silently diverge.
 */

/** Screen pixels covered by one real unit at a given zoom — the overlay's
 * `zoom / realPerPixel`, restated here so the min-label-gap assertions are
 * derived independently of the module under test (no shared helper to be
 * wrong in both places). */
function screenPerReal(zoom: number, gridSize: number, realSizePerGridSquare: number): number {
  return (zoom * gridSize) / realSizePerGridSquare
}

/** Float-safe "is `value` an integer multiple of `base`" — grid-alignment
 * checks (R8) must not fail on 0.025-style rounding dust. */
function isMultipleOf(value: number, base: number): boolean {
  return Math.abs(value / base - Math.round(value / base)) < 1e-9
}

describe('realPerPixel / modelToReal (R6 conversion boundary)', () => {
  it('derives real-units-per-model-pixel as realSizePerGridSquare / gridSize', () => {
    // 1 square = 0.5 m over gridSize 20 px => 0.025 m/px.
    expect(realPerPixel(0.5, 20)).toBeCloseTo(0.025, 12)
  })

  it('maps a model coordinate to its real value (the AE4-feeding case)', () => {
    // 1 square = 0.5 m, gridSize 20, model x 80 px => 2.0 m (feeds U3's AE4).
    expect(modelToReal(80, 0.5, 20)).toBeCloseTo(2.0, 12)
    expect(modelToReal(40, 0.5, 20)).toBeCloseTo(1.0, 12)
    expect(modelToReal(0, 0.5, 20)).toBe(0)
  })

  it('scales linearly with the real-size-per-square', () => {
    // Same gridSize, double the real size per square => double the real value.
    expect(modelToReal(80, 1.0, 20)).toBeCloseTo(4.0, 12)
  })

  it('guards a non-positive gridSize (no scale) rather than dividing by zero', () => {
    expect(realPerPixel(0.5, 0)).toBe(0)
    expect(modelToReal(80, 0.5, 0)).toBe(0)
  })
})

describe('chooseTickIntervals (R7/R8, AE1: zoom-adaptive, grid-aligned ticks)', () => {
  // Fixed scale for the three-zoom sweep: 1 square = 0.5 m over 20 px.
  const gridSize = 20
  const real = 0.5
  const gridReal = real // the finest grid-aligned real step is one grid square

  const atLowZoom = chooseTickIntervals(0.5, gridSize, real, 'meters')
  const atUnitZoom = chooseTickIntervals(1, gridSize, real, 'meters')
  const atHighZoom = chooseTickIntervals(4, gridSize, real, 'meters')

  it('pins the chosen ladder at ~3 representative zooms', () => {
    // Low zoom => coarse labels; high zoom => label every grid line.
    expect(atLowZoom).toEqual({ major: 5, minor: 1 })
    expect(atUnitZoom).toEqual({ major: 2, minor: 0.5 })
    expect(atHighZoom).toEqual({ major: 0.5, minor: 0.5 })
  })

  it('coarsens the labeled (major) step as zoom decreases (AE1)', () => {
    expect(atLowZoom.major).toBeGreaterThan(atUnitZoom.major)
    expect(atUnitZoom.major).toBeGreaterThan(atHighZoom.major)
  })

  it('never crowds labels: each major step spans at least the min-label-gap', () => {
    for (const [zoom, chosen] of [
      [0.5, atLowZoom],
      [1, atUnitZoom],
      [4, atHighZoom],
    ] as const) {
      const gapPx = chosen.major * screenPerReal(zoom, gridSize, real)
      expect(gapPx).toBeGreaterThanOrEqual(MIN_LABEL_GAP_PX - 1e-9)
    }
  })

  it('keeps every interval grid-aligned — major & minor are grid multiples (R8)', () => {
    for (const chosen of [atLowZoom, atUnitZoom, atHighZoom]) {
      expect(isMultipleOf(chosen.major, gridReal)).toBe(true)
      expect(isMultipleOf(chosen.minor, gridReal)).toBe(true)
    }
  })

  it('makes major an integer multiple of minor (overlay: every major sits on a minor tick)', () => {
    for (const chosen of [atLowZoom, atUnitZoom, atHighZoom]) {
      const ratio = chosen.major / chosen.minor
      expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-9)
      expect(chosen.minor).toBeLessThanOrEqual(chosen.major)
    }
  })

  it('stays grid-aligned & gap-respecting across a sweep of scales/zooms (R7/R8)', () => {
    const cases: Array<{ zoom: number; gridSize: number; real: number; unit: Unit }> = [
      { zoom: 0.25, gridSize: 20, real: 0.5, unit: 'meters' },
      { zoom: 2, gridSize: 40, real: 1.0, unit: 'meters' },
      { zoom: 1, gridSize: 20, real: 0.25, unit: 'meters' },
      { zoom: 3, gridSize: 25, real: 0.5, unit: 'feet_inches' },
    ]
    for (const c of cases) {
      const chosen = chooseTickIntervals(c.zoom, c.gridSize, c.real, c.unit)
      const gap = c.unit === 'feet_inches' ? MIN_LABEL_GAP_PX_IMPERIAL : MIN_LABEL_GAP_PX
      expect(isMultipleOf(chosen.major, c.real)).toBe(true)
      expect(isMultipleOf(chosen.minor, c.real)).toBe(true)
      const gapPx = chosen.major * screenPerReal(c.zoom, c.gridSize, c.real)
      expect(gapPx).toBeGreaterThanOrEqual(gap - 1e-9)
    }
  })

  it('gives feet-inches labels extra breathing room (wider labels need a bigger gap)', () => {
    // "11' 6\"" renders wider than "2.00 m", so imperial demands a larger gap.
    expect(MIN_LABEL_GAP_PX_IMPERIAL).toBeGreaterThanOrEqual(MIN_LABEL_GAP_PX)
    // 1 ft per square over 20 px at zoom 1: minRealStep = 84/20 = 4.2 ft
    // => nice-ceil 5 => snapped to grid => major 5 ft, minor 1 ft.
    const imperial = chooseTickIntervals(1, 20, 1, 'feet_inches')
    expect(imperial).toEqual({ major: 5, minor: 1 })
  })

  it('degrades gracefully on non-positive inputs instead of NaN/Infinity ticks', () => {
    expect(chooseTickIntervals(0, 20, 0.5, 'meters')).toEqual({ major: 0.5, minor: 0.5 })
    expect(chooseTickIntervals(1, 0, 0.5, 'meters')).toEqual({ major: 0.5, minor: 0.5 })
  })
})

describe('formatMeasurement — meters (R9/AE2: always-meters, 2 decimals)', () => {
  it('renders 2-decimal meters throughout', () => {
    expect(formatMeasurement(0.9, 'meters')).toBe('0.90 m')
    expect(formatMeasurement(1.5, 'meters')).toBe('1.50 m')
    expect(formatMeasurement(2, 'meters')).toBe('2.00 m')
  })

  it('renders zero as 0.00 m', () => {
    expect(formatMeasurement(0, 'meters')).toBe('0.00 m')
  })

  it('always shows meters — never drops to centimeters below a threshold', () => {
    // 5 cm stays "0.05 m", not "5 cm" (the deferred cm-threshold question:
    // v1 default is always-meters).
    expect(formatMeasurement(0.05, 'meters')).toBe('0.05 m')
    expect(formatMeasurement(0.01, 'meters')).toBe('0.01 m')
  })

  it('rounds to the nearest centimeter', () => {
    expect(formatMeasurement(1.996, 'meters')).toBe('2.00 m')
    expect(formatMeasurement(1.234, 'meters')).toBe('1.23 m')
  })
})

describe('formatMeasurement — feet_inches (R9/AE2: architectural feet & inches)', () => {
  // Input is canonical METERS (U1); the formatter converts to feet-inches.
  it('converts meters to whole feet + inches rounded to the nearest inch', () => {
    expect(formatMeasurement(0.9144, 'feet_inches')).toBe('3\' 0"') // 0.9144 m = 3 ft exactly
    expect(formatMeasurement(3.5, 'feet_inches')).toBe('11\' 6"') // 3.5 m = 11.483 ft ≈ 11' 6"
    expect(formatMeasurement(0.3048, 'feet_inches')).toBe('1\' 0"') // 0.3048 m = 1 ft
  })

  it('renders a value just under a foot as 0 feet + inches', () => {
    // 11 inches = 11 * 0.0254 m.
    expect(formatMeasurement(11 * 0.0254, 'feet_inches')).toBe('0\' 11"')
  })

  it('carries 12 rounded inches up into the next foot', () => {
    // 0.302 m = 11.89 in => rounds to 12 in => carries to 1' 0".
    expect(formatMeasurement(0.302, 'feet_inches')).toBe('1\' 0"')
  })

  it('rounds sub-inch fractions to the nearest inch', () => {
    // 2.04 in ≈ 0.0518 m -> 2 in ; 2.55 in ≈ 0.0648 m -> 3 in (rounding boundary within a foot).
    expect(formatMeasurement(0.05, 'feet_inches')).toBe('0\' 2"') // 0.05 m = 1.97 in -> 2"
    expect(formatMeasurement(0.064, 'feet_inches')).toBe('0\' 3"') // 0.064 m = 2.52 in -> 3"
  })

  it('renders exactly zero as 0\' 0" (uniform feet+inches format)', () => {
    expect(formatMeasurement(0, 'feet_inches')).toBe('0\' 0"')
  })
})

describe('formatMeasurement — same physical value, two units (AE2 live unit switch)', () => {
  it('re-labels the SAME meters value per unit (physical size invariant)', () => {
    // 0.9144 m is one physical size: "0.91 m" metric, "3' 0\"" imperial —
    // switching the unit re-formats, it does not rescale (origin AE2).
    expect(formatMeasurement(0.9144, 'meters')).toBe('0.91 m')
    expect(formatMeasurement(0.9144, 'feet_inches')).toBe('3\' 0"')
  })
})

describe('UNITS enum (mirrors the backend FloorPlan.unit choices)', () => {
  it('lists exactly the two supported units', () => {
    expect([...UNITS]).toEqual(['meters', 'feet_inches'])
  })
})
