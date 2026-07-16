import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  applyMarqueeSelection,
  MARQUEE_CLICK_THRESHOLD_PX,
  resolveMarqueeCommit,
  selectIdsInRect,
  sortObjectsByZIndex,
  useMarquee,
} from './CanvasStage'
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

/**
 * U2: the marquee's pure hit-test/commit pipeline and gesture hook. Same
 * jsdom limitation as above — no Konva Stage can mount here, so the marquee
 * was built as pure helpers (`selectIdsInRect`, `resolveMarqueeCommit`) plus
 * a Konva-free hook (`useMarquee`, exercised with `renderHook` exactly like
 * `useShapeTool`/`useLineTool`'s suites), and `CanvasStage` itself only
 * plumbs pointer events into them.
 */
describe('selectIdsInRect', () => {
  it('selects exactly the objects the rect covers — 2 of 3 (AE1)', () => {
    const objects = [
      makeObject({ id: 'a', x: 0, y: 0 }),
      makeObject({ id: 'b', x: 100, y: 0 }),
      makeObject({ id: 'c', x: 300, y: 300 }),
    ]

    const hits = selectIdsInRect({ x: -10, y: -10, width: 170, height: 70 }, objects)

    expect(hits).toEqual(['a', 'b'])
  })

  it('selects on intersection, not containment — a rect clipping one corner selects', () => {
    const objects = [makeObject({ id: 'a', x: 0, y: 0, width: 40, height: 40 })]

    // Only overlaps the object's bottom-right 5x5 corner.
    expect(selectIdsInRect({ x: 35, y: 35, width: 100, height: 100 }, objects)).toEqual(['a'])
  })

  it('returns an empty array when the rect covers nothing', () => {
    const objects = [makeObject({ id: 'a', x: 0, y: 0 })]

    expect(selectIdsInRect({ x: 500, y: 500, width: 50, height: 50 }, objects)).toEqual([])
  })

  it("uses the rotated bounding box for rotated objects, not the unrotated footprint", () => {
    // 40x60 at (100, 100) rotated 90deg about its top-left corner: the
    // rotated AABB spans x 40..100, y 100..140 — entirely OUTSIDE the
    // unrotated footprint's x range (100..140).
    const rotated = makeObject({ id: 'r', x: 100, y: 100, width: 40, height: 60, rotation: 90 })
    const probe = { x: 45, y: 105, width: 5, height: 5 }

    expect(selectIdsInRect(probe, [rotated])).toEqual(['r'])
    // The same probe misses the identical object when unrotated — proving
    // the rotation actually participated.
    expect(selectIdsInRect(probe, [makeObject({ id: 'r', x: 100, y: 100, width: 40, height: 60 })])).toEqual([])
  })

  it("derives a LINE's bbox from its points, ignoring stale x/y/width/height metadata", () => {
    const line = makeObject({
      id: 'line',
      type: 'line_straight',
      // Deliberately-stale descriptive metadata far from the real points.
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      properties: {
        points: [
          { x: 300, y: 300 },
          { x: 400, y: 350 },
        ],
      },
    })

    // Over the points → selected.
    expect(selectIdsInRect({ x: 290, y: 290, width: 50, height: 50 }, [line])).toEqual(['line'])
    // Over the stale metadata box → NOT selected.
    expect(selectIdsInRect({ x: 0, y: 0, width: 20, height: 20 }, [line])).toEqual([])
  })
})

describe('applyMarqueeSelection', () => {
  it('replaces the selection with the hits for a plain marquee', () => {
    expect(applyMarqueeSelection(['a'], ['b', 'c'], false)).toEqual(['b', 'c'])
  })

  it('unions with the existing selection for Shift+marquee — stable order, no duplicates', () => {
    expect(applyMarqueeSelection(['a', 'b'], ['b', 'c'], true)).toEqual(['a', 'b', 'c'])
  })

  it('an additive marquee over nothing keeps the selection unchanged', () => {
    expect(applyMarqueeSelection(['a'], [], true)).toEqual(['a'])
  })
})

describe('resolveMarqueeCommit', () => {
  const objects = [
    makeObject({ id: 'a', x: 100, y: 100 }),
    makeObject({ id: 'b', x: 500, y: 500 }),
  ]
  const noTransform = { zoom: 1, stagePosition: { x: 0, y: 0 } }

  it('a sub-threshold movement is a click: plain click on empty canvas clears (U1 behavior preserved)', () => {
    const action = resolveMarqueeCommit({
      ...noTransform,
      origin: { x: 50, y: 50 },
      current: { x: 50 + MARQUEE_CLICK_THRESHOLD_PX - 1, y: 50 },
      objects,
      selectedItemIds: ['a'],
      additive: false,
    })

    expect(action).toEqual({ kind: 'clear' })
  })

  it('a Shift+click (sub-threshold, additive) keeps the selection instead of clearing it', () => {
    const action = resolveMarqueeCommit({
      ...noTransform,
      origin: { x: 50, y: 50 },
      current: { x: 50, y: 50 },
      objects,
      selectedItemIds: ['a'],
      additive: true,
    })

    expect(action).toEqual({ kind: 'keep' })
  })

  it('selects the visually-covered objects under zoom + pan (single conversion boundary)', () => {
    // Stage at zoom 2, panned to (-100, -100): object "a" (model 100..140)
    // renders at screen 100..180. A screen-space marquee 90..190 covers it
    // visually; "b" (model 500..540 → screen 900..980) is far outside.
    const action = resolveMarqueeCommit({
      origin: { x: 90, y: 90 },
      current: { x: 190, y: 190 },
      zoom: 2,
      stagePosition: { x: -100, y: -100 },
      objects,
      selectedItemIds: [],
      additive: false,
    })

    expect(action).toEqual({ kind: 'select', ids: ['a'] })
  })

  it('an additive commit unions the hits with the existing selection', () => {
    const action = resolveMarqueeCommit({
      ...noTransform,
      origin: { x: 90, y: 90 },
      current: { x: 150, y: 150 },
      objects,
      selectedItemIds: ['b'],
      additive: true,
    })

    expect(action).toEqual({ kind: 'select', ids: ['b', 'a'] })
  })
})

describe('useMarquee', () => {
  const objects = [
    makeObject({ id: 'a', x: 0, y: 0 }),
    makeObject({ id: 'b', x: 100, y: 0 }),
    makeObject({ id: 'c', x: 300, y: 300 }),
  ]

  function setup(overrides: { selectedItemIds?: CanvasObject['id'][]; zoom?: number; stagePosition?: { x: number; y: number } } = {}) {
    const onReplaceSelection = vi.fn()
    const onClearSelection = vi.fn()
    const hook = renderHook(() =>
      useMarquee({
        zoom: overrides.zoom ?? 1,
        stagePosition: overrides.stagePosition ?? { x: 0, y: 0 },
        objects,
        selectedItemIds: overrides.selectedItemIds ?? [],
        onReplaceSelection,
        onClearSelection,
      }),
    )
    return { ...hook, onReplaceSelection, onClearSelection }
  }

  it('begin → update → commit replaces the selection with the covered objects (AE1)', () => {
    const { result, onReplaceSelection, onClearSelection } = setup({ selectedItemIds: ['c'] })

    act(() => result.current.begin({ x: 0, y: 0 }))
    expect(result.current.isActive).toBe(true)
    act(() => result.current.update({ x: 150, y: 60 }))
    act(() => result.current.commit(false))

    expect(onReplaceSelection).toHaveBeenCalledExactlyOnceWith(['a', 'b'])
    expect(onClearSelection).not.toHaveBeenCalled()
    expect(result.current.isActive).toBe(false)
  })

  it('Shift+commit adds the covered objects to the existing selection', () => {
    const { result, onReplaceSelection } = setup({ selectedItemIds: ['c'] })

    act(() => result.current.begin({ x: 0, y: 0 }))
    act(() => result.current.update({ x: 150, y: 60 }))
    act(() => result.current.commit(true))

    expect(onReplaceSelection).toHaveBeenCalledExactlyOnceWith(['c', 'a', 'b'])
  })

  it('a zero-movement commit clears the selection (regression: click empty canvas still clears)', () => {
    const { result, onReplaceSelection, onClearSelection } = setup({ selectedItemIds: ['a'] })

    act(() => result.current.begin({ x: 500, y: 500 }))
    act(() => result.current.commit(false))

    expect(onClearSelection).toHaveBeenCalledOnce()
    expect(onReplaceSelection).not.toHaveBeenCalled()
  })

  it('cancel (Escape mid-marquee) discards the gesture without touching the selection', () => {
    const { result, onReplaceSelection, onClearSelection } = setup({ selectedItemIds: ['c'] })

    act(() => result.current.begin({ x: 0, y: 0 }))
    act(() => result.current.update({ x: 150, y: 60 }))
    act(() => result.current.cancel())

    expect(result.current.isActive).toBe(false)
    expect(onReplaceSelection).not.toHaveBeenCalled()
    expect(onClearSelection).not.toHaveBeenCalled()

    // A stray pointerup after the cancel must also do nothing.
    act(() => result.current.commit(false))
    expect(onReplaceSelection).not.toHaveBeenCalled()
    expect(onClearSelection).not.toHaveBeenCalled()
  })

  it('exposes the model-space rect for rendering, converted through zoom + pan', () => {
    const { result } = setup({ zoom: 2, stagePosition: { x: -100, y: -100 } })

    expect(result.current.rect).toBeNull()
    act(() => result.current.begin({ x: 100, y: 100 }))
    act(() => result.current.update({ x: 200, y: 150 }))

    expect(result.current.rect).toEqual({ x: 100, y: 100, width: 50, height: 25 })
  })
})
