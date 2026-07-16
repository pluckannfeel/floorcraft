import { describe, expect, it } from 'vitest'
import { sortObjectsByZIndex } from './CanvasStage'
import type { CanvasObject } from './types'

/**
 * `sortObjectsByZIndex` is the pure function `CanvasStage.tsx` delegates
 * render-order to (U18) — see its doc comment there for why this is tested
 * standalone rather than by mounting a real Konva `<Stage>` (jsdom has no
 * `<canvas>` implementation; this mirrors `SelectionTransformer.test.tsx`'s
 * "test the pure logic a component delegates to" convention).
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

describe('sortObjectsByZIndex', () => {
  it('orders items ascending by z_index (lowest z_index first, so it renders first/underneath)', () => {
    const objects = [
      makeObject({ id: 'top', z_index: 5 }),
      makeObject({ id: 'bottom', z_index: 0 }),
      makeObject({ id: 'middle', z_index: 2 }),
    ]

    const sorted = sortObjectsByZIndex(objects)

    expect(sorted.map((object) => object.id)).toEqual(['bottom', 'middle', 'top'])
  })

  it('a bring-to-front z_index change moves the item to the end of the sorted order', () => {
    // 'a' brought to front: z_index now above 'b'.
    const afterReorder = [makeObject({ id: 'a', z_index: 10 }), makeObject({ id: 'b', z_index: 1 })]

    const sorted = sortObjectsByZIndex(afterReorder)

    expect(sorted.map((object) => object.id)).toEqual(['b', 'a'])
  })

  it('a send-to-back z_index change moves the item to the start of the sorted order', () => {
    const afterReorder = [makeObject({ id: 'a', z_index: 0 }), makeObject({ id: 'b', z_index: -1 })]

    const sorted = sortObjectsByZIndex(afterReorder)

    expect(sorted.map((object) => object.id)).toEqual(['b', 'a'])
  })

  it('breaks ties on equal z_index by id, matching the backend ("z_index", "id") ordering', () => {
    const objects = [
      makeObject({ id: 3, z_index: 0 }),
      makeObject({ id: 1, z_index: 0 }),
      makeObject({ id: 2, z_index: 0 }),
    ]

    const sorted = sortObjectsByZIndex(objects)

    expect(sorted.map((object) => object.id)).toEqual([1, 2, 3])
  })

  it('does not mutate the input array', () => {
    const objects = [makeObject({ id: 'b', z_index: 1 }), makeObject({ id: 'a', z_index: 0 })]
    const original = [...objects]

    sortObjectsByZIndex(objects)

    expect(objects).toEqual(original)
  })

  it('is stable and produces the same order across repeated calls (no reliance on render-order side effects)', () => {
    const objects = [
      makeObject({ id: 'a', z_index: 3 }),
      makeObject({ id: 'b', z_index: 1 }),
      makeObject({ id: 'c', z_index: 2 }),
    ]

    const first = sortObjectsByZIndex(objects).map((object) => object.id)
    const second = sortObjectsByZIndex(objects).map((object) => object.id)

    expect(first).toEqual(second)
  })
})
