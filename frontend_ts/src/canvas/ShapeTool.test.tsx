import { describe, expect, it } from 'vitest'
import { MIN_ITEM_SIZE } from './coordinates'
import { computeShapeGeometry, isShapeTool } from './ShapeTool'

/**
 * `ShapeTool` wires Konva `Stage` pointer events (`pointerdown`/
 * `pointermove`/`pointerup`) to a live-sizing preview and a committed Shape
 * — same jsdom limitation as `SelectionTransformer.test.tsx`: no real
 * `<canvas>` in this project's test environment, so mounting `CanvasStage`
 * and simulating real pointer-drag physics against a Konva `Stage` isn't
 * practical here (consistent with the rest of this codebase — no existing
 * test mounts a Konva component; only pure logic is exercised).
 *
 * What IS automated-tested below, thoroughly:
 *   - `computeShapeGeometry`: the exact snap/normalize/degenerate-drag/
 *     square-constraint/bounds-clamp math that determines the size and
 *     position of a drawn Shape — this is the entire "dragging on canvas
 *     and releasing creates a Shape of the dragged size" and "degenerate
 *     drag" behavior from the plan's test scenarios, and it's fully
 *     Konva-independent.
 *   - `isShapeTool`: the exact `ActiveTool` narrowing that decides whether
 *     `CanvasStage` routes pointer events to drawing vs. its normal
 *     click-to-select behavior.
 *
 * What is NOT automated-tested here, and why:
 *   - That a real `pointerdown`/`pointermove`/`pointerup` sequence on a
 *     mounted `CanvasStage` actually starts/updates/commits a draw, that
 *     the interactive Objects layer actually stops listening while
 *     drawing, or that the live preview actually renders on-screen. These
 *     require a real `<canvas>` element, which jsdom cannot provide. This
 *     was verified by code-reading `CanvasStage.tsx`'s `onPointerDown`/
 *     `onPointerMove`/`onPointerUp` handlers and `Layer listening={
 *     !drawingShape}` against Konva's documented Stage pointer-event API —
 *     the only untested surface is that thin Konva-prop plumbing itself
 *     (reading `event.evt.clientX/Y` and calling the pure functions below),
 *     not any independent decision logic.
 *   - "A newly-created Shape is immediately selectable/resizable via the
 *     same Transformer as catalog Objects" (the plan's third test
 *     scenario): this is true by construction, not new logic to test —
 *     `handleCreateShape` in `CanvasEditorPage.tsx` calls the same
 *     `createItemLocal` action `handleDrop` (U7) uses, appending a
 *     regular `CanvasObject` to the same `items` array `ObjectShape`/
 *     `SelectionTransformer` already render/attach to generically (per
 *     U7's plan note that all 13 types render as a colored rect, and U8's
 *     "applies uniformly to catalog Objects and Shapes" scope). There is
 *     no Shape-specific selection/resize code path for a test to exercise
 *     beyond what `SelectionTransformer.test.tsx` already covers.
 */

describe('isShapeTool', () => {
  it('recognizes all three shape tool types', () => {
    expect(isShapeTool('shape_rectangle')).toBe(true)
    expect(isShapeTool('shape_square')).toBe(true)
    expect(isShapeTool('shape_circle')).toBe(true)
  })

  it('rejects select and line tool types', () => {
    expect(isShapeTool('select')).toBe(false)
    expect(isShapeTool('line_straight')).toBe(false)
    expect(isShapeTool('line_curved')).toBe(false)
    expect(isShapeTool('line_s_curve')).toBe(false)
  })
})

describe('computeShapeGeometry', () => {
  it('happy path: a rectangle dragged top-left to bottom-right produces the dragged size', () => {
    const geometry = computeShapeGeometry(
      'shape_rectangle',
      { x: 100, y: 100 },
      { x: 300, y: 200 },
      10,
      1600,
      1200,
    )
    expect(geometry).toEqual({ x: 100, y: 100, width: 200, height: 100 })
  })

  it('normalizes a drag in any direction (bottom-right to top-left) into a top-left x/y', () => {
    const geometry = computeShapeGeometry(
      'shape_rectangle',
      { x: 300, y: 200 },
      { x: 100, y: 100 },
      10,
      1600,
      1200,
    )
    expect(geometry).toEqual({ x: 100, y: 100, width: 200, height: 100 })
  })

  it('snaps both corners to the grid before computing size', () => {
    const geometry = computeShapeGeometry(
      'shape_rectangle',
      { x: 103, y: 97 }, // snaps to 100, 100 at gridSize 10
      { x: 288, y: 213 }, // snaps to 290, 210 at gridSize 10
      10,
      1600,
      1200,
    )
    expect(geometry).toEqual({ x: 100, y: 100, width: 190, height: 110 })
  })

  it('degenerate drag: a zero-movement click is clamped UP to the minimum size, not rejected', () => {
    const geometry = computeShapeGeometry('shape_rectangle', { x: 100, y: 100 }, { x: 100, y: 100 }, 10, 1600, 1200)
    expect(geometry).toEqual({ x: 100, y: 100, width: MIN_ITEM_SIZE, height: MIN_ITEM_SIZE })
  })

  it('degenerate drag: a sub-minimum drag is clamped UP to the minimum size', () => {
    const geometry = computeShapeGeometry('shape_rectangle', { x: 100, y: 100 }, { x: 104, y: 102 }, 1, 1600, 1200)
    expect(geometry.width).toBe(MIN_ITEM_SIZE)
    expect(geometry.height).toBe(MIN_ITEM_SIZE)
  })

  it('a drag already above the minimum size is left unclamped', () => {
    const geometry = computeShapeGeometry('shape_rectangle', { x: 0, y: 0 }, { x: 50, y: 50 }, 1, 1600, 1200)
    expect(geometry.width).toBe(50)
    expect(geometry.height).toBe(50)
  })

  it('shape_square forces equal width/height using the larger dragged dimension', () => {
    const geometry = computeShapeGeometry('shape_square', { x: 0, y: 0 }, { x: 200, y: 80 }, 10, 1600, 1200)
    expect(geometry.width).toBe(200)
    expect(geometry.height).toBe(200)
  })

  it('shape_circle keeps independent width/height (an ellipse bounding box), unlike shape_square', () => {
    const geometry = computeShapeGeometry('shape_circle', { x: 0, y: 0 }, { x: 200, y: 80 }, 10, 1600, 1200)
    expect(geometry).toEqual({ x: 0, y: 0, width: 200, height: 80 })
  })

  it('edge case: a shape dragged past the canvas bounds is clamped back inside', () => {
    const geometry = computeShapeGeometry(
      'shape_rectangle',
      { x: 1550, y: 1150 },
      { x: 1650, y: 1250 },
      10,
      1600,
      1200,
    )
    // width/height (100 x 100) are preserved; only position is clamped so
    // the shape stays fully within [0, 1600] x [0, 1200].
    expect(geometry.width).toBe(100)
    expect(geometry.height).toBe(100)
    expect(geometry.x).toBe(1500)
    expect(geometry.y).toBe(1100)
  })

  it('respects a custom minSize override', () => {
    const geometry = computeShapeGeometry(
      'shape_rectangle',
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      1,
      1600,
      1200,
      25,
    )
    expect(geometry.width).toBe(25)
    expect(geometry.height).toBe(25)
  })
})
