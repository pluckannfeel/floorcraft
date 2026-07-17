import { describe, expect, it } from 'vitest'
import {
  applyAxisSnapToEdge,
  boundingBoxForObject,
  collectGuideStops,
  computeAlignmentSnap,
  edgesForBox,
  findClosestAxisSnap,
  NO_GUIDES,
  snapDragPosition,
  snapResizeBox,
} from './AlignmentGuides'
import type { CanvasObject } from './types'

/**
 * `AlignmentGuides.tsx`'s only Konva-facing surface is `AlignmentGuideLines`
 * (a purely presentational component rendering up to two dashed
 * `Konva.Line`s from already-computed `guides` state — no decisions of its
 * own). Mounting it would require a real `<canvas>`, which jsdom (this
 * project's test environment) doesn't provide — same limitation and same
 * established pattern as `SelectionTransformer.test.tsx` and
 * `ShapeTool.test.tsx`: mount nothing Konva-related, thoroughly test the
 * pure geometry/matching math every Konva prop (`dragBoundFunc`,
 * `boundBoxFunc`) delegates to instead. What's NOT covered here: that a real
 * drag/resize in a browser actually calls these functions with the values
 * Konva computes and actually renders the resulting lines — verified by
 * code-reading `ObjectShape.tsx`'s `dragBoundFunc`/`onDragEnd` and
 * `SelectionTransformer.tsx`'s `boundBoxFunc`/`onTransformEnd`, which do
 * nothing but read node state and call straight into this module's pure
 * functions.
 */

function catalogObject(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 1,
    floor_plan: 1,
    type: 'tables',
    name: 'Table',
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    rotation: 0,
    z_index: 0,
    properties: {},
    ...overrides,
  }
}

function lineObject(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 'line-1',
    floor_plan: 1,
    type: 'line_straight',
    name: 'Wall',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    z_index: 0,
    properties: { points: [] },
    ...overrides,
  }
}

describe('boundingBoxForObject', () => {
  it('derives a catalog Object/Shape bbox from x/y/width/height (unrotated)', () => {
    const object = catalogObject({ x: 10, y: 20, width: 40, height: 30, rotation: 0 })
    expect(boundingBoxForObject(object)).toEqual({ x: 10, y: 20, width: 40, height: 30 })
  })

  it("derives a Line's bbox from properties.points, not width/height", () => {
    const object = lineObject({
      x: 999, // deliberately wrong/stale metadata to prove points win
      y: 999,
      properties: {
        points: [
          { x: 10, y: 50 },
          { x: 100, y: 10 },
          { x: 60, y: 80 },
        ],
      },
    })
    expect(boundingBoxForObject(object)).toEqual({ x: 10, y: 10, width: 90, height: 70 })
  })

  it('falls back to stored x/y with a zero-size box for a Line with fewer than 2 points', () => {
    const object = lineObject({ x: 5, y: 6, properties: { points: [{ x: 1, y: 1 }] } })
    expect(boundingBoxForObject(object)).toEqual({ x: 5, y: 6, width: 0, height: 0 })
  })
})

describe('edgesForBox', () => {
  it('computes start/center/end for the x axis', () => {
    expect(edgesForBox({ x: 10, y: 0, width: 40, height: 20 }, 'x')).toEqual({ start: 10, center: 30, end: 50 })
  })

  it('computes start/center/end for the y axis', () => {
    expect(edgesForBox({ x: 0, y: 5, width: 40, height: 20 }, 'y')).toEqual({ start: 5, center: 15, end: 25 })
  })
})

describe('collectGuideStops', () => {
  it('collects edges/centers from every OTHER object, excluding the given id', () => {
    const a = catalogObject({ id: 1, x: 0, y: 0, width: 40, height: 20 })
    const b = catalogObject({ id: 2, x: 100, y: 50, width: 20, height: 10 })
    const stops = collectGuideStops([a, b], 1)
    // Only b's stops should appear: x start=100, center=110, end=120; y start=50, center=55, end=60.
    expect(stops.x.sort((x, y) => x - y)).toEqual([100, 110, 120])
    expect(stops.y.sort((x, y) => x - y)).toEqual([50, 55, 60])
  })

  it("includes a Line's points-derived bbox as a snap target", () => {
    const wall = lineObject({
      id: 'wall',
      properties: {
        points: [
          { x: 200, y: 0 },
          { x: 200, y: 100 },
        ],
      },
    })
    const stops = collectGuideStops([wall], 'other-id')
    expect(stops.x).toContain(200) // start === end === center for a zero-width vertical line
  })

  // U3: a group drag excludes the WHOLE selection — the dragged member must
  // never snap against a co-moving member's stale store position.
  it('accepts a Set of ids, excluding every member of a multi-selection', () => {
    const a = catalogObject({ id: 1, x: 0, y: 0, width: 40, height: 20 })
    const b = catalogObject({ id: 2, x: 100, y: 50, width: 20, height: 10 })
    const c = catalogObject({ id: 3, x: 300, y: 200, width: 20, height: 10 })

    const stops = collectGuideStops([a, b, c], new Set<CanvasObject['id']>([1, 2]))

    // Only unselected c contributes stops.
    expect(stops.x.sort((x, y) => x - y)).toEqual([300, 310, 320])
    expect(stops.y.sort((x, y) => x - y)).toEqual([200, 205, 210])
  })

  it('an empty Set excludes nothing (every object contributes stops)', () => {
    const a = catalogObject({ id: 1, x: 0, y: 0, width: 40, height: 20 })
    const stops = collectGuideStops([a], new Set())
    expect(stops.x).toHaveLength(3)
  })
})

describe('findClosestAxisSnap', () => {
  it('returns null when nothing is within threshold', () => {
    const box = { x: 0, y: 0, width: 40, height: 20 }
    expect(findClosestAxisSnap(box, 'x', [1000], 5)).toBeNull()
  })

  it('snaps to the closest stop when multiple are within threshold', () => {
    const box = { x: 0, y: 0, width: 40, height: 20 } // x edges: 0, 20, 40
    // Two candidate stops near the box's end edge (40): 42 (diff 2) and 43 (diff 3).
    const snap = findClosestAxisSnap(box, 'x', [43, 42], 5)
    expect(snap).not.toBeNull()
    expect(snap?.guideValue).toBe(42)
    expect(snap?.edge).toBe('end')
    expect(snap?.offset).toBe(2)
  })
})

describe('computeAlignmentSnap (zoom-scaled threshold)', () => {
  it('scales the 5px screen-space threshold by dividing by zoom before comparing model-space coordinates', () => {
    // At 2x zoom, two objects 8 model-units apart are 16 screen px apart —
    // outside a correctly-scaled threshold (5 / 2 = 2.5 model units) even
    // though 8 would be well within a naive raw-model-unit 5px check.
    const other = catalogObject({ id: 2, x: 8, y: 0, width: 40, height: 20 })
    const dragged = { x: 0, y: 0, width: 40, height: 20 }
    const result = computeAlignmentSnap(dragged, [other], 1, 2)
    expect(result.x).toBeNull()
  })

  it('at 0.5x zoom, objects visually aligned within 5 screen px still snap (larger model-space threshold)', () => {
    // At 0.5x zoom, 5 screen px = 10 model units, so an 8-model-unit gap
    // (4 screen px) is within threshold and should snap.
    const other = catalogObject({ id: 2, x: 8, y: 0, width: 40, height: 20 })
    const dragged = { x: 0, y: 0, width: 40, height: 20 }
    const result = computeAlignmentSnap(dragged, [other], 1, 0.5)
    expect(result.x).not.toBeNull()
    expect(result.x?.guideValue).toBe(8) // dragged box's own start (0) matches other's start (8)
  })

  it('at 1x zoom, a gap just inside 5 model units snaps; just outside does not', () => {
    const closeEnough = catalogObject({ id: 2, x: 4, y: 0, width: 40, height: 20 })
    const tooFar = catalogObject({ id: 3, x: 6, y: 0, width: 40, height: 20 })
    const dragged = { x: 0, y: 0, width: 40, height: 20 }

    expect(computeAlignmentSnap(dragged, [closeEnough], 1, 1).x).not.toBeNull()
    expect(computeAlignmentSnap(dragged, [tooFar], 1, 1).x).toBeNull()
  })

  it('applies simultaneous horizontal and vertical snaps to two different objects independently', () => {
    const horizontalTarget = catalogObject({ id: 2, x: 2, y: 500, width: 40, height: 20 })
    const verticalTarget = catalogObject({ id: 3, x: 500, y: 3, width: 40, height: 20 })
    const dragged = { x: 0, y: 0, width: 40, height: 20 }

    const result = computeAlignmentSnap(dragged, [horizontalTarget, verticalTarget], 1, 1)
    expect(result.x).not.toBeNull()
    expect(result.x?.guideValue).toBe(2)
    expect(result.y).not.toBeNull()
    expect(result.y?.guideValue).toBe(3)
  })

  it("a Line's points-derived bbox participates as a snap target", () => {
    const wall = lineObject({
      id: 'wall',
      properties: {
        points: [
          { x: 3, y: 0 },
          { x: 3, y: 200 },
        ],
      },
    })
    const dragged = { x: 0, y: 50, width: 40, height: 20 } // dragged start-x = 0, close to wall's x=3
    const result = computeAlignmentSnap(dragged, [wall], 'dragged-id', 1, 5)
    expect(result.x).not.toBeNull()
    expect(result.x?.guideValue).toBe(3)
  })
})

describe('snapDragPosition (alignment-snap precedence over grid-snap)', () => {
  it("snaps to exact alignment when within threshold and reports the matched guide's coordinate", () => {
    const other = catalogObject({ id: 2, x: 103, y: 200, width: 40, height: 20 })
    // Dragging near x=100 (within 5 of other's start at 103); grid is 25 so
    // a plain grid-snap alone would land on 100, not 103.
    const { point, guides } = snapDragPosition({ x: 100, y: 0 }, 40, 20, [other], 1, 1, 25)
    expect(point.x).toBe(103) // aligned exactly to the other object's left edge
    expect(guides.x).toBe(103)
  })

  it('falls back to grid-snap on an axis with no alignment match', () => {
    const other = catalogObject({ id: 2, x: 900, y: 900, width: 40, height: 20 }) // far away, no match
    const { point, guides } = snapDragPosition({ x: 103, y: 47 }, 40, 20, [other], 1, 1, 25)
    // No alignment match on either axis -> grid-snap (25) applies to both.
    expect(point).toEqual({ x: 100, y: 50 })
    expect(guides).toEqual(NO_GUIDES)
  })

  it('does not snap when no other object is within threshold on any axis', () => {
    const other = catalogObject({ id: 2, x: 500, y: 500, width: 10, height: 10 })
    const { guides } = snapDragPosition({ x: 0, y: 0 }, 40, 20, [other], 1, 1, 25)
    expect(guides).toEqual(NO_GUIDES)
  })
})

describe('applyAxisSnapToEdge (resize edge handling)', () => {
  it('moving the start edge to the guide shrinks/grows size to keep the opposite edge fixed', () => {
    // Box start=10, size=30 (end=40). Snap the start edge to 12 (offset +2).
    const result = applyAxisSnapToEdge(10, 30, { edge: 'start', guideValue: 12, offset: 2 })
    expect(result).toEqual({ start: 12, size: 28 }) // end stays at 40
  })

  it('moving the end edge to the guide keeps start fixed and adjusts size to absorb the delta', () => {
    // Box start=10, size=30 (end=40). Snap the end edge to 45 (offset +5).
    const result = applyAxisSnapToEdge(10, 30, { edge: 'end', guideValue: 45, offset: 5 })
    expect(result).toEqual({ start: 10, size: 35 })
  })

  it('centering on the guide keeps size fixed and shifts start', () => {
    const result = applyAxisSnapToEdge(10, 30, { edge: 'center', guideValue: 28, offset: 3 })
    expect(result).toEqual({ start: 13, size: 30 })
  })
})

describe('snapResizeBox', () => {
  it('adjusts the resized box to align its closest edge with another object, per axis', () => {
    // `other`'s y is far away so only its x edges (0, 50, 100) are in play —
    // isolates this to an x-only snap.
    const other = catalogObject({ id: 2, x: 0, y: 900, width: 100, height: 100 })
    // Resizing so the box's right edge (newBox.x + newBox.width = 20 + 78 =
    // 98) is close to other's right edge (100); its start (20) and center
    // (59) are both further from any of other's x stops than 2, so 'end' is
    // the unambiguous closest match.
    const newBox = { x: 20, y: 0, width: 78, height: 50, rotation: 0 }
    const { box, guides } = snapResizeBox(newBox, [other], 1, 1, 5)
    expect(box.x).toBe(20) // start edge untouched
    expect(box.width).toBe(80) // end edge (98) snapped to other's right edge (100)
    expect(guides.x).toBe(100)
    expect(guides.y).toBeNull()
  })

  it('reports NO_GUIDES when the resized box matches nothing within threshold', () => {
    const other = catalogObject({ id: 2, x: 900, y: 900, width: 10, height: 10 })
    const newBox = { x: 0, y: 0, width: 50, height: 50, rotation: 0 }
    const { guides } = snapResizeBox(newBox, [other], 1, 1, 5)
    expect(guides).toEqual(NO_GUIDES)
  })
})
