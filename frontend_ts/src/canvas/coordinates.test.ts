import { describe, expect, it } from 'vitest'
import {
  clampToBounds,
  constrainTransformBox,
  getRotatedBoundingBox,
  MIN_ITEM_SIZE,
  shouldHandleDeleteKey,
  snapToGrid,
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
})

describe('shouldHandleDeleteKey', () => {
  it('returns true for Delete when an item is selected and focus is not in a text field', () => {
    expect(shouldHandleDeleteKey('Delete', 'item-1', 'DIV')).toBe(true)
  })

  it('returns true for Backspace when an item is selected', () => {
    expect(shouldHandleDeleteKey('Backspace', 'item-1', undefined)).toBe(true)
  })

  it('returns false when no item is selected', () => {
    expect(shouldHandleDeleteKey('Delete', null, 'DIV')).toBe(false)
  })

  it('returns false for unrelated keys', () => {
    expect(shouldHandleDeleteKey('Enter', 'item-1', 'DIV')).toBe(false)
  })

  it('returns false while focus is in an input field', () => {
    expect(shouldHandleDeleteKey('Delete', 'item-1', 'INPUT')).toBe(false)
  })

  it('returns false while focus is in a textarea field', () => {
    expect(shouldHandleDeleteKey('Backspace', 'item-1', 'textarea')).toBe(false)
  })
})
