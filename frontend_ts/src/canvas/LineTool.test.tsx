import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  computeLineBoundingBox,
  curveStyleForType,
  flattenPoints,
  getEffectiveTension,
  isLineTool,
  parseLinePoints,
  useLineTool,
} from './LineTool'

/**
 * `LineTool` wires Konva `Stage` `onClick`/`onDblClick`/window `Escape`
 * events to a live in-progress-points preview and a committed Line — same
 * jsdom limitation as `ShapeTool.test.tsx`/`SelectionTransformer.test.tsx`:
 * no real `<canvas>` in this project's test environment, so mounting
 * `CanvasStage` and simulating real Konva pointer/click events isn't
 * practical here (consistent with the rest of this codebase — no existing
 * test mounts a Konva component; only pure logic is exercised).
 *
 * What IS automated-tested below, thoroughly:
 *   - `isLineTool`: the exact `ActiveTool`/`ObjectType` narrowing that
 *     decides whether `CanvasStage` routes clicks to line-drawing vs. its
 *     normal click-to-select behavior, and whether `ObjectShape` renders a
 *     Line vs. the generic Rect.
 *   - `useLineTool`: the point-accumulation/finish/discard state machine —
 *     this is the entire "selecting 'curved', clicking 3 points, pressing
 *     Escape creates one Line Object" and "escaping/double-clicking with
 *     zero or one point placed does not create a Line" behavior from the
 *     plan's test scenarios, and it's fully Konva-independent (driven here
 *     via `addPoint`/`finishDraw` calls, standing in for the click/Escape
 *     events `CanvasStage` translates into those calls).
 *   - `getEffectiveTension`: the exact tension math — straight Lines always
 *     0 regardless of point count; curved/S-curve Lines use their preset at
 *     >= 4 points and a capped, reduced value below that.
 *   - `curveStyleForType`/`flattenPoints`/`parseLinePoints`/
 *     `computeLineBoundingBox`: the supporting pure conversions between
 *     `LineType`, `properties.points`, and Konva's flat point format /
 *     the committed Object's bounding-box geometry.
 *
 * What is NOT automated-tested here, and why:
 *   - That a real `click`/`dblclick`/`keydown` sequence on a mounted
 *     `CanvasStage` actually starts/updates/commits a draw, that the
 *     interactive Objects layer actually stops listening while drawing, or
 *     that the live preview actually renders on-screen. These require a
 *     real `<canvas>` element, which jsdom cannot provide. This was
 *     verified by code-reading `CanvasStage.tsx`'s `onClick`/`onDblClick`/
 *     window `keydown` handlers against Konva's documented Stage
 *     click-event API (including the `event.evt.detail >= 2` guard against
 *     a double-click's second `click` adding a spurious extra point before
 *     `onDblClick` finishes the draw) — the only untested surface is that
 *     thin Konva-prop plumbing itself, not any independent decision logic.
 *   - That a finished curved/S-curve Line visually renders as a smoothed
 *     spline on-screen: `getEffectiveTension`'s return value being passed
 *     as `Konva.Line`'s `tension` prop is Konva's own documented behavior
 *     (Context & Research), not new logic this unit adds: verified by
 *     code-reading `ObjectShape.tsx`'s branch, not a rendered-pixel
 *     assertion.
 */

describe('isLineTool', () => {
  it('recognizes all three line tool types', () => {
    expect(isLineTool('line_straight')).toBe(true)
    expect(isLineTool('line_curved')).toBe(true)
    expect(isLineTool('line_s_curve')).toBe(true)
  })

  it('rejects select and shape tool types', () => {
    expect(isLineTool('select')).toBe(false)
    expect(isLineTool('shape_rectangle')).toBe(false)
    expect(isLineTool('shape_square')).toBe(false)
    expect(isLineTool('shape_circle')).toBe(false)
  })
})

describe('getEffectiveTension', () => {
  it('a straight Line always uses tension 0, regardless of point count', () => {
    expect(getEffectiveTension('line_straight', 2)).toBe(0)
    expect(getEffectiveTension('line_straight', 3)).toBe(0)
    expect(getEffectiveTension('line_straight', 10)).toBe(0)
  })

  it('a curved Line with >= 4 points uses the full preset', () => {
    const tension = getEffectiveTension('line_curved', 4)
    expect(tension).toBe(0.4)
    expect(getEffectiveTension('line_curved', 10)).toBe(0.4)
  })

  it('an S-curve Line with >= 4 points uses its (higher) full preset', () => {
    expect(getEffectiveTension('line_s_curve', 4)).toBe(0.8)
    expect(getEffectiveTension('line_s_curve', 10)).toBe(0.8)
  })

  it('a curved Line with only 2-3 points uses the capped/reduced tension, not the full preset', () => {
    const twoPoints = getEffectiveTension('line_curved', 2)
    const threePoints = getEffectiveTension('line_curved', 3)
    expect(twoPoints).toBeLessThan(0.4)
    expect(threePoints).toBeLessThan(0.4)
    expect(twoPoints).toBeGreaterThan(0)
  })

  it('an S-curve Line with only 2-3 points uses the capped/reduced tension, not the full (higher) preset', () => {
    const tension = getEffectiveTension('line_s_curve', 3)
    expect(tension).toBeLessThan(0.8)
    expect(tension).toBeGreaterThan(0)
  })

  it('the reduced cap is the same regardless of curve style, so a sparse S-curve is never spikier than a sparse curved Line', () => {
    expect(getEffectiveTension('line_curved', 2)).toBe(getEffectiveTension('line_s_curve', 2))
  })
})

describe('curveStyleForType', () => {
  it('derives curve_style from the line type by stripping the line_ prefix', () => {
    expect(curveStyleForType('line_straight')).toBe('straight')
    expect(curveStyleForType('line_curved')).toBe('curved')
    expect(curveStyleForType('line_s_curve')).toBe('s_curve')
  })
})

describe('flattenPoints', () => {
  it('flattens an {x, y}[] array into Konva\'s flat [x1, y1, x2, y2, ...] format', () => {
    expect(
      flattenPoints([
        { x: 10, y: 20 },
        { x: 30, y: 40 },
        { x: 50, y: 60 },
      ]),
    ).toEqual([10, 20, 30, 40, 50, 60])
  })

  it('returns an empty array for an empty points list', () => {
    expect(flattenPoints([])).toEqual([])
  })
})

describe('parseLinePoints', () => {
  it('reads a well-formed points array back out of properties', () => {
    const points = parseLinePoints({ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })
    expect(points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }])
  })

  it('returns [] when properties is undefined', () => {
    expect(parseLinePoints(undefined)).toEqual([])
  })

  it('returns [] when properties.points is missing', () => {
    expect(parseLinePoints({})).toEqual([])
  })

  it('returns [] when properties.points is not an array', () => {
    expect(parseLinePoints({ points: 'not-an-array' })).toEqual([])
  })

  it('filters out malformed entries rather than throwing', () => {
    const points = parseLinePoints({
      points: [{ x: 1, y: 2 }, { x: 'bad', y: 2 }, null, { y: 5 }, { x: 7, y: 8 }],
    })
    expect(points).toEqual([{ x: 1, y: 2 }, { x: 7, y: 8 }])
  })
})

describe('computeLineBoundingBox', () => {
  it('computes the axis-aligned bounding box of a set of points', () => {
    const bbox = computeLineBoundingBox([
      { x: 10, y: 50 },
      { x: 30, y: 10 },
      { x: 5, y: 40 },
    ])
    expect(bbox).toEqual({ x: 5, y: 10, width: 25, height: 40 })
  })

  it('a single point produces a zero-size bounding box at that point', () => {
    const bbox = computeLineBoundingBox([{ x: 10, y: 20 }])
    expect(bbox).toEqual({ x: 10, y: 20, width: 0, height: 0 })
  })
})

describe('useLineTool', () => {
  const gridSize = 10
  const canvasWidth = 1600
  const canvasHeight = 1200

  it('happy path: selecting "curved", clicking 3 points, then finishing creates one Line with a 3-point points array and curve type', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useLineTool({ gridSize, canvasWidth, canvasHeight, onCommit }))

    act(() => result.current.addPoint('line_curved', { x: 10, y: 10 }))
    act(() => result.current.addPoint('line_curved', { x: 50, y: 50 }))
    act(() => result.current.addPoint('line_curved', { x: 90, y: 20 }))
    expect(result.current.points).toHaveLength(3)
    expect(result.current.isDrawing).toBe(true)

    act(() => result.current.finishDraw())

    expect(onCommit).toHaveBeenCalledTimes(1)
    const [type, points] = onCommit.mock.calls[0]
    expect(type).toBe('line_curved')
    expect(points).toEqual([
      { x: 10, y: 10 },
      { x: 50, y: 50 },
      { x: 90, y: 20 },
    ])
    expect(result.current.isDrawing).toBe(false)
  })

  it('edge case: finishing with zero points placed does not commit', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useLineTool({ gridSize, canvasWidth, canvasHeight, onCommit }))

    act(() => result.current.finishDraw())

    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.isDrawing).toBe(false)
  })

  it('edge case: finishing with exactly one point placed does not commit', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useLineTool({ gridSize, canvasWidth, canvasHeight, onCommit }))

    act(() => result.current.addPoint('line_straight', { x: 20, y: 20 }))
    expect(result.current.points).toHaveLength(1)

    act(() => result.current.finishDraw())

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('happy path: exactly two points is sufficient to commit', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useLineTool({ gridSize, canvasWidth, canvasHeight, onCommit }))

    act(() => result.current.addPoint('line_straight', { x: 0, y: 0 }))
    act(() => result.current.addPoint('line_straight', { x: 100, y: 0 }))
    act(() => result.current.finishDraw())

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('line_straight', [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ])
  })

  it('snaps each placed point to the grid', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useLineTool({ gridSize: 10, canvasWidth, canvasHeight, onCommit }))

    act(() => result.current.addPoint('line_straight', { x: 13, y: 7 }))
    act(() => result.current.addPoint('line_straight', { x: 88, y: 24 }))

    expect(result.current.points).toEqual([
      { x: 10, y: 10 },
      { x: 90, y: 20 },
    ])
  })

  it('clamps each placed point within canvas bounds', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useLineTool({ gridSize: 10, canvasWidth: 100, canvasHeight: 100, onCommit }),
    )

    act(() => result.current.addPoint('line_straight', { x: -20, y: 500 }))

    expect(result.current.points).toEqual([{ x: 0, y: 100 }])
  })

  it('cancelDraw discards the in-progress draw without committing', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useLineTool({ gridSize, canvasWidth, canvasHeight, onCommit }))

    act(() => result.current.addPoint('line_curved', { x: 10, y: 10 }))
    act(() => result.current.addPoint('line_curved', { x: 20, y: 20 }))
    act(() => result.current.cancelDraw())

    expect(result.current.isDrawing).toBe(false)
    expect(result.current.points).toHaveLength(0)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
