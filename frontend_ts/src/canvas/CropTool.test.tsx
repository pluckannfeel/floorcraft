import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  clampCropRegionToCanvas,
  CROP_CLICK_THRESHOLD_PX,
  resolveCropRegion,
  useCropTool,
} from './CropTool'
import type { Point } from './types'

// U8: the crop gesture's pure halves (region resolution) and its state
// machine (useCropTool, via renderHook — the same jsdom-friendly split as
// useMarquee's suite; the Konva/DOM rendering halves are exercised only in
// the running app since jsdom can't mount Konva).

describe('clampCropRegionToCanvas', () => {
  it('passes an in-bounds integer rect through unchanged', () => {
    expect(clampCropRegionToCanvas({ x: 100, y: 80, width: 400, height: 300 }, 1600, 1200)).toEqual(
      { x: 100, y: 80, width: 400, height: 300 },
    )
  })

  it('clamps a rect overhanging the canvas edges to the canvas (crop only trims, never grows)', () => {
    expect(
      clampCropRegionToCanvas({ x: -50, y: -20, width: 2000, height: 2000 }, 1600, 1200),
    ).toEqual({ x: 0, y: 0, width: 1600, height: 1200 })
  })

  it('rounds fractional model coordinates to integers (the backend persists dims as positive ints)', () => {
    expect(
      clampCropRegionToCanvas({ x: 100.4, y: 79.6, width: 400.2, height: 300.3 }, 1600, 1200),
    ).toEqual({ x: 100, y: 80, width: 401, height: 300 })
  })

  it('returns null for a rect entirely outside the canvas', () => {
    expect(clampCropRegionToCanvas({ x: 1700, y: 100, width: 50, height: 50 }, 1600, 1200)).toBeNull()
    expect(clampCropRegionToCanvas({ x: -100, y: -100, width: 50, height: 50 }, 1600, 1200)).toBeNull()
  })

  it('returns null when the clamped region degenerates below 1x1', () => {
    expect(clampCropRegionToCanvas({ x: 100, y: 100, width: 0.2, height: 50 }, 1600, 1200)).toBeNull()
  })
})

describe('resolveCropRegion', () => {
  const base = {
    zoom: 1,
    stagePosition: { x: 0, y: 0 },
    canvasWidth: 1600,
    canvasHeight: 1200,
  }

  it('a sub-threshold movement is a stray click — no region', () => {
    expect(
      resolveCropRegion({
        ...base,
        origin: { x: 100, y: 100 },
        current: { x: 100 + CROP_CLICK_THRESHOLD_PX - 1, y: 100 },
      }),
    ).toBeNull()
  })

  it('converts container-space corners to a model-space region', () => {
    expect(
      resolveCropRegion({ ...base, origin: { x: 100, y: 80 }, current: { x: 500, y: 380 } }),
    ).toEqual({ x: 100, y: 80, width: 400, height: 300 })
  })

  it('normalizes a drag in any direction (up-left drag yields the same region)', () => {
    expect(
      resolveCropRegion({ ...base, origin: { x: 500, y: 380 }, current: { x: 100, y: 80 } }),
    ).toEqual({ x: 100, y: 80, width: 400, height: 300 })
  })

  it('inverts zoom + pan — the region is what the pointer visually covered', () => {
    // Stage at zoom 2 panned to (-100, -100): container (300, 300) is model
    // (200, 200), container (700, 500) is model (400, 300).
    expect(
      resolveCropRegion({
        ...base,
        zoom: 2,
        stagePosition: { x: -100, y: -100 },
        origin: { x: 300, y: 300 },
        current: { x: 700, y: 500 },
      }),
    ).toEqual({ x: 200, y: 200, width: 200, height: 100 })
  })

  it('clamps a drag past the canvas edge to the canvas bounds', () => {
    expect(
      resolveCropRegion({ ...base, origin: { x: 1500, y: 1100 }, current: { x: 1900, y: 1500 } }),
    ).toEqual({ x: 1500, y: 1100, width: 100, height: 100 })
  })
})

describe('useCropTool', () => {
  function setup(overrides: { zoom?: number; stagePosition?: Point } = {}) {
    const onApplyCrop = vi.fn()
    const hook = renderHook(() =>
      useCropTool({
        zoom: overrides.zoom ?? 1,
        stagePosition: overrides.stagePosition ?? { x: 0, y: 0 },
        canvasWidth: 1600,
        canvasHeight: 1200,
        onApplyCrop,
      }),
    )
    return { ...hook, onApplyCrop }
  }

  it('begin → update → release parks the region as PENDING; confirm applies it exactly once', () => {
    const { result, onApplyCrop } = setup()

    act(() => result.current.begin({ x: 100, y: 80 }))
    expect(result.current.isDrawing).toBe(true)
    act(() => result.current.update({ x: 500, y: 380 }))
    act(() => result.current.release())

    expect(result.current.isDrawing).toBe(false)
    expect(result.current.isPending).toBe(true)
    expect(result.current.region).toEqual({ x: 100, y: 80, width: 400, height: 300 })
    expect(onApplyCrop).not.toHaveBeenCalled()

    // Enter / the floating Apply button both land here.
    act(() => result.current.confirm())
    expect(onApplyCrop).toHaveBeenCalledExactlyOnceWith({ x: 100, y: 80, width: 400, height: 300 })
    expect(result.current.isPending).toBe(false)
    expect(result.current.region).toBeNull()

    // A second confirm (stray Enter) is a no-op — the region is consumed.
    act(() => result.current.confirm())
    expect(onApplyCrop).toHaveBeenCalledTimes(1)
  })

  it('cancel (Escape / the Cancel button) discards a PENDING region with no state change anywhere', () => {
    const { result, onApplyCrop } = setup()

    act(() => result.current.begin({ x: 100, y: 80 }))
    act(() => result.current.update({ x: 500, y: 380 }))
    act(() => result.current.release())
    expect(result.current.isPending).toBe(true)

    act(() => result.current.cancel())

    expect(result.current.isPending).toBe(false)
    expect(result.current.region).toBeNull()
    expect(onApplyCrop).not.toHaveBeenCalled()

    // A stray confirm after the cancel must also do nothing.
    act(() => result.current.confirm())
    expect(onApplyCrop).not.toHaveBeenCalled()
  })

  it('cancel mid-DRAW discards the gesture too', () => {
    const { result, onApplyCrop } = setup()

    act(() => result.current.begin({ x: 100, y: 80 }))
    act(() => result.current.update({ x: 500, y: 380 }))
    act(() => result.current.cancel())

    expect(result.current.isDrawing).toBe(false)
    expect(result.current.isPending).toBe(false)
    expect(result.current.region).toBeNull()
    expect(onApplyCrop).not.toHaveBeenCalled()
  })

  it('a sub-threshold release (stray click) produces no pending region', () => {
    const { result } = setup()

    act(() => result.current.begin({ x: 100, y: 100 }))
    act(() => result.current.update({ x: 101, y: 101 }))
    act(() => result.current.release())

    expect(result.current.isDrawing).toBe(false)
    expect(result.current.isPending).toBe(false)
  })

  it('starting a new drag while a region is pending replaces it', () => {
    const { result } = setup()

    act(() => result.current.begin({ x: 100, y: 80 }))
    act(() => result.current.update({ x: 500, y: 380 }))
    act(() => result.current.release())
    expect(result.current.region).toEqual({ x: 100, y: 80, width: 400, height: 300 })

    act(() => result.current.begin({ x: 200, y: 200 }))
    expect(result.current.isPending).toBe(false)
    act(() => result.current.update({ x: 300, y: 320 }))
    act(() => result.current.release())

    expect(result.current.region).toEqual({ x: 200, y: 200, width: 100, height: 120 })
  })

  it('exposes the live model-space region during the drag, converted through zoom + pan', () => {
    const { result } = setup({ zoom: 2, stagePosition: { x: -100, y: -100 } })

    expect(result.current.region).toBeNull()
    act(() => result.current.begin({ x: 300, y: 300 }))
    act(() => result.current.update({ x: 700, y: 500 }))

    expect(result.current.region).toEqual({ x: 200, y: 200, width: 200, height: 100 })
  })
})
