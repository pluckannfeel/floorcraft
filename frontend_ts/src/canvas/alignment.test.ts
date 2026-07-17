import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildAlignPatches,
  buildDistributePatches,
  partitionSelectionUnits,
  resolveAlignmentAvailability,
} from './alignment'
import { boundingBoxForObject } from './AlignmentGuides'
import { undo, useCanvasStore } from '../state/canvasStore'
import type { CanvasObject } from './types'

/**
 * U6: pure align/distribute math (see `alignment.ts`'s module doc). Same
 * jsdom convention as every other canvas suite — no Konva mounts, the pure
 * helpers carry the test load. The store-integration cases at the bottom
 * pin the one-history-entry-per-action contract through the real
 * `updateItemsGeometry` + zundo pipeline.
 */

function makeObject(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 'a',
    floor_plan: 1,
    type: 'chairs',
    name: '',
    x: 0,
    y: 0,
    width: 40,
    height: 40,
    rotation: 0,
    z_index: 0,
    properties: {},
    ...overrides,
  }
}

/** Applies geometry patches back onto plain objects (folding `points` into
 * `properties.points` the way `updateItemsGeometry` does) so tests can
 * assert on the RESULTING boxes, not just the raw patch numbers. */
function applyPatches(
  items: CanvasObject[],
  patches: Array<{ id: CanvasObject['id']; patch: Record<string, unknown> }>,
): CanvasObject[] {
  return items.map((item) => {
    const patch = patches.find((entry) => entry.id === item.id)?.patch
    if (!patch) return item
    const { points, ...geometry } = patch
    return {
      ...item,
      ...geometry,
      ...(points !== undefined ? { properties: { ...item.properties, points } } : {}),
    } as CanvasObject
  })
}

describe('partitionSelectionUnits (U6)', () => {
  it('each loose item is its own unit; a group collapses to ONE unit with the union box', () => {
    const items = [
      makeObject({ id: 'g1', x: 0, y: 0, group_key: 'group-1' }),
      makeObject({ id: 'loose', x: 500, y: 500 }),
      makeObject({ id: 'g2', x: 100, y: 60, group_key: 'group-1' }),
    ]

    const units = partitionSelectionUnits(['g1', 'loose', 'g2'], items)

    expect(units).toHaveLength(2)
    // Encounter (items) order: the group appears first (g1 at index 0).
    expect(units[0].members.map((member) => member.id)).toEqual(['g1', 'g2'])
    expect(units[0].box).toEqual({ x: 0, y: 0, width: 140, height: 100 })
    expect(units[1].members.map((member) => member.id)).toEqual(['loose'])
  })

  it('ignores selection ids that match no item (mid-delete race safety)', () => {
    expect(partitionSelectionUnits(['ghost'], [makeObject({ id: 'real' })])).toEqual([])
  })

  it("a LINE unit's box derives from its points, not its descriptive metadata", () => {
    const line = makeObject({
      id: 'line',
      type: 'line_straight',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      properties: { points: [{ x: 300, y: 300 }, { x: 400, y: 350 }] },
    })

    const units = partitionSelectionUnits(['line'], [line])

    expect(units[0].box).toEqual({ x: 300, y: 300, width: 100, height: 50 })
  })

  it('only the SELECTED members of a group form its unit (the selection is the literal operand set)', () => {
    const items = [
      makeObject({ id: 'g1', x: 0, group_key: 'group-1' }),
      makeObject({ id: 'g2', x: 100, group_key: 'group-1' }),
    ]

    const units = partitionSelectionUnits(['g1'], items)

    expect(units).toHaveLength(1)
    expect(units[0].members.map((member) => member.id)).toEqual(['g1'])
    expect(units[0].box.width).toBe(40)
  })
})

describe('buildAlignPatches (U6)', () => {
  it('align-left makes min-x equal across member boxes', () => {
    const items = [
      makeObject({ id: 'a', x: 10, y: 0 }),
      makeObject({ id: 'b', x: 200, y: 100 }),
      makeObject({ id: 'c', x: 500, y: 200 }),
    ]

    const patches = buildAlignPatches('left', ['a', 'b', 'c'], items)
    const aligned = applyPatches(items, patches)

    expect(aligned.map((item) => boundingBoxForObject(item).x)).toEqual([10, 10, 10])
    // 'a' already sits at the collective min-x — no patch for it.
    expect(patches.map((patch) => patch.id)).toEqual(['b', 'c'])
    // Only x moves; y is untouched.
    expect(aligned.map((item) => item.y)).toEqual([0, 100, 200])
  })

  it('a ROTATED member aligns by its rotated bbox edge, not its unrotated x', () => {
    // 40x60 at (100, 100) rotated 90° about its top-left: rotated AABB
    // spans x 40..100 (see coordinates.ts's top-left-pivot convention).
    const items = [
      makeObject({ id: 'plain', x: 10, y: 300 }),
      makeObject({ id: 'rot', x: 100, y: 100, width: 40, height: 60, rotation: 90 }),
    ]

    const patches = buildAlignPatches('left', ['plain', 'rot'], items)

    // Collective min-x is 10 (plain); the rotated bbox's left edge is at
    // 40, so the member translates by -30: stored x 100 → 70 …
    const rotPatch = patches.find((patch) => patch.id === 'rot')?.patch
    expect(rotPatch?.x).toBeCloseTo(70, 10)
    // … which puts its ROTATED bbox's min-x exactly on the collective
    // min-x (the "aligns by the rotated edge" contract).
    const aligned = applyPatches(items, patches)
    const rotBox = boundingBoxForObject(aligned.find((item) => item.id === 'rot')!)
    expect(rotBox.x).toBeCloseTo(10, 10)
  })

  it('align-right aligns every box\'s right edge to the collective max-x', () => {
    const items = [
      makeObject({ id: 'a', x: 0, width: 40 }),
      makeObject({ id: 'b', x: 100, width: 100 }),
      makeObject({ id: 'c', x: 500, width: 20 }),
    ]

    const patches = buildAlignPatches('right', ['a', 'b', 'c'], items)
    const aligned = applyPatches(items, patches)

    expect(
      aligned.map((item) => {
        const box = boundingBoxForObject(item)
        return box.x + box.width
      }),
    ).toEqual([520, 520, 520])
  })

  it('align-centerH centers every box on the collective horizontal center', () => {
    const items = [
      makeObject({ id: 'a', x: 0, width: 40 }), // center 20
      makeObject({ id: 'b', x: 160, width: 40 }), // center 180
    ]

    // Collective box spans 0..200 → center 100.
    const patches = buildAlignPatches('centerH', ['a', 'b'], items)
    const aligned = applyPatches(items, patches)

    expect(aligned.map((item) => item.x + item.width / 2)).toEqual([100, 100])
  })

  it('align-top and align-bottom translate on y only', () => {
    const items = [
      makeObject({ id: 'a', y: 50, height: 40 }),
      makeObject({ id: 'b', x: 100, y: 200, height: 100 }),
    ]

    const top = applyPatches(items, buildAlignPatches('top', ['a', 'b'], items))
    expect(top.map((item) => item.y)).toEqual([50, 50])
    expect(top.map((item) => item.x)).toEqual([0, 100])

    const bottom = applyPatches(items, buildAlignPatches('bottom', ['a', 'b'], items))
    expect(bottom.map((item) => item.y + item.height)).toEqual([300, 300])
  })

  it('align-middleV centers every box on the collective vertical middle', () => {
    const items = [
      makeObject({ id: 'a', y: 0, height: 40 }), // middle 20
      makeObject({ id: 'b', x: 100, y: 100, height: 100 }), // middle 150
    ]

    // Collective spans y 0..200 → middle 100.
    const aligned = applyPatches(items, buildAlignPatches('middleV', ['a', 'b'], items))

    expect(aligned.map((item) => item.y + item.height / 2)).toEqual([100, 100])
  })

  it('a GROUP in the selection moves as ONE box — members keep their relative positions', () => {
    const items = [
      makeObject({ id: 'loose', x: 0, y: 0 }),
      makeObject({ id: 'g1', x: 100, y: 0, group_key: 'group-1' }),
      makeObject({ id: 'g2', x: 200, y: 50, group_key: 'group-1' }),
    ]

    const patches = buildAlignPatches('left', ['loose', 'g1', 'g2'], items)
    const aligned = applyPatches(items, patches)

    const g1 = aligned.find((item) => item.id === 'g1')!
    const g2 = aligned.find((item) => item.id === 'g2')!
    // The group's box (100..240) lands at the collective min-x (0): both
    // members translate by the SAME -100 — rigid, offsets preserved.
    expect(g1.x).toBe(0)
    expect(g2.x).toBe(100)
    expect(g2.x - g1.x).toBe(100)
    expect(g2.y - g1.y).toBe(50)
    // NOT per-member alignment: g2 does not itself sit at min-x.
    expect(g2.x).not.toBe(0)
  })

  it('a LINE member translates via the patch points field, with recomputed bbox metadata', () => {
    const items = [
      makeObject({ id: 'box', x: 0, y: 0 }),
      makeObject({
        id: 'wall',
        type: 'line_straight',
        x: 300,
        y: 300,
        width: 100,
        height: 50,
        properties: { points: [{ x: 300, y: 300 }, { x: 400, y: 350 }], curve_style: 'straight' },
      }),
    ]

    const patches = buildAlignPatches('left', ['box', 'wall'], items)

    const wallPatch = patches.find((patch) => patch.id === 'wall')?.patch
    expect(wallPatch?.points).toEqual([
      { x: 0, y: 300 },
      { x: 100, y: 350 },
    ])
    expect(wallPatch).toMatchObject({ x: 0, y: 300, width: 100, height: 50 })
    // The line never gets a bare x/y translation on top of the points —
    // its patch is points + metadata only (U3's ItemGeometryPatch shape).
  })

  it('returns [] when nothing needs to move (single unit, or already aligned) — no history entry', () => {
    const single = [makeObject({ id: 'only', x: 50 })]
    expect(buildAlignPatches('left', ['only'], single)).toEqual([])

    const aligned = [makeObject({ id: 'a', x: 10 }), makeObject({ id: 'b', x: 10, y: 100 })]
    expect(buildAlignPatches('left', ['a', 'b'], aligned)).toEqual([])
  })

  it('a whole single GROUP is one box — aligning it alone is a no-op', () => {
    const items = [
      makeObject({ id: 'g1', x: 100, group_key: 'group-1' }),
      makeObject({ id: 'g2', x: 200, group_key: 'group-1' }),
    ]

    expect(buildAlignPatches('left', ['g1', 'g2'], items)).toEqual([])
  })
})

describe('buildDistributePatches (U6)', () => {
  it('distribute-h yields equal center gaps; the extreme boxes stay put', () => {
    const items = [
      makeObject({ id: 'a', x: 0 }), // center 20
      makeObject({ id: 'b', x: 100 }), // center 120
      makeObject({ id: 'c', x: 300 }), // center 320
    ]

    const patches = buildDistributePatches('horizontal', ['a', 'b', 'c'], items)

    // Extremes contribute no patches; only the middle box moves.
    expect(patches.map((patch) => patch.id)).toEqual(['b'])
    const distributed = applyPatches(items, patches)
    const centers = distributed
      .map((item) => item.x + item.width / 2)
      .sort((left, right) => left - right)
    expect(centers[1] - centers[0]).toBe(150)
    expect(centers[2] - centers[1]).toBe(150)
  })

  it('distribute-v spaces centers on the y axis, x untouched', () => {
    const items = [
      makeObject({ id: 'a', y: 0 }), // center 20
      makeObject({ id: 'b', x: 77, y: 50 }), // center 70
      makeObject({ id: 'c', y: 400 }), // center 420
    ]

    const patches = buildDistributePatches('vertical', ['a', 'b', 'c'], items)
    const distributed = applyPatches(items, patches)

    const b = distributed.find((item) => item.id === 'b')!
    expect(b.y + b.height / 2).toBe(220) // midpoint of 20 and 420
    expect(b.x).toBe(77)
  })

  it('needs 3+ BOXES: two boxes return [] however it is called', () => {
    const items = [makeObject({ id: 'a' }), makeObject({ id: 'b', x: 500 })]
    expect(buildDistributePatches('horizontal', ['a', 'b'], items)).toEqual([])
  })

  it('2 groups + 1 loose item = 3 boxes — groups move rigidly to distribute their CENTERS', () => {
    const items = [
      // Group 1: box 0..100, center 50.
      makeObject({ id: 'g1a', x: 0, group_key: 'group-1' }),
      makeObject({ id: 'g1b', x: 60, group_key: 'group-1' }),
      // Loose: box 200..240, center 220.
      makeObject({ id: 'loose', x: 200 }),
      // Group 2: box 400..500, center 450.
      makeObject({ id: 'g2a', x: 400, group_key: 'group-2' }),
      makeObject({ id: 'g2b', x: 460, group_key: 'group-2' }),
    ]
    const selection = ['g1a', 'g1b', 'loose', 'g2a', 'g2b']

    const patches = buildDistributePatches('horizontal', selection, items)

    // Extreme boxes are the two groups (centers 50 and 450) — they stay;
    // the loose box's center moves to the midpoint 250 → x 230.
    expect(patches).toEqual([{ id: 'loose', patch: { x: 230, y: 0 } }])
  })

  it('a group of 5 members + 2 loose items = 3 boxes → distribute applies (boxes counted, not items)', () => {
    const items = [
      ...[0, 30, 60, 90, 120].map((x, index) =>
        makeObject({ id: `g${index}`, x, group_key: 'group-1' }),
      ), // group box 0..160, center 80
      makeObject({ id: 'mid', x: 300 }), // center 320
      makeObject({ id: 'far', x: 800 }), // center 820
    ]
    const selection = ['g0', 'g1', 'g2', 'g3', 'g4', 'mid', 'far']

    const patches = buildDistributePatches('horizontal', selection, items)

    // Midpoint of 80 and 820 is 450 → mid's center 320 moves by +130.
    expect(patches).toEqual([{ id: 'mid', patch: { x: 430, y: 0 } }])
  })
})

describe('resolveAlignmentAvailability (U6)', () => {
  it('align needs 2+ selected items; distribute needs 3+ boxes', () => {
    const items = [
      makeObject({ id: 'a' }),
      makeObject({ id: 'b', x: 100 }),
      makeObject({ id: 'c', x: 200 }),
    ]

    expect(resolveAlignmentAvailability([], items)).toMatchObject({
      canAlign: false,
      canDistribute: false,
    })
    expect(resolveAlignmentAvailability(['a'], items)).toMatchObject({
      selectedCount: 1,
      boxCount: 1,
      canAlign: false,
      canDistribute: false,
    })
    expect(resolveAlignmentAvailability(['a', 'b'], items)).toMatchObject({
      canAlign: true,
      canDistribute: false,
    })
    expect(resolveAlignmentAvailability(['a', 'b', 'c'], items)).toMatchObject({
      boxCount: 3,
      canAlign: true,
      canDistribute: true,
    })
  })

  it('ghost selection ids count for nothing', () => {
    expect(resolveAlignmentAvailability(['ghost-1', 'ghost-2'], [makeObject()])).toMatchObject({
      selectedCount: 0,
      boxCount: 0,
      canAlign: false,
      canDistribute: false,
    })
  })

  it('a whole group + a loose item: canAlign (2+ items) but only 2 boxes → no distribute', () => {
    const items = [
      makeObject({ id: 'g1', group_key: 'group-1' }),
      makeObject({ id: 'g2', x: 60, group_key: 'group-1' }),
      makeObject({ id: 'loose', x: 300 }),
    ]

    expect(resolveAlignmentAvailability(['g1', 'g2', 'loose'], items)).toMatchObject({
      selectedCount: 3,
      boxCount: 2,
      canAlign: true,
      canDistribute: false,
    })
  })
})

/**
 * U6 store integration: each align/distribute action commits through ONE
 * `updateItemsGeometry` call — one zundo entry, a single undo reverts the
 * whole action (plan test scenario).
 */
describe('align/distribute history granularity (U6)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemIds: [] })
    useCanvasStore.temporal.getState().clear()
  })

  it('an align over 3 items is ONE history entry — a single undo restores all three', () => {
    const items = [
      makeObject({ id: 'a', x: 10 }),
      makeObject({ id: 'b', x: 200 }),
      makeObject({ id: 'c', x: 500 }),
    ]
    useCanvasStore.setState({ items })
    useCanvasStore.temporal.getState().clear()

    const patches = buildAlignPatches('left', ['a', 'b', 'c'], items)
    useCanvasStore.getState().updateItemsGeometry(patches)

    expect(useCanvasStore.getState().items.map((item) => item.x)).toEqual([10, 10, 10])
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

    undo()
    expect(useCanvasStore.getState().items.map((item) => item.x)).toEqual([10, 200, 500])
  })

  it('a distribute is ONE history entry too', () => {
    const items = [
      makeObject({ id: 'a', x: 0 }),
      makeObject({ id: 'b', x: 100 }),
      makeObject({ id: 'c', x: 300 }),
    ]
    useCanvasStore.setState({ items })
    useCanvasStore.temporal.getState().clear()

    const patches = buildDistributePatches('horizontal', ['a', 'b', 'c'], items)
    useCanvasStore.getState().updateItemsGeometry(patches)

    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
    expect(useCanvasStore.getState().items.find((item) => item.id === 'b')?.x).toBe(150)

    undo()
    expect(useCanvasStore.getState().items.find((item) => item.id === 'b')?.x).toBe(100)
  })
})
