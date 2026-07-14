import { describe, expect, it } from 'vitest'
import { clampToBounds, snapToGrid } from './coordinates'

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
