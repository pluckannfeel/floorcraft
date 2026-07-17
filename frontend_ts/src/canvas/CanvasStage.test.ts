import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  applyMarqueeSelection,
  buildGroupDragPatches,
  MARQUEE_CLICK_THRESHOLD_PX,
  resolveGroupDragUpdate,
  resolveMarqueeCommit,
  resolveMemberModeGroupBox,
  selectIdsInRect,
  sortObjectsByZIndex,
  useMarquee,
} from './CanvasStage'
import { expandIdsByGroup } from '../state/canvasStore'
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

/**
 * U3: the group-drag policy pipeline. Same jsdom constraint as everything
 * above — no Konva node can mount here, so the drag gesture was built as
 * two pure functions (`resolveGroupDragUpdate` per dragmove frame,
 * `buildGroupDragPatches` at dragend) that `CanvasStage`'s handlers only
 * plumb node positions into. These tests live here (not coordinates.test.ts,
 * where the plan first pointed) because the composition needs
 * `AlignmentGuides`/`LineTool` helpers that `coordinates.ts` cannot import
 * without a cycle — the delta-clamp/union/translate primitives themselves
 * ARE in coordinates.ts with their own tests.
 */
describe('resolveGroupDragUpdate (U3 group drag)', () => {
  const canvas = { canvasWidth: 800, canvasHeight: 600, zoom: 1, gridSize: 20 }

  function threeSelected() {
    return [
      makeObject({ id: 'a', x: 100, y: 100 }),
      makeObject({ id: 'b', x: 200, y: 150 }),
      makeObject({ id: 'c', x: 300, y: 100 }),
    ]
  }

  it('moves the whole selection by ONE shared delta — relative offsets preserved (AE2)', () => {
    const objects = threeSelected()
    // Dragging "a" 37/23 px (grid 20 would snap, but alignment/grid snap
    // only adjusts the DRAGGED node's target; use a grid-aligned target to
    // isolate the delta math).
    const update = resolveGroupDragUpdate({
      draggedId: 'a',
      nodePosition: { x: 140, y: 120 },
      objects,
      selectedItemIds: ['a', 'b', 'c'],
      ...canvas,
    })

    expect(update).not.toBeNull()
    expect(update?.delta).toEqual({ x: 40, y: 20 })
    expect(update?.draggedPosition).toEqual({ x: 140, y: 120 })
  })

  it('never snaps against a co-moving member, but still snaps against unselected objects', () => {
    // "b" sits 3px off the dragged node's target — inside the 5px snap
    // threshold. Selected: its stale store position must NOT magnet the
    // drag. Unselected: it must.
    const objects = [
      makeObject({ id: 'a', x: 100, y: 100 }),
      makeObject({ id: 'b', x: 143, y: 400 }),
    ]
    const nodePosition = { x: 140, y: 100 }

    const asCoMember = resolveGroupDragUpdate({
      draggedId: 'a',
      nodePosition,
      objects,
      selectedItemIds: ['a', 'b'],
      ...canvas,
    })
    // No alignment match (both selected) → grid-snap fallback (already on
    // the 20-grid), position stays put and no guide renders.
    expect(asCoMember?.draggedPosition).toEqual({ x: 140, y: 100 })
    expect(asCoMember?.guides.x).toBeNull()

    const asBystander = resolveGroupDragUpdate({
      draggedId: 'a',
      nodePosition,
      objects: [...objects, makeObject({ id: 'c', x: 500, y: 500 })],
      selectedItemIds: ['a', 'c'],
      ...canvas,
    })
    // "b" is unselected now → its left edge (143) magnets the drag.
    expect(asBystander?.draggedPosition.x).toBe(143)
    expect(asBystander?.guides.x).toBe(143)
  })

  it('clamps the COLLECTIVE bbox at the canvas edge — relative offsets intact (never per-member)', () => {
    const objects = threeSelected() // collective box spans x 100..340
    // Dragging "a" far right: the delta must stop when the collective box's
    // right edge (c at 300 + 40 wide) hits 800 → max delta x = 460.
    const update = resolveGroupDragUpdate({
      draggedId: 'a',
      nodePosition: { x: 700, y: 100 },
      objects,
      selectedItemIds: ['a', 'b', 'c'],
      ...canvas,
    })

    expect(update?.delta).toEqual({ x: 460, y: 0 })
    // The dragged member stops at 100 + 460 = 560, NOT at its own per-member
    // clamp (800 - 40 = 760) — that difference is the arrangement staying
    // rigid at the edge.
    expect(update?.draggedPosition).toEqual({ x: 560, y: 100 })
  })

  it('a dragged LINE member skips snapping entirely — its node position IS the raw delta (line-only selection)', () => {
    const objects = [
      makeObject({
        id: 'wall-1',
        type: 'line_straight',
        x: 100,
        y: 100,
        width: 100,
        height: 0,
        properties: { points: [{ x: 100, y: 100 }, { x: 200, y: 100 }] },
      }),
      makeObject({
        id: 'wall-2',
        type: 'line_straight',
        x: 100,
        y: 200,
        width: 100,
        height: 0,
        properties: { points: [{ x: 100, y: 200 }, { x: 200, y: 200 }] },
      }),
    ]

    // A dragged Line's node position is its translation offset — an
    // off-grid value must pass through unsnapped (grid is 20).
    const update = resolveGroupDragUpdate({
      draggedId: 'wall-1',
      nodePosition: { x: 33, y: 17 },
      objects,
      selectedItemIds: ['wall-1', 'wall-2'],
      ...canvas,
    })

    expect(update?.delta).toEqual({ x: 33, y: 17 })
    expect(update?.draggedPosition).toEqual({ x: 33, y: 17 })
    expect(update?.guides).toEqual({ x: null, y: null })
  })

  it("clamps a line-only selection's collective points-derived bbox at the canvas edge", () => {
    const objects = [
      makeObject({
        id: 'wall-1',
        type: 'line_straight',
        properties: { points: [{ x: 100, y: 100 }, { x: 200, y: 100 }] },
      }),
      makeObject({
        id: 'wall-2',
        type: 'line_straight',
        properties: { points: [{ x: 150, y: 500 }, { x: 250, y: 500 }] },
      }),
    ]

    // Collective bbox x spans 100..250 → max delta x = 800 - 250 = 550;
    // y spans 100..500 → min delta y = -100.
    const update = resolveGroupDragUpdate({
      draggedId: 'wall-1',
      nodePosition: { x: 9999, y: -9999 },
      objects,
      selectedItemIds: ['wall-1', 'wall-2'],
      ...canvas,
    })

    expect(update?.delta).toEqual({ x: 550, y: -100 })
  })

  it('drops a guide whose snap the collective clamp then overrode (edge not actually aligned)', () => {
    // An unselected snap target sits just past the point where the
    // collective bbox hits the canvas edge: the snap matches, but the clamp
    // pulls the delta back — the guide must not render as if aligned.
    const objects = [
      makeObject({ id: 'a', x: 700, y: 100 }), // collective right edge at 740
      makeObject({ id: 'b', x: 500, y: 100 }),
      makeObject({ id: 'target', x: 763, y: 100 }), // start edge at 763
    ]
    const update = resolveGroupDragUpdate({
      draggedId: 'a',
      nodePosition: { x: 761, y: 100 }, // within 5px of 763 → snap wants 763
      objects,
      selectedItemIds: ['a', 'b'],
      ...canvas,
    })

    // Snap wanted delta x = 63; clamp allows only 800 - 740 = 60.
    expect(update?.delta.x).toBe(60)
    expect(update?.guides.x).toBeNull()
  })

  it('returns null when the dragged id is not in objects (mid-delete race)', () => {
    expect(
      resolveGroupDragUpdate({
        draggedId: 'ghost',
        nodePosition: { x: 0, y: 0 },
        objects: [makeObject({ id: 'a' })],
        selectedItemIds: ['ghost', 'a'],
        ...canvas,
      }),
    ).toBeNull()
  })
})

describe('buildGroupDragPatches (U3 dragend commit)', () => {
  it('patches every selected member by the same delta — one entry per member, boxes via x/y (AE2)', () => {
    const objects = [
      makeObject({ id: 'a', x: 100, y: 100 }),
      makeObject({ id: 'b', x: 200, y: 150 }),
      makeObject({ id: 'c', x: 300, y: 100 }),
      makeObject({ id: 'bystander', x: 400, y: 400 }),
    ]

    const patches = buildGroupDragPatches({ x: 40, y: 20 }, objects, ['a', 'b', 'c'])

    expect(patches).toEqual([
      { id: 'a', patch: { x: 140, y: 120 } },
      { id: 'b', patch: { x: 240, y: 170 } },
      { id: 'c', patch: { x: 340, y: 120 } },
    ])
    // Relative offsets preserved: pairwise distances unchanged.
    expect((patches[1].patch.x ?? 0) - (patches[0].patch.x ?? 0)).toBe(100)
    expect((patches[2].patch.x ?? 0) - (patches[1].patch.x ?? 0)).toBe(100)
  })

  it('a LINE member commits translated points plus recomputed bbox metadata — rendered position equals committed points (no double-offset)', () => {
    const objects = [
      makeObject({ id: 'box', x: 100, y: 100 }),
      makeObject({
        id: 'wall',
        type: 'line_straight',
        x: 0, // stale metadata on purpose — points win
        y: 0,
        width: 0,
        height: 0,
        properties: {
          points: [
            { x: 300, y: 300 },
            { x: 400, y: 350 },
          ],
          curve_style: 'straight',
        },
      }),
    ]

    const patches = buildGroupDragPatches({ x: 10, y: -20 }, objects, ['box', 'wall'])

    const wallPatch = patches.find((patch) => patch.id === 'wall')?.patch
    // The committed points carry the FULL translation themselves — the
    // caller resets the dragged Line node's position offset to zero in the
    // same dragend, so what renders (points at node origin) is exactly what
    // was committed.
    expect(wallPatch?.points).toEqual([
      { x: 310, y: 280 },
      { x: 410, y: 330 },
    ])
    expect(wallPatch).toMatchObject({ x: 310, y: 280, width: 100, height: 50 })
  })

  it('a line-only selection (two walls) group-moves — every line patched by the shared delta', () => {
    const objects = [
      makeObject({
        id: 'wall-1',
        type: 'line_straight',
        properties: { points: [{ x: 100, y: 100 }, { x: 200, y: 100 }] },
      }),
      makeObject({
        id: 'wall-2',
        type: 'line_straight',
        properties: { points: [{ x: 100, y: 200 }, { x: 200, y: 200 }] },
      }),
    ]

    const patches = buildGroupDragPatches({ x: 33, y: 17 }, objects, ['wall-1', 'wall-2'])

    expect(patches).toHaveLength(2)
    expect(patches[0].patch.points).toEqual([{ x: 133, y: 117 }, { x: 233, y: 117 }])
    expect(patches[1].patch.points).toEqual([{ x: 133, y: 217 }, { x: 233, y: 217 }])
    // Relative offset between the two walls preserved.
    expect((patches[1].patch.points?.[0].y ?? 0) - (patches[0].patch.points?.[0].y ?? 0)).toBe(100)
  })

  it('a degenerate 0-point line commits empty points without bbox metadata (no NaN/Infinity)', () => {
    const objects = [
      makeObject({ id: 'empty', type: 'line_straight', properties: { points: [] } }),
      makeObject({ id: 'box', x: 0, y: 0 }),
    ]

    const patches = buildGroupDragPatches({ x: 5, y: 5 }, objects, ['empty', 'box'])

    const emptyPatch = patches.find((patch) => patch.id === 'empty')?.patch
    expect(emptyPatch?.points).toEqual([])
    expect(emptyPatch?.x).toBeUndefined()
  })
})

/**
 * U4: the group-expansion routing. `expandIdsByGroup` (canvasStore.ts) is
 * the ONE shared helper every selection-time expansion goes through — the
 * click/ctrl+click handlers pass a clicked id through it, and
 * `resolveMarqueeCommit` expands its raw hit set with it — so these tests
 * pin both the helper's contract and its marquee integration. Member-mode
 * (double-click) is deliberately just `replaceSelection([memberId])` with
 * NO expansion; its pure surface here is `resolveMemberModeGroupBox`, the
 * dashed group-context outline's geometry.
 */
describe('expandIdsByGroup (U4)', () => {
  const items = [
    makeObject({ id: 'a', group_key: 'group-1' }),
    makeObject({ id: 'loose' }),
    makeObject({ id: 'b', group_key: 'group-1' }),
    makeObject({ id: 'c', group_key: 'group-2' }),
    makeObject({ id: 'nullKey', group_key: null }),
  ]

  it("expands a member id to every id sharing its group_key, in items order (AE3's click-selects-group)", () => {
    expect(expandIdsByGroup(['b'], items)).toEqual(['a', 'b'])
  })

  it('passes ungrouped ids through as themselves (explicit-null and absent keys alike)', () => {
    expect(expandIdsByGroup(['loose'], items)).toEqual(['loose'])
    expect(expandIdsByGroup(['nullKey'], items)).toEqual(['nullKey'])
  })

  it('deduplicates when several members of the same group are in the input', () => {
    expect(expandIdsByGroup(['a', 'b'], items)).toEqual(['a', 'b'])
  })

  it('expands a mixed input — groups expand, loose ids interleave, input order first', () => {
    expect(expandIdsByGroup(['loose', 'c', 'a'], items)).toEqual(['loose', 'c', 'a', 'b'])
  })

  it('keeps unknown ids as-is (mid-delete race safety)', () => {
    expect(expandIdsByGroup(['ghost'], items)).toEqual(['ghost'])
  })

  it('after clearing keys (ungroup), members select individually again (AE3)', () => {
    const ungrouped = items.map((item) => ({ ...item, group_key: null }))
    expect(expandIdsByGroup(['b'], ungrouped)).toEqual(['b'])
  })
})

describe('resolveMarqueeCommit group expansion (U4)', () => {
  it('a marquee touching ONE member selects the WHOLE group', () => {
    const objects = [
      makeObject({ id: 'near', x: 100, y: 100, group_key: 'group-1' }),
      makeObject({ id: 'far', x: 700, y: 700, group_key: 'group-1' }),
      makeObject({ id: 'bystander', x: 400, y: 400 }),
    ]

    // Rect covers only "near" — nowhere close to "far" or "bystander".
    const action = resolveMarqueeCommit({
      origin: { x: 90, y: 90 },
      current: { x: 150, y: 150 },
      zoom: 1,
      stagePosition: { x: 0, y: 0 },
      objects,
      selectedItemIds: [],
      additive: false,
    })

    expect(action).toEqual({ kind: 'select', ids: ['near', 'far'] })
  })
})

describe('resolveMemberModeGroupBox (U4)', () => {
  const grouped = [
    makeObject({ id: 'a', x: 0, y: 0, width: 40, height: 40, group_key: 'group-1' }),
    makeObject({ id: 'b', x: 100, y: 60, width: 40, height: 40, group_key: 'group-1' }),
    makeObject({ id: 'loose', x: 500, y: 500 }),
  ]

  it("returns the WHOLE group's union bbox for a single selected grouped member (member-mode cue)", () => {
    expect(resolveMemberModeGroupBox(['a'], grouped)).toEqual({
      x: 0,
      y: 0,
      width: 140,
      height: 100,
    })
  })

  it('returns null for an ungrouped single selection', () => {
    expect(resolveMemberModeGroupBox(['loose'], grouped)).toBeNull()
  })

  it('returns null for any multi-selection (the transformer border owns that cue)', () => {
    expect(resolveMemberModeGroupBox(['a', 'b'], grouped)).toBeNull()
  })

  it('returns null for an empty selection and for a degenerate one-member group', () => {
    expect(resolveMemberModeGroupBox([], grouped)).toBeNull()
    expect(
      resolveMemberModeGroupBox(['solo'], [makeObject({ id: 'solo', group_key: 'group-lonely' })]),
    ).toBeNull()
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
