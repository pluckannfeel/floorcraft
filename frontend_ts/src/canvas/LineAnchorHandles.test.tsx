import { describe, expect, it } from 'vitest'
import { anchorDragBoundFunc, updatePointAt } from './LineAnchorHandles'
import type { Point } from './types'

/**
 * `LineAnchorHandles` renders one draggable `Konva.Circle` per Line point
 * and wires `dragBoundFunc`/`onDragMove`/`onDragEnd` to Konva — same jsdom
 * limitation as `SelectionTransformer.test.tsx`/`LineTool.test.tsx`: no real
 * `<canvas>` in this project's test environment, so mounting `CanvasStage`
 * and simulating a real anchor-handle pointer drag isn't practical here
 * (consistent with the rest of this codebase: no existing test mounts a
 * Konva component, only pure logic is exercised).
 *
 * What IS automated-tested below, thoroughly:
 *   - `updatePointAt`: the exact "only the dragged point's coordinates
 *     change, every other point (endpoint or middle) is left untouched"
 *     logic — this is the entire "dragging an endpoint handle vs. a middle
 *     handle both correctly update only that point's coordinates" test
 *     scenario from the plan, and it's fully Konva-independent.
 *   - `anchorDragBoundFunc`: the exact snap-to-grid-then-clamp-to-bounds
 *     decision logic an anchor's `dragBoundFunc` applies during a drag —
 *     this is the "dragging a point handle snaps to grid and clamps within
 *     canvas bounds, same as any other Object drag" scenario, built on the
 *     same `coordinates.ts` `snapToGrid`/`clampToBounds` helpers every
 *     other drag in this codebase already uses and already has its own
 *     dedicated unit tests for.
 *   - `updateLinePoints` (canvasStore.test.ts): "one handle per point,
 *     dragging persists at the store level" and "persisting doesn't
 *     disturb other points" are proven at the store layer — the level the
 *     plan explicitly calls out as the honest, testable boundary given no
 *     real backend exists yet (U13 hasn't wired persistence).
 *
 * What is NOT automated-tested here, and why:
 *   - That selecting a Line in a real browser actually renders one visible
 *     `Circle` per point, that dragging a handle actually fires
 *     `onDragMove`/`onDragEnd` with the values Konva computed, or that the
 *     live `Konva.Line` node's `points()` actually update on-screen during
 *     the drag. These require real pointer-drag physics against an actual
 *     `<canvas>` element, which jsdom cannot provide. This was verified by
 *     code-reading `LineAnchorHandles.tsx`'s `dragBoundFunc`/`onDragMove`/
 *     `onDragEnd` wiring against Konva's documented `Circle`/`dragBoundFunc`
 *     React API — the only untested surface is that thin Konva-prop
 *     plumbing itself (reading `node.x()`/`node.y()` and calling the pure
 *     functions above), not any independent decision logic.
 */

describe('updatePointAt', () => {
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 50, y: 50 },
    { x: 100, y: 0 },
  ]

  it('replaces only the point at the given index', () => {
    const next = updatePointAt(points, 1, { x: 999, y: 999 })
    expect(next).toEqual([
      { x: 0, y: 0 },
      { x: 999, y: 999 },
      { x: 100, y: 0 },
    ])
  })

  it('dragging an endpoint (index 0) updates only that point, leaving the rest unchanged', () => {
    const next = updatePointAt(points, 0, { x: -20, y: 5 })
    expect(next[0]).toEqual({ x: -20, y: 5 })
    expect(next[1]).toEqual(points[1])
    expect(next[2]).toEqual(points[2])
  })

  it('dragging the other endpoint (last index) updates only that point', () => {
    const next = updatePointAt(points, points.length - 1, { x: 150, y: 30 })
    expect(next[points.length - 1]).toEqual({ x: 150, y: 30 })
    expect(next[0]).toEqual(points[0])
    expect(next[1]).toEqual(points[1])
  })

  it('dragging a middle handle updates only that point', () => {
    const next = updatePointAt(points, 1, { x: 55, y: 60 })
    expect(next[1]).toEqual({ x: 55, y: 60 })
    expect(next[0]).toEqual(points[0])
    expect(next[2]).toEqual(points[2])
  })

  it('does not mutate the original array', () => {
    const original = [...points]
    updatePointAt(points, 0, { x: 1, y: 1 })
    expect(points).toEqual(original)
  })
})

describe('anchorDragBoundFunc', () => {
  const boundContext = {} as ThisParameterType<ReturnType<typeof anchorDragBoundFunc>>

  it('snaps a dragged position to the nearest grid intersection', () => {
    const bound = anchorDragBoundFunc(20, 1000, 1000)
    const result = bound.call(boundContext, { x: 53, y: 68 })
    expect(result).toEqual({ x: 60, y: 60 })
  })

  it('clamps a snapped position that would fall outside the canvas back within [0, canvasWidth/Height]', () => {
    const bound = anchorDragBoundFunc(20, 100, 100)
    const result = bound.call(boundContext, { x: 500, y: -30 })
    expect(result.x).toBeLessThanOrEqual(100)
    expect(result.x).toBeGreaterThanOrEqual(0)
    expect(result.y).toBeLessThanOrEqual(100)
    expect(result.y).toBeGreaterThanOrEqual(0)
  })

  it('applies snap before clamp (snap-then-clamp order, per coordinates.ts convention)', () => {
    // 95 snaps to 100 (grid 20 -> nearest multiple is 100), which is then
    // clamped back to the 90px canvas bound — proves clamping happens on
    // the already-snapped value, not the raw input.
    const bound = anchorDragBoundFunc(20, 90, 90)
    const result = bound.call(boundContext, { x: 95, y: 95 })
    expect(result).toEqual({ x: 90, y: 90 })
  })

  it('leaves an already-in-bounds, already-snapped point unchanged', () => {
    const bound = anchorDragBoundFunc(10, 500, 500)
    const result = bound.call(boundContext, { x: 40, y: 60 })
    expect(result).toEqual({ x: 40, y: 60 })
  })
})
