import Konva from 'konva'
import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  computePinchZoom,
  computeWheelZoom,
  computeZoomAtPoint,
  MAX_ZOOM,
  MIN_ZOOM,
  screenToStagePoint,
} from './coordinates'
import type { ZoomPanState } from './coordinates'

/**
 * U11: zoom/pan is pure `coordinates.ts` math (like every other geometry
 * helper in this module), so it's tested the same Konva-independent way —
 * no `<Stage>` mounted, per the established convention (see
 * `SelectionTransformer.test.tsx`'s doc comment: jsdom has no canvas, so
 * this codebase never mounts real Konva components in tests).
 */

describe('clampZoom', () => {
  it('leaves an in-range zoom unchanged', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(2)).toBe(2)
  })

  it('clamps below MIN_ZOOM up to MIN_ZOOM', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM)
  })

  it('clamps above MAX_ZOOM down to MAX_ZOOM', () => {
    expect(clampZoom(10)).toBe(MAX_ZOOM)
  })
})

describe('computeZoomAtPoint', () => {
  it('keeps the stage-space point under the cursor fixed after zooming in (1x -> 2x)', () => {
    const current: ZoomPanState = { zoom: 1, position: { x: 0, y: 0 } }
    // Cursor at (100, 100) on an unzoomed, unpanned stage is stage-space (100, 100).
    const next = computeZoomAtPoint(current, { x: 100, y: 100 }, 2)

    expect(next.zoom).toBe(2)
    // After zooming, the same screen point (100, 100) must still map to
    // stage-space (100, 100): position + point * scale === screen point.
    expect(next.position.x + 100 * next.zoom).toBeCloseTo(100)
    expect(next.position.y + 100 * next.zoom).toBeCloseTo(100)
  })

  it('keeps the cursor point fixed when zooming out from an already-panned/zoomed stage', () => {
    const current: ZoomPanState = { zoom: 2, position: { x: -50, y: 30 } }
    const pointer = { x: 250, y: 180 }
    // The stage-space point under the cursor before zooming.
    const stagePointBefore = {
      x: (pointer.x - current.position.x) / current.zoom,
      y: (pointer.y - current.position.y) / current.zoom,
    }

    const next = computeZoomAtPoint(current, pointer, 1)

    expect(next.zoom).toBe(1)
    const stagePointAfter = {
      x: (pointer.x - next.position.x) / next.zoom,
      y: (pointer.y - next.position.y) / next.zoom,
    }
    expect(stagePointAfter.x).toBeCloseTo(stagePointBefore.x)
    expect(stagePointAfter.y).toBeCloseTo(stagePointBefore.y)
  })

  it('clamps the resulting zoom into range even when the raw requested scale is out of bounds', () => {
    const current: ZoomPanState = { zoom: 1, position: { x: 0, y: 0 } }
    expect(computeZoomAtPoint(current, { x: 0, y: 0 }, 100).zoom).toBe(MAX_ZOOM)
    expect(computeZoomAtPoint(current, { x: 0, y: 0 }, 0.001).zoom).toBe(MIN_ZOOM)
  })
})

describe('computeWheelZoom', () => {
  it('zooms in (increases scale) for a negative deltaY (scroll up)', () => {
    const current: ZoomPanState = { zoom: 1, position: { x: 0, y: 0 } }
    const next = computeWheelZoom(current, { x: 50, y: 50 }, -100)
    expect(next.zoom).toBeGreaterThan(1)
  })

  it('zooms out (decreases scale) for a positive deltaY (scroll down)', () => {
    const current: ZoomPanState = { zoom: 1, position: { x: 0, y: 0 } }
    const next = computeWheelZoom(current, { x: 50, y: 50 }, 100)
    expect(next.zoom).toBeLessThan(1)
  })

  it('never zooms past MAX_ZOOM across repeated wheel-in ticks', () => {
    let state: ZoomPanState = { zoom: 1, position: { x: 0, y: 0 } }
    for (let i = 0; i < 200; i += 1) {
      state = computeWheelZoom(state, { x: 50, y: 50 }, -100)
    }
    expect(state.zoom).toBe(MAX_ZOOM)
  })

  it('never zooms below MIN_ZOOM across repeated wheel-out ticks', () => {
    let state: ZoomPanState = { zoom: 1, position: { x: 0, y: 0 } }
    for (let i = 0; i < 200; i += 1) {
      state = computeWheelZoom(state, { x: 50, y: 50 }, 100)
    }
    expect(state.zoom).toBe(MIN_ZOOM)
  })
})

describe('computePinchZoom', () => {
  it('scales zoom by the distance ratio, anchored at the pinch center', () => {
    const current: ZoomPanState = { zoom: 1, position: { x: 0, y: 0 } }
    const next = computePinchZoom(current, { x: 100, y: 100 }, 2)
    expect(next.zoom).toBe(2)
    // The center stays fixed, same guarantee as computeZoomAtPoint.
    expect(next.position.x + 100 * next.zoom).toBeCloseTo(100)
  })

  it('zooms out when the fingers move closer together (ratio < 1)', () => {
    const current: ZoomPanState = { zoom: 2, position: { x: 0, y: 0 } }
    const next = computePinchZoom(current, { x: 100, y: 100 }, 0.5)
    expect(next.zoom).toBe(1)
  })

  it('clamps pinch zoom into range', () => {
    const current: ZoomPanState = { zoom: 3, position: { x: 0, y: 0 } }
    expect(computePinchZoom(current, { x: 0, y: 0 }, 5).zoom).toBe(MAX_ZOOM)
  })
})

/**
 * `screenToStagePoint` round-trips correctly under a non-trivial
 * scale+pan transform. `screenToStagePoint` itself needs no U11-specific
 * changes (see this unit's doc comment in `coordinates.ts`) — it already
 * inverts whatever transform the stage's `scaleX`/`scaleY`/`x`/`y` happen
 * to carry, which is exactly what U11 starts actually driving. This test
 * confirms that claim rather than testing new behavior.
 */
describe('screenToStagePoint (zoom/pan correctness, U11)', () => {
  function makeFakeStage(scale: number, position: { x: number; y: number }, containerRect = { left: 0, top: 0 }) {
    const transform = new Konva.Transform()
    transform.translate(position.x, position.y)
    transform.scale(scale, scale)
    return {
      container: () => ({
        getBoundingClientRect: () => ({ left: containerRect.left, top: containerRect.top }),
      }),
      getAbsoluteTransform: () => transform,
      // Mirror the real Stage's contract enough for `screenToStagePoint`'s
      // usage: it only ever calls `.container()` and
      // `.getAbsoluteTransform()`.
    } as unknown as Parameters<typeof screenToStagePoint>[0]
  }

  it('round-trips a screen point through a scaled+panned stage back to the correct stage-space point', () => {
    const scale = 2
    const position = { x: -40, y: 25 }
    const stage = makeFakeStage(scale, position)

    // A known stage-space point, forward-transformed to what its screen
    // position would be under this scale+pan (screen = stagePoint * scale + position).
    const stagePoint = { x: 150, y: 80 }
    const screenPoint = {
      x: stagePoint.x * scale + position.x,
      y: stagePoint.y * scale + position.y,
    }

    const result = screenToStagePoint(stage, screenPoint.x, screenPoint.y)
    expect(result.x).toBeCloseTo(stagePoint.x)
    expect(result.y).toBeCloseTo(stagePoint.y)
  })

  it('accounts for the container bounding rect offset in addition to scale/pan', () => {
    const scale = 1.5
    const position = { x: 10, y: 10 }
    const containerRect = { left: 200, top: 100 }
    const stage = makeFakeStage(scale, position, containerRect)

    const stagePoint = { x: 60, y: 40 }
    // clientX/clientY are page-relative; the container itself is offset
    // by containerRect.left/top on the page.
    const clientPoint = {
      x: stagePoint.x * scale + position.x + containerRect.left,
      y: stagePoint.y * scale + position.y + containerRect.top,
    }

    const result = screenToStagePoint(stage, clientPoint.x, clientPoint.y)
    expect(result.x).toBeCloseTo(stagePoint.x)
    expect(result.y).toBeCloseTo(stagePoint.y)
  })

  it('is the identity transform at zoom 1x, no pan', () => {
    const stage = makeFakeStage(1, { x: 0, y: 0 })
    const result = screenToStagePoint(stage, 123, 456)
    expect(result.x).toBeCloseTo(123)
    expect(result.y).toBeCloseTo(456)
  })
})
