import { describe, expect, it } from 'vitest'
import {
  applyNodeTransformToPoints,
  clampGroupDragDelta,
  clampToBounds,
  constrainTransformBox,
  containerToStagePoint,
  getRotatedBoundingBox,
  MIN_ITEM_SIZE,
  rectFromPoints,
  rectsIntersect,
  shouldHandleDeleteKey,
  snapToGrid,
  translatePoints,
  unionBoundingBoxes,
} from './coordinates'

describe('snapToGrid', () => {
  it('rounds to the nearest multiple of gridSize (grid size 20)', () => {
    expect(snapToGrid({ x: 13, y: 27 }, 20)).toEqual({ x: 20, y: 20 })
    expect(snapToGrid({ x: 9, y: 11 }, 20)).toEqual({ x: 0, y: 20 })
  })

  it('rounds to the nearest multiple of gridSize (grid size 10)', () => {
    expect(snapToGrid({ x: 34, y: 36 }, 10)).toEqual({ x: 30, y: 40 })
  })

  it('rounds to the nearest multiple of gridSize (grid size 50)', () => {
    expect(snapToGrid({ x: 124, y: 176 }, 50)).toEqual({ x: 100, y: 200 })
  })

  it('is a no-op for an exact multiple of gridSize', () => {
    expect(snapToGrid({ x: 40, y: 80 }, 20)).toEqual({ x: 40, y: 80 })
  })

  it('leaves the point unchanged for a non-positive gridSize', () => {
    expect(snapToGrid({ x: 13, y: 27 }, 0)).toEqual({ x: 13, y: 27 })
  })
})

describe('clampToBounds', () => {
  it('leaves an in-bounds point unchanged', () => {
    expect(clampToBounds({ x: 100, y: 100 }, 40, 40, 1600, 1200)).toEqual({ x: 100, y: 100 })
  })

  it('clamps a negative point back to 0', () => {
    expect(clampToBounds({ x: -20, y: -5 }, 40, 40, 1600, 1200)).toEqual({ x: 0, y: 0 })
  })

  it('clamps a point past the right/bottom edge so width/height fit within canvas bounds', () => {
    expect(clampToBounds({ x: 1590, y: 1190 }, 40, 40, 1600, 1200)).toEqual({
      x: 1560,
      y: 1160,
    })
  })

  it('clamps to 0 when the object is wider/taller than the canvas', () => {
    expect(clampToBounds({ x: 50, y: 50 }, 2000, 2000, 1600, 1200)).toEqual({ x: 0, y: 0 })
  })

  it('clamps a snapped point that would fall outside bounds back inside (snap-then-clamp)', () => {
    // A point very near the edge snaps to a grid line beyond the canvas
    // boundary; clamping afterward must pull it back in.
    const snapped = snapToGrid({ x: 1595, y: 1195 }, 20)
    expect(snapped).toEqual({ x: 1600, y: 1200 })
    expect(clampToBounds(snapped, 40, 40, 1600, 1200)).toEqual({ x: 1560, y: 1160 })
  })
})

describe('containerToStagePoint', () => {
  it('is the identity at zoom 1 with no pan', () => {
    expect(containerToStagePoint({ x: 120, y: 80 }, 1, { x: 0, y: 0 })).toEqual({ x: 120, y: 80 })
  })

  it('inverts the stage transform under zoom + pan (U2 marquee conversion)', () => {
    // Stage at zoom 2, panned to (-100, -100): the model point (100, 100)
    // renders at screen 100*2 - 100 = 100 — so converting screen (100, 100)
    // back must yield model (100, 100).
    expect(containerToStagePoint({ x: 100, y: 100 }, 2, { x: -100, y: -100 })).toEqual({
      x: 100,
      y: 100,
    })
    expect(containerToStagePoint({ x: 190, y: 40 }, 2, { x: -100, y: -100 })).toEqual({
      x: 145,
      y: 70,
    })
  })

  it('round-trips: stagePoint * zoom + position = containerPoint', () => {
    const zoom = 1.5
    const position = { x: 37, y: -12 }
    const container = { x: 211, y: 93 }
    const stagePoint = containerToStagePoint(container, zoom, position)
    expect(stagePoint.x * zoom + position.x).toBeCloseTo(container.x)
    expect(stagePoint.y * zoom + position.y).toBeCloseTo(container.y)
  })
})

describe('rectFromPoints', () => {
  it('builds the rect from top-left to bottom-right corners', () => {
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 50, y: 80 })).toEqual({
      x: 10,
      y: 20,
      width: 40,
      height: 60,
    })
  })

  it('normalizes reversed corners (dragging up-left) to non-negative width/height', () => {
    expect(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 40,
      height: 60,
    })
  })

  it('yields a zero-size rect when both points coincide (a click, not a drag)', () => {
    expect(rectFromPoints({ x: 33, y: 44 }, { x: 33, y: 44 })).toEqual({
      x: 33,
      y: 44,
      width: 0,
      height: 0,
    })
  })
})

describe('rectsIntersect', () => {
  const base = { x: 100, y: 100, width: 50, height: 50 }

  it('detects a plain overlap', () => {
    expect(rectsIntersect(base, { x: 120, y: 120, width: 100, height: 100 })).toBe(true)
  })

  it('detects a corner-clip overlap (intersection, not containment)', () => {
    expect(rectsIntersect(base, { x: 140, y: 140, width: 10, height: 10 })).toBe(true)
  })

  it('detects full containment in either direction', () => {
    expect(rectsIntersect(base, { x: 110, y: 110, width: 10, height: 10 })).toBe(true)
    expect(rectsIntersect({ x: 110, y: 110, width: 10, height: 10 }, base)).toBe(true)
  })

  it('returns false for disjoint rects on either axis', () => {
    expect(rectsIntersect(base, { x: 200, y: 100, width: 20, height: 20 })).toBe(false)
    expect(rectsIntersect(base, { x: 100, y: 200, width: 20, height: 20 })).toBe(false)
  })

  it('counts touching edges as intersecting (keeps degenerate line bboxes selectable)', () => {
    expect(rectsIntersect(base, { x: 150, y: 100, width: 20, height: 20 })).toBe(true)
    // A perfectly horizontal line's points-derived bbox has height 0 and
    // must still intersect a rect that spans it.
    expect(rectsIntersect({ x: 0, y: 0, width: 200, height: 200 }, { x: 50, y: 120, width: 60, height: 0 })).toBe(true)
  })
})

describe('getRotatedBoundingBox', () => {
  it('returns the rect unchanged at rotation 0', () => {
    expect(getRotatedBoundingBox({ x: 10, y: 20 }, 40, 60, 0)).toEqual({
      x: 10,
      y: 20,
      width: 40,
      height: 60,
    })
  })

  it('computes the axis-aligned bbox of a rect rotated 90deg around its top-left corner', () => {
    // A 40x60 rect rotated 90deg around (10, 20): its top-left corner stays
    // fixed, and the rect now extends in -x/+y from that pivot.
    const bbox = getRotatedBoundingBox({ x: 10, y: 20 }, 40, 60, 90)
    expect(bbox.x).toBeCloseTo(-50)
    expect(bbox.y).toBeCloseTo(20)
    expect(bbox.width).toBeCloseTo(60)
    expect(bbox.height).toBeCloseTo(40)
  })

  it('computes a larger bbox for a 45deg rotation than the unrotated rect', () => {
    const bbox = getRotatedBoundingBox({ x: 0, y: 0 }, 40, 40, 45)
    // A square rotated 45deg has an AABB diagonal-sized: side * sqrt(2).
    expect(bbox.width).toBeCloseTo(40 * Math.SQRT2)
    expect(bbox.height).toBeCloseTo(40 * Math.SQRT2)
  })

  it('returns the rect unchanged at rotation 360 (full turn)', () => {
    const bbox = getRotatedBoundingBox({ x: 5, y: 5 }, 30, 20, 360)
    expect(bbox.x).toBeCloseTo(5)
    expect(bbox.y).toBeCloseTo(5)
    expect(bbox.width).toBeCloseTo(30)
    expect(bbox.height).toBeCloseTo(20)
  })
})

describe('constrainTransformBox', () => {
  const oldBox = { x: 100, y: 100, width: 40, height: 40, rotation: 0 }

  it('passes through an in-bounds, above-minimum-size newBox unchanged', () => {
    const newBox = { x: 100, y: 100, width: 80, height: 60, rotation: 0 }
    expect(constrainTransformBox(oldBox, newBox, 1600, 1200)).toEqual(newBox)
  })

  it('rejects (falls back to oldBox) a resize below the minimum size', () => {
    const newBox = { x: 100, y: 100, width: 5, height: 40, rotation: 0 }
    expect(constrainTransformBox(oldBox, newBox, 1600, 1200)).toBe(oldBox)
  })

  it('accepts a resize exactly at the minimum size', () => {
    const newBox = { x: 100, y: 100, width: MIN_ITEM_SIZE, height: MIN_ITEM_SIZE, rotation: 0 }
    expect(constrainTransformBox(oldBox, newBox, 1600, 1200)).toEqual(newBox)
  })

  it('rejects a resize/move that pushes the (unrotated) bbox past the canvas edge', () => {
    const newBox = { x: 1590, y: 100, width: 40, height: 40, rotation: 0 }
    expect(constrainTransformBox(oldBox, newBox, 1600, 1200)).toBe(oldBox)
  })

  it('rejects a rotation that pushes the rotated bbox out of bounds even though the unrotated box would fit', () => {
    // Near the right edge: unrotated this box fits, but rotating 45deg
    // expands its AABB past canvasWidth.
    const newBox = { x: 1580, y: 100, width: 40, height: 40, rotation: Math.PI / 4 }
    expect(constrainTransformBox(oldBox, newBox, 1600, 1200)).toBe(oldBox)
  })

  it('accepts a rotation whose rotated bbox still fits within bounds', () => {
    const newBox = { x: 700, y: 500, width: 40, height: 40, rotation: Math.PI / 4 }
    expect(constrainTransformBox(oldBox, newBox, 1600, 1200)).toEqual(newBox)
  })

  it('rejects a negative-position newBox (bbox would start outside bounds)', () => {
    const newBox = { x: -10, y: 100, width: 40, height: 40, rotation: 0 }
    expect(constrainTransformBox(oldBox, newBox, 1600, 1200)).toBe(oldBox)
  })

  // U8 (crop): out-of-bounds is a supported state (R22) — when the CURRENT
  // box already violates the bounds, the bounds rejection is skipped so
  // crop-stranded objects don't end up with dead transformer handles.
  describe('already-out-of-bounds boxes (U8 crop relaxation)', () => {
    it('a fully-outside object can still be resized (newBox accepted even though still out of bounds)', () => {
      // A crop-stranded object entirely left/above the canvas origin.
      const strandedBox = { x: -200, y: -150, width: 40, height: 40, rotation: 0 }
      const resized = { x: -200, y: -150, width: 80, height: 60, rotation: 0 }
      expect(constrainTransformBox(strandedBox, resized, 1600, 1200)).toEqual(resized)
    })

    it('a fully-outside object can still be rotated', () => {
      const strandedBox = { x: -200, y: -150, width: 40, height: 40, rotation: 0 }
      const rotated = { x: -200, y: -150, width: 40, height: 40, rotation: Math.PI / 4 }
      expect(constrainTransformBox(strandedBox, rotated, 1600, 1200)).toEqual(rotated)
    })

    it('an overhanging box (partially outside) can still transform', () => {
      // A multi-selection collective box overhanging the left canvas edge.
      const overhanging = { x: -30, y: 100, width: 100, height: 100, rotation: 0 }
      const transformed = { x: -30, y: 100, width: 140, height: 120, rotation: 0 }
      expect(constrainTransformBox(overhanging, transformed, 1600, 1200)).toEqual(transformed)
    })

    it('still enforces the minimum size for an out-of-bounds box', () => {
      const strandedBox = { x: -200, y: -150, width: 40, height: 40, rotation: 0 }
      const tooSmall = { x: -200, y: -150, width: 5, height: 40, rotation: 0 }
      expect(constrainTransformBox(strandedBox, tooSmall, 1600, 1200)).toBe(strandedBox)
    })

    it('in-bounds boxes keep the original rejection (a transform may not NEWLY violate bounds)', () => {
      const inBounds = { x: 100, y: 100, width: 40, height: 40, rotation: 0 }
      const escaping = { x: -10, y: 100, width: 40, height: 40, rotation: 0 }
      expect(constrainTransformBox(inBounds, escaping, 1600, 1200)).toBe(inBounds)
    })
  })
})

// U3: pure group-drag / multi-node transform helpers.
describe('unionBoundingBoxes', () => {
  it('returns the axis-aligned union of several boxes', () => {
    const union = unionBoundingBoxes([
      { x: 10, y: 20, width: 40, height: 40 },
      { x: 100, y: 0, width: 20, height: 10 },
      { x: 30, y: 90, width: 10, height: 30 },
    ])
    expect(union).toEqual({ x: 10, y: 0, width: 110, height: 120 })
  })

  it('a single box unions to itself', () => {
    const box = { x: 5, y: 6, width: 7, height: 8 }
    expect(unionBoundingBoxes([box])).toEqual(box)
  })

  it('returns null for an empty list (distinguishable from a zero-size box at the origin)', () => {
    expect(unionBoundingBoxes([])).toBeNull()
  })
})

describe('clampGroupDragDelta', () => {
  const collectiveBox = { x: 100, y: 50, width: 200, height: 100 }

  it('passes an in-bounds delta through unchanged', () => {
    expect(clampGroupDragDelta({ x: 30, y: -20 }, collectiveBox, 1600, 1200)).toEqual({ x: 30, y: -20 })
  })

  it('clamps the delta so the COLLECTIVE box stops at the left/top edges', () => {
    // Moving (-500, -500) would push the box (at 100, 50) past the origin;
    // the delta stops at exactly (-100, -50), not at each member's own edge.
    expect(clampGroupDragDelta({ x: -500, y: -500 }, collectiveBox, 1600, 1200)).toEqual({ x: -100, y: -50 })
  })

  it('clamps the delta so the collective box stops at the right/bottom edges', () => {
    // Right edge: 1600 - (100 + 200) = 1300 max; bottom: 1200 - (50 + 100) = 1050.
    expect(clampGroupDragDelta({ x: 9999, y: 9999 }, collectiveBox, 1600, 1200)).toEqual({ x: 1300, y: 1050 })
  })

  it('clamps each axis independently', () => {
    expect(clampGroupDragDelta({ x: -500, y: 10 }, collectiveBox, 1600, 1200)).toEqual({ x: -100, y: 10 })
  })

  // U8 (crop): an axis the collective box ALREADY violates is left
  // unclamped — out-of-bounds selections must remain movable (clamping
  // would teleport a stranded selection in, or freeze an oversized one).
  it('leaves an axis unclamped when the collective box already violates it (crop-stranded selection stays movable)', () => {
    // Fully left of the canvas: x violates, y is in bounds.
    const stranded = { x: -300, y: 50, width: 200, height: 100 }
    // Moving further out AND back in are both allowed on x; y clamps
    // normally (top edge at -50).
    expect(clampGroupDragDelta({ x: -40, y: -500 }, stranded, 1600, 1200)).toEqual({ x: -40, y: -50 })
    expect(clampGroupDragDelta({ x: 250, y: 10 }, stranded, 1600, 1200)).toEqual({ x: 250, y: 10 })
  })

  it('an overhanging selection (box past the right edge) still moves on that axis', () => {
    const overhanging = { x: 1500, y: 50, width: 200, height: 100 }
    expect(clampGroupDragDelta({ x: 30, y: 0 }, overhanging, 1600, 1200)).toEqual({ x: 30, y: 0 })
  })

  it('a collective box larger than the canvas moves freely on that axis (it always violates an edge — supersedes the old freeze rule)', () => {
    const oversized = { x: -10, y: 0, width: 2000, height: 50 }
    expect(clampGroupDragDelta({ x: 40, y: 20 }, oversized, 1600, 1200)).toEqual({ x: 40, y: 20 })
  })
})

describe('translatePoints', () => {
  it('rigidly translates every point by the delta', () => {
    expect(
      translatePoints(
        [
          { x: 0, y: 0 },
          { x: 100, y: 50 },
        ],
        { x: 10, y: -5 },
      ),
    ).toEqual([
      { x: 10, y: -5 },
      { x: 110, y: 45 },
    ])
  })

  it('returns a new array and leaves the input untouched', () => {
    const points = [{ x: 1, y: 2 }]
    const translated = translatePoints(points, { x: 3, y: 4 })
    expect(translated).not.toBe(points)
    expect(points).toEqual([{ x: 1, y: 2 }])
  })
})

describe('applyNodeTransformToPoints', () => {
  it('an identity transform returns the points unchanged', () => {
    const points = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]
    expect(
      applyNodeTransformToPoints(points, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }),
    ).toEqual(points)
  })

  it('scales points proportionally about the node origin, then translates (line member of a group resize)', () => {
    // A Line whose node ends a transform at x=5, y=10 with scale (2, 0.5):
    // each point maps to T + S·p.
    const result = applyNodeTransformToPoints(
      [
        { x: 0, y: 0 },
        { x: 100, y: 40 },
      ],
      { x: 5, y: 10, scaleX: 2, scaleY: 0.5, rotation: 0 },
    )
    expect(result).toEqual([
      { x: 5, y: 10 },
      { x: 205, y: 30 },
    ])
    // Proportionality: the segment's dx/dy scaled by exactly (2, 0.5).
    expect(result[1].x - result[0].x).toBe(200)
    expect(result[1].y - result[0].y).toBe(20)
  })

  it('applies rotation AFTER scale (Konva composes translate → rotate → scale)', () => {
    // 90° rotation of a scaled point: (10, 0) · scale(2, 1) = (20, 0), then
    // R(90°) → (0, 20), then translate by (100, 100).
    const [point] = applyNodeTransformToPoints([{ x: 10, y: 0 }], {
      x: 100,
      y: 100,
      scaleX: 2,
      scaleY: 1,
      rotation: 90,
    })
    expect(point.x).toBeCloseTo(100)
    expect(point.y).toBeCloseTo(120)
  })
})

describe('shouldHandleDeleteKey', () => {
  it('returns true for Delete when an item is selected and focus is not in a text field', () => {
    expect(shouldHandleDeleteKey('Delete', ['item-1'], 'DIV')).toBe(true)
  })

  it('returns true for Backspace when an item is selected', () => {
    expect(shouldHandleDeleteKey('Backspace', ['item-1'], undefined)).toBe(true)
  })

  it('returns true for a multi-selection (U1: Delete removes the whole set)', () => {
    expect(shouldHandleDeleteKey('Delete', ['item-1', 'item-2'], 'DIV')).toBe(true)
  })

  it('returns false when the selection is empty', () => {
    expect(shouldHandleDeleteKey('Delete', [], 'DIV')).toBe(false)
  })

  it('returns false for unrelated keys', () => {
    expect(shouldHandleDeleteKey('Enter', ['item-1'], 'DIV')).toBe(false)
  })

  it('returns false while focus is in an input field', () => {
    expect(shouldHandleDeleteKey('Delete', ['item-1'], 'INPUT')).toBe(false)
  })

  it('returns false while focus is in a textarea field', () => {
    expect(shouldHandleDeleteKey('Backspace', ['item-1'], 'textarea')).toBe(false)
  })
})
