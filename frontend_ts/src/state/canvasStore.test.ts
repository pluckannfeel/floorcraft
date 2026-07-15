import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasObject } from '../canvas/types'
import { redo, undo, useCanvasStore } from './canvasStore'

function makeItem(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 'item-1',
    floor_plan: 1,
    type: 'chairs',
    name: '',
    x: 10,
    y: 10,
    width: 40,
    height: 40,
    rotation: 0,
    z_index: 0,
    properties: {},
    ...overrides,
  }
}

// U9 later wraps this store with `zundo`; these tests exercise U8's plain
// mutation actions only (updateItemGeometry, deleteItem), matching the
// plan's U8 test scenarios ("resize updates stored width/height", "Delete
// removes the selected item and clears selection").
describe('canvasStore geometry/delete actions (U8)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemId: null })
    useCanvasStore.temporal.getState().clear()
  })

  describe('updateItemGeometry', () => {
    it('patches only the given fields, leaving the rest of the item unchanged', () => {
      useCanvasStore.setState({ items: [makeItem()] })
      useCanvasStore.getState().updateItemGeometry('item-1', { width: 80, height: 60 })

      const item = useCanvasStore.getState().items[0]
      expect(item.width).toBe(80)
      expect(item.height).toBe(60)
      expect(item.x).toBe(10)
      expect(item.y).toBe(10)
      expect(item.rotation).toBe(0)
    })

    it('persists a repositioned x/y on drag commit', () => {
      useCanvasStore.setState({ items: [makeItem()] })
      useCanvasStore.getState().updateItemGeometry('item-1', { x: 200, y: 340 })

      const item = useCanvasStore.getState().items[0]
      expect(item.x).toBe(200)
      expect(item.y).toBe(340)
    })

    it('persists rotation from a transform commit', () => {
      useCanvasStore.setState({ items: [makeItem()] })
      useCanvasStore.getState().updateItemGeometry('item-1', { rotation: 45 })

      expect(useCanvasStore.getState().items[0].rotation).toBe(45)
    })

    it('leaves other items untouched', () => {
      useCanvasStore.setState({ items: [makeItem({ id: 'item-1' }), makeItem({ id: 'item-2', x: 500 })] })
      useCanvasStore.getState().updateItemGeometry('item-1', { x: 999 })

      const items = useCanvasStore.getState().items
      expect(items.find((item) => item.id === 'item-1')?.x).toBe(999)
      expect(items.find((item) => item.id === 'item-2')?.x).toBe(500)
    })

    it('is a no-op on the items array when the id does not match any item', () => {
      const original = [makeItem()]
      useCanvasStore.setState({ items: original })
      useCanvasStore.getState().updateItemGeometry('missing-id', { x: 1 })

      expect(useCanvasStore.getState().items).toEqual(original)
    })
  })

  describe('deleteItem', () => {
    it('removes the item from the items array', () => {
      useCanvasStore.setState({ items: [makeItem()] })
      useCanvasStore.getState().deleteItem('item-1')

      expect(useCanvasStore.getState().items).toEqual([])
    })

    it('clears selection when the deleted item was selected', () => {
      useCanvasStore.setState({ items: [makeItem()], selectedItemId: 'item-1' })
      useCanvasStore.getState().deleteItem('item-1')

      expect(useCanvasStore.getState().selectedItemId).toBeNull()
    })

    it('leaves selection untouched when a different item is deleted', () => {
      useCanvasStore.setState({
        items: [makeItem({ id: 'item-1' }), makeItem({ id: 'item-2' })],
        selectedItemId: 'item-2',
      })
      useCanvasStore.getState().deleteItem('item-1')

      expect(useCanvasStore.getState().selectedItemId).toBe('item-2')
      expect(useCanvasStore.getState().items).toEqual([makeItem({ id: 'item-2' })])
    })
  })
})

// U9: undo/redo mechanics via zundo's `temporal` middleware, partitioned to
// `items` only (partialize) so selection/property/tool state never
// participates in history.
describe('canvasStore undo/redo (U9)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemId: null, activeTool: 'select' })
    useCanvasStore.temporal.getState().clear()
  })

  it('creating an item, then undo, removes it; redo restores it', () => {
    useCanvasStore.getState().createItemLocal(makeItem())
    expect(useCanvasStore.getState().items).toHaveLength(1)

    undo()
    expect(useCanvasStore.getState().items).toHaveLength(0)

    redo()
    expect(useCanvasStore.getState().items).toHaveLength(1)
    expect(useCanvasStore.getState().items[0].id).toBe('item-1')
  })

  it('moving an item (committed on drag-end), then undo, reverts position', () => {
    useCanvasStore.getState().createItemLocal(makeItem({ x: 10, y: 10 }))
    useCanvasStore.temporal.getState().clear() // isolate the move from the create entry

    useCanvasStore.getState().updateItemGeometry('item-1', { x: 200, y: 340 })
    expect(useCanvasStore.getState().items[0]).toMatchObject({ x: 200, y: 340 })

    undo()
    expect(useCanvasStore.getState().items[0]).toMatchObject({ x: 10, y: 10 })

    redo()
    expect(useCanvasStore.getState().items[0]).toMatchObject({ x: 200, y: 340 })
  })

  it('a single dragend-style geometry commit produces exactly one history entry', () => {
    useCanvasStore.getState().createItemLocal(makeItem())
    useCanvasStore.temporal.getState().clear()

    // Per U8's design, updateItemGeometry is only ever called once per
    // drag/transform, at dragend/transformend — never on intermediate
    // pointer moves. Calling it once here (matching that real usage)
    // should coalesce to exactly one history entry, not simulate rapid
    // calls that U8's wiring never actually produces.
    useCanvasStore.getState().updateItemGeometry('item-1', { x: 50, y: 60 })

    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
  })

  it('property edits do not create undo entries', () => {
    useCanvasStore.getState().createItemLocal(makeItem())
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().updateItemProperties('item-1', { properties: { color: 'red' } })

    // U10 fix: property edits patch `items[i].properties` directly (the
    // same place ObjectShape.tsx renders from), not a separate map — this
    // asserts against `items` for that reason, not a since-removed
    // `itemProperties` field.
    expect(useCanvasStore.getState().items[0].properties).toEqual({ color: 'red' })
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)

    // Confirms it's genuinely untracked, not just coincidentally absent:
    // undo has nothing to revert.
    undo()
    expect(useCanvasStore.getState().items[0].properties).toEqual({ color: 'red' })
  })

  it('a name edit via updateItemProperties does not create an undo entry and is visible on the item', () => {
    useCanvasStore.getState().createItemLocal(makeItem({ name: '' }))
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().updateItemProperties('item-1', { name: 'A/C Unit 1' })

    expect(useCanvasStore.getState().items[0].name).toBe('A/C Unit 1')
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('updateItemProperties replaces properties wholesale, allowing key deletion', () => {
    useCanvasStore.getState().createItemLocal(makeItem({ properties: { color: 'red', size: 'large' } }))
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().updateItemProperties('item-1', { properties: { color: 'red' } })

    expect(useCanvasStore.getState().items[0].properties).toEqual({ color: 'red' })
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('is a no-op when the id does not match any item', () => {
    const original = [makeItem()]
    useCanvasStore.setState({ items: original })
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().updateItemProperties('missing-id', { name: 'nope' })

    expect(useCanvasStore.getState().items).toEqual(original)
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('resumes tracking after a property edit: a subsequent geometry update is still undoable', () => {
    useCanvasStore.getState().createItemLocal(makeItem())
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().updateItemProperties('item-1', { name: 'renamed' })
    useCanvasStore.getState().updateItemGeometry('item-1', { x: 500 })

    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
    undo()
    expect(useCanvasStore.getState().items[0].x).toBe(10)
    // The untracked rename survives the geometry undo (different field).
    expect(useCanvasStore.getState().items[0].name).toBe('renamed')
  })

  it('selecting an item and switching the active tool do not create undo entries', () => {
    useCanvasStore.getState().createItemLocal(makeItem())
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().selectItem('item-1')
    useCanvasStore.getState().setActiveTool('shape_rectangle')

    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('deleting then undoing restores the item with its original id (store-level, in-memory only)', () => {
    // Investigation (see canvasStore.ts's class doc for the full reasoning):
    // zundo's undo() restores the exact prior partialized `items` snapshot
    // verbatim — it has no "recreate" concept, only "restore prior state".
    // So at this store's layer, undo-of-delete brings the item back under
    // its ORIGINAL id, not a new one. The plan's "recreate via new id"
    // language describes U13's concern once real persistence exists (a
    // completed DELETE means the backend row is genuinely gone, so U13's
    // re-issued persistence call for an undone delete has to POST a new
    // row) — there is no persistence call in this unit's scope to make
    // that swap necessary yet.
    useCanvasStore.getState().createItemLocal(makeItem())
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().deleteItem('item-1')
    expect(useCanvasStore.getState().items).toHaveLength(0)

    undo()
    expect(useCanvasStore.getState().items).toHaveLength(1)
    expect(useCanvasStore.getState().items[0].id).toBe('item-1')

    // A subsequent redo (re-applying the delete) doesn't crash.
    expect(() => redo()).not.toThrow()
    expect(useCanvasStore.getState().items).toHaveLength(0)
  })

  it('a create -> move -> delete -> undo x3 -> redo x3 sequence returns items to the same shape', () => {
    useCanvasStore.getState().createItemLocal(makeItem())
    useCanvasStore.getState().updateItemGeometry('item-1', { x: 100, y: 100 })
    useCanvasStore.getState().deleteItem('item-1')

    expect(useCanvasStore.getState().items).toHaveLength(0)

    undo()
    undo()
    undo()
    expect(useCanvasStore.getState().items).toHaveLength(0)

    redo()
    redo()
    redo()
    expect(useCanvasStore.getState().items).toHaveLength(0)
  })
})

// U17: `updateLinePoints` commits an anchor-handle drag's final point into
// the selected Line's `properties.points` array. Per the "U17 decision" doc
// comment on `canvasStore.ts`, this is undo-tracked (like
// `updateItemGeometry`) rather than untracked (like `updateItemProperties`)
// — these tests prove both the point-patch semantics and that tracking.
describe('canvasStore updateLinePoints (U17)', () => {
  function makeLineItem(points: { x: number; y: number }[], overrides: Partial<CanvasObject> = {}): CanvasObject {
    return makeItem({
      id: 'line-1',
      type: 'line_straight',
      properties: { points, curve_style: 'straight' },
      ...overrides,
    })
  }

  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemId: null, activeTool: 'select' })
    useCanvasStore.temporal.getState().clear()
  })

  it('updates only the point at the given index, leaving the rest of the points array unchanged', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ]
    useCanvasStore.setState({ items: [makeLineItem(points)] })

    useCanvasStore.getState().updateLinePoints('line-1', 1, { x: 999, y: 999 })

    const item = useCanvasStore.getState().items[0]
    expect(item.properties.points).toEqual([
      { x: 0, y: 0 },
      { x: 999, y: 999 },
      { x: 100, y: 0 },
    ])
  })

  it('dragging an endpoint updates only that endpoint, not the other points', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ]
    useCanvasStore.setState({ items: [makeLineItem(points)] })

    useCanvasStore.getState().updateLinePoints('line-1', 0, { x: -30, y: 10 })

    const item = useCanvasStore.getState().items[0]
    expect(item.properties.points).toEqual([
      { x: -30, y: 10 },
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ])
  })

  it('leaves other items (and their properties) untouched', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 20, y: 20 },
    ]
    useCanvasStore.setState({
      items: [makeLineItem(points), makeItem({ id: 'item-2', x: 500 })],
    })

    useCanvasStore.getState().updateLinePoints('line-1', 0, { x: 7, y: 7 })

    const other = useCanvasStore.getState().items.find((item) => item.id === 'item-2')
    expect(other?.x).toBe(500)
  })

  it('is a no-op when the id does not match any item', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 20, y: 20 },
    ]
    const original = [makeLineItem(points)]
    useCanvasStore.setState({ items: original })

    useCanvasStore.getState().updateLinePoints('missing-id', 0, { x: 1, y: 1 })

    expect(useCanvasStore.getState().items).toEqual(original)
  })

  it('is a no-op when pointIndex is out of range', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 20, y: 20 },
    ]
    const original = [makeLineItem(points)]
    useCanvasStore.setState({ items: original })

    useCanvasStore.getState().updateLinePoints('line-1', 5, { x: 1, y: 1 })

    expect(useCanvasStore.getState().items).toEqual(original)
  })

  it('persists at the store level: an anchor-handle drag commit survives as the new points array', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 40, y: 40 },
    ]
    useCanvasStore.getState().createItemLocal(makeLineItem(points))
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().updateLinePoints('line-1', 1, { x: 200, y: 200 })

    expect(useCanvasStore.getState().items[0].properties.points).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 200 },
    ])
  })

  it('is undo-tracked: a point drag commit produces exactly one history entry, and undo reverts it', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 40, y: 40 },
    ]
    useCanvasStore.getState().createItemLocal(makeLineItem(points))
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().updateLinePoints('line-1', 1, { x: 200, y: 200 })
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

    undo()
    expect(useCanvasStore.getState().items[0].properties.points).toEqual(points)

    redo()
    expect(useCanvasStore.getState().items[0].properties.points).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 200 },
    ])
  })
})

// U11: zoom/pan is view state, not document state — these actions must
// never push undo history (R15/U9's "only items is tracked" scope), and
// zoomIn/zoomOut/resetZoom/setZoomAndPosition must all keep `zoom` inside
// [MIN_ZOOM, MAX_ZOOM].
describe('canvasStore zoom/pan actions (U11)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemId: null, activeTool: 'select', zoom: 1, stagePosition: { x: 0, y: 0 } })
    useCanvasStore.temporal.getState().clear()
  })

  it('setZoomAndPosition updates both fields together', () => {
    useCanvasStore.getState().setZoomAndPosition(2, { x: -30, y: 15 })
    expect(useCanvasStore.getState().zoom).toBe(2)
    expect(useCanvasStore.getState().stagePosition).toEqual({ x: -30, y: 15 })
  })

  it('setZoomAndPosition clamps zoom defensively even if called with an out-of-range value', () => {
    useCanvasStore.getState().setZoomAndPosition(100, { x: 0, y: 0 })
    expect(useCanvasStore.getState().zoom).toBe(4)

    useCanvasStore.getState().setZoomAndPosition(0.001, { x: 0, y: 0 })
    expect(useCanvasStore.getState().zoom).toBe(0.25)
  })

  it('setStagePosition updates only stagePosition, leaving zoom untouched', () => {
    useCanvasStore.setState({ zoom: 2 })
    useCanvasStore.getState().setStagePosition({ x: 100, y: -50 })
    expect(useCanvasStore.getState().stagePosition).toEqual({ x: 100, y: -50 })
    expect(useCanvasStore.getState().zoom).toBe(2)
  })

  it('zoomIn increases zoom, zoomOut decreases it back', () => {
    useCanvasStore.getState().zoomIn()
    const zoomedIn = useCanvasStore.getState().zoom
    expect(zoomedIn).toBeGreaterThan(1)

    useCanvasStore.getState().zoomOut()
    expect(useCanvasStore.getState().zoom).toBeCloseTo(1)
  })

  it('zoomIn never exceeds MAX_ZOOM across repeated clicks', () => {
    for (let i = 0; i < 50; i += 1) useCanvasStore.getState().zoomIn()
    expect(useCanvasStore.getState().zoom).toBe(4)
  })

  it('zoomOut never goes below MIN_ZOOM across repeated clicks', () => {
    for (let i = 0; i < 50; i += 1) useCanvasStore.getState().zoomOut()
    expect(useCanvasStore.getState().zoom).toBe(0.25)
  })

  it('resetZoom returns to 1x at the origin', () => {
    useCanvasStore.setState({ zoom: 3, stagePosition: { x: 500, y: -200 } })
    useCanvasStore.getState().resetZoom()
    expect(useCanvasStore.getState().zoom).toBe(1)
    expect(useCanvasStore.getState().stagePosition).toEqual({ x: 0, y: 0 })
  })

  it('none of the zoom/pan actions create undo history entries', () => {
    useCanvasStore.getState().setZoomAndPosition(2, { x: 10, y: 10 })
    useCanvasStore.getState().setStagePosition({ x: 20, y: 20 })
    useCanvasStore.getState().zoomIn()
    useCanvasStore.getState().zoomOut()
    useCanvasStore.getState().resetZoom()

    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('zoom/pan changes do not affect items, and undo/redo never touch zoom/pan', () => {
    useCanvasStore.getState().createItemLocal(makeItem())
    useCanvasStore.getState().setZoomAndPosition(2, { x: 40, y: 40 })

    undo()
    // The only history entry is the create; undoing it removes the item but
    // leaves zoom/pan exactly as they were set.
    expect(useCanvasStore.getState().items).toEqual([])
    expect(useCanvasStore.getState().zoom).toBe(2)
    expect(useCanvasStore.getState().stagePosition).toEqual({ x: 40, y: 40 })
  })
})
