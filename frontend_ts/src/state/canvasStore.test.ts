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
    useCanvasStore.setState({ items: [], selectedItemIds: [] })
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
      useCanvasStore.getState().deleteItems(['item-1'])

      expect(useCanvasStore.getState().items).toEqual([])
    })

    it('drops the deleted item from the selection when it was selected', () => {
      useCanvasStore.setState({ items: [makeItem()], selectedItemIds: ['item-1'] })
      useCanvasStore.getState().deleteItems(['item-1'])

      expect(useCanvasStore.getState().selectedItemIds).toEqual([])
    })

    it('leaves selection untouched when a different item is deleted', () => {
      useCanvasStore.setState({
        items: [makeItem({ id: 'item-1' }), makeItem({ id: 'item-2' })],
        selectedItemIds: ['item-2'],
      })
      useCanvasStore.getState().deleteItems(['item-1'])

      expect(useCanvasStore.getState().selectedItemIds).toEqual(['item-2'])
      expect(useCanvasStore.getState().items).toEqual([makeItem({ id: 'item-2' })])
    })
  })
})

// U9: undo/redo mechanics via zundo's `temporal` middleware, partitioned to
// `items` only (partialize) so selection/property/tool state never
// participates in history.
describe('canvasStore undo/redo (U9)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemIds: [], activeTool: 'select' })
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

  it('selecting items and switching the active tool do not create undo entries', () => {
    useCanvasStore.getState().createItemLocal(makeItem())
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().replaceSelection(['item-1'])
    useCanvasStore.getState().toggleIdsInSelection(['item-2'])
    useCanvasStore.getState().clearSelection()
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

    useCanvasStore.getState().deleteItems(['item-1'])
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
    useCanvasStore.getState().deleteItems(['item-1'])

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

  // Regression test for a real, manually-reported bug: "undo feels one step
  // behind, I have to press it twice" / "redo doesn't work as expected."
  //
  // Root cause: `CanvasEditorPage.tsx` re-runs `setItems(objectsQuery.data)`
  // on every refetch, and every U13 mutation's `onSettled` triggers exactly
  // such a refetch after essentially every user action (drag/resize/delete/
  // etc.). Before the fix, `setItems` was a plain tracked `set()` call, so
  // each of those post-action resyncs pushed a SECOND history entry (on top
  // of the one the actual action had just pushed) and wiped the redo stack
  // (zundo's tracked-set path always clears `futureStates`). One undo() then
  // only unwound the harmless resync entry, leaving the real change in
  // place — a second undo() was needed to actually revert it — and any
  // pending redo was gone after the very next action's resync landed.
  it('a server resync (setItems) after a tracked action does not require a second undo, and does not clear the redo stack', () => {
    useCanvasStore.getState().createItemLocal(makeItem({ x: 10, y: 10 }))
    useCanvasStore.temporal.getState().clear() // isolate the move below from the create entry

    useCanvasStore.getState().updateItemGeometry('item-1', { x: 200, y: 340 })
    expect(useCanvasStore.getState().items[0]).toMatchObject({ x: 200, y: 340 })

    // Simulate the post-mutation refetch resync CanvasEditorPage.tsx performs
    // on every `onSettled` — a brand-new array reference with the same
    // (server-confirmed) contents as what's already in the store.
    useCanvasStore.getState().setItems([...useCanvasStore.getState().items])

    // setItems must not have pushed its own history entry: exactly the one
    // entry from the move above should exist.
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

    // A SINGLE undo() must fully revert the move — not just undo the resync.
    undo()
    expect(useCanvasStore.getState().items[0]).toMatchObject({ x: 10, y: 10 })

    // The redo stack must have survived the resync.
    redo()
    expect(useCanvasStore.getState().items[0]).toMatchObject({ x: 200, y: 340 })
  })

  it('setItems on its own (e.g. the initial load) creates no undo entry and is not itself undoable', () => {
    useCanvasStore.getState().setItems([makeItem()])

    expect(useCanvasStore.getState().items).toHaveLength(1)
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)

    undo()
    // Nothing to undo — the seeded item stays.
    expect(useCanvasStore.getState().items).toHaveLength(1)
  })
})

// U18: `reorderZIndex` sets the selected item's `z_index` to one past the
// current max ('front') or min ('back') among all of `items` — these tests
// prove the ordering semantics and that the action is undo-tracked (per the
// plan's U18 test scenarios and its Key Technical Decisions list, which
// names z-reorder alongside create/move/resize/rotate/delete as undoable).
// Rendering order itself (CanvasStage.tsx sorting `objects` by `z_index`
// then `id`) is exercised in canvas/CanvasStage.test.tsx, not here — this
// store-level suite only covers the local `items` state change.
describe('canvasStore reorderZIndex (U18)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemIds: [], activeTool: 'select' })
    useCanvasStore.temporal.getState().clear()
  })

  it('bringing an item to front sets its z_index above all siblings', () => {
    useCanvasStore.setState({
      items: [
        makeItem({ id: 'a', z_index: 0 }),
        makeItem({ id: 'b', z_index: 5 }),
        makeItem({ id: 'c', z_index: 2 }),
      ],
    })

    useCanvasStore.getState().reorderZIndexItems(['a'], 'front')

    const items = useCanvasStore.getState().items
    const itemA = items.find((item) => item.id === 'a')!
    const siblingZIndexes = items.filter((item) => item.id !== 'a').map((item) => item.z_index)
    expect(itemA.z_index).toBeGreaterThan(Math.max(...siblingZIndexes))
  })

  it('sending an item to back sets its z_index below all siblings', () => {
    useCanvasStore.setState({
      items: [
        makeItem({ id: 'a', z_index: 0 }),
        makeItem({ id: 'b', z_index: 5 }),
        makeItem({ id: 'c', z_index: 2 }),
      ],
    })

    useCanvasStore.getState().reorderZIndexItems(['b'], 'back')

    const items = useCanvasStore.getState().items
    const itemB = items.find((item) => item.id === 'b')!
    const siblingZIndexes = items.filter((item) => item.id !== 'b').map((item) => item.z_index)
    expect(itemB.z_index).toBeLessThan(Math.min(...siblingZIndexes))
  })

  it('leaves every other item, and every other field on the reordered item, unchanged', () => {
    useCanvasStore.setState({
      items: [
        makeItem({ id: 'a', z_index: 0, x: 10, name: 'A' }),
        makeItem({ id: 'b', z_index: 5, x: 20, name: 'B' }),
      ],
    })

    useCanvasStore.getState().reorderZIndexItems(['a'], 'front')

    const items = useCanvasStore.getState().items
    expect(items.find((item) => item.id === 'b')).toEqual(
      expect.objectContaining({ id: 'b', z_index: 5, x: 20, name: 'B' }),
    )
    expect(items.find((item) => item.id === 'a')).toEqual(
      expect.objectContaining({ id: 'a', x: 10, name: 'A' }),
    )
  })

  it('is a no-op when the id does not match any item', () => {
    const original = [makeItem({ id: 'a', z_index: 0 }), makeItem({ id: 'b', z_index: 5 })]
    useCanvasStore.setState({ items: original })
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().reorderZIndexItems(['missing-id'], 'front')

    expect(useCanvasStore.getState().items).toEqual(original)
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('is undoable: bring-to-front can be undone back to the prior z_index', () => {
    useCanvasStore.setState({
      items: [makeItem({ id: 'a', z_index: 0 }), makeItem({ id: 'b', z_index: 5 })],
    })
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().reorderZIndexItems(['a'], 'front')
    expect(useCanvasStore.getState().items.find((item) => item.id === 'a')!.z_index).toBeGreaterThan(5)
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

    undo()
    expect(useCanvasStore.getState().items.find((item) => item.id === 'a')!.z_index).toBe(0)

    redo()
    expect(useCanvasStore.getState().items.find((item) => item.id === 'a')!.z_index).toBeGreaterThan(5)
  })

  it('a single reorder produces exactly one coalesced history entry', () => {
    useCanvasStore.setState({
      items: [makeItem({ id: 'a', z_index: 0 }), makeItem({ id: 'b', z_index: 5 })],
    })
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().reorderZIndexItems(['a'], 'front')

    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
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
    useCanvasStore.setState({ items: [], selectedItemIds: [], activeTool: 'select' })
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
    useCanvasStore.setState({ items: [], selectedItemIds: [], activeTool: 'select', zoom: 1, stagePosition: { x: 0, y: 0 } })
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

describe('canvasStore serverIdMap (explicit save)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ items: [], dirty: false, serverIdMap: {} })
  })

  it('merges a save response id_map', () => {
    useCanvasStore.getState().mergeServerIdMap({ 'local-a': 10 })
    useCanvasStore.getState().mergeServerIdMap({ 'local-b': 20 })

    expect(useCanvasStore.getState().serverIdMap).toEqual({
      'local-a': 10,
      'local-b': 20,
    })
  })

  it('repairs chained entries when a mapped row is recreated (delete -> save -> undo -> save)', () => {
    // Save #1 created row 10 for local-a.
    useCanvasStore.getState().mergeServerIdMap({ 'local-a': 10 })
    // Row 10 was deleted by a later save; a redo resurrected the item and
    // the next save recreated it as row 11, reported as {"10": 11}.
    useCanvasStore.getState().mergeServerIdMap({ '10': 11 })

    // Without chain repair, local-a would still point at dead row 10 and
    // every subsequent save would delete-and-recreate the object forever.
    expect(useCanvasStore.getState().serverIdMap['local-a']).toBe(11)
  })

  it('setItems resets the map (identity re-baselined from the server)', () => {
    useCanvasStore.getState().mergeServerIdMap({ 'local-a': 10 })

    useCanvasStore.getState().setItems([])

    expect(useCanvasStore.getState().serverIdMap).toEqual({})
  })

  // U6 (object-visuals): the established chain-repair scenario, extended
  // with a PROPERTIES-CARRYING object — a placed variant's reference rides
  // `items[].properties` (session-stable server id under
  // `visual_variant_id`), so the delete → save → undo → save cycle must
  // prove BOTH invariants at once: the id mapping keeps repointing at the
  // live row (no duplicate-create churn) AND the properties payload
  // survives every history traversal verbatim. The undo-redo learning is
  // the backdrop: zundo snapshots hold whole items arrays, so as long as
  // nothing rewrites items outside tracked actions — and image-load state
  // NEVER writes the store, by the registry design — the reference in a
  // resurrected snapshot is bit-identical to the one that was saved.
  it('place variant → save → delete → save → undo → save: properties survive intact and the mapped id is chain-repaired', () => {
    useCanvasStore.temporal.getState().clear()
    const placed = makeItem({
      id: 'local-variant',
      type: 'chairs',
      width: 40,
      height: 20, // aspect-fit drop dims (wide 2:1 variant)
      properties: { visual_variant_id: 12 },
    })
    useCanvasStore.getState().createItemLocal(placed)

    // Save #1: the server creates row 10 for the placed variant object.
    useCanvasStore.getState().mergeServerIdMap({ 'local-variant': 10 })

    // Delete + save #2: row 10 is gone server-side (tracked delete).
    useCanvasStore.getState().deleteItems(['local-variant'])
    expect(useCanvasStore.getState().items).toHaveLength(0)

    // Undo resurrects the item FROM THE HISTORY SNAPSHOT — the variant
    // reference (and the aspect-fit geometry) must come back verbatim: the
    // number 12, not a stringified or stripped copy.
    undo()
    const resurrected = useCanvasStore
      .getState()
      .items.find((item) => item.id === 'local-variant')
    expect(resurrected).toBeDefined()
    expect(resurrected?.properties).toEqual({ visual_variant_id: 12 })
    expect(resurrected?.properties.visual_variant_id).toBe(12)
    expect(resurrected).toMatchObject({ width: 40, height: 20 })

    // Save #3 recreates the row as 11 and echoes the stale id ({"10": 11})
    // — chain repair must repoint local-variant at the LIVE row, so the
    // NEXT save's payload translation reuses 11 instead of resurrecting
    // dead row 10 (the delete-and-recreate-forever churn the learning
    // documents).
    useCanvasStore.getState().mergeServerIdMap({ '10': 11 })
    expect(useCanvasStore.getState().serverIdMap['local-variant']).toBe(11)

    // And the whole cycle never disturbed the reference the next save will
    // send verbatim.
    expect(
      useCanvasStore.getState().items.find((item) => item.id === 'local-variant')?.properties,
    ).toEqual({ visual_variant_id: 12 })
  })
})

// U1 (canvas-tools plan): the selection becomes an ordered id array with
// replace/toggle/clear semantics, plus batched multi-item mutations
// (updateItemsGeometry / deleteItems / reorderZIndexItems) that produce ONE
// history entry per gesture, and undo()/redo() pruning of selection ids
// that no longer exist in the restored `items`.
describe('canvasStore selection set + batched mutations (U1)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemIds: [], activeTool: 'select', dirty: false })
    useCanvasStore.temporal.getState().clear()
  })

  describe('selection semantics', () => {
    it('replaceSelection replaces the whole selection, preserving the given order', () => {
      useCanvasStore.getState().replaceSelection(['b', 'a'])
      expect(useCanvasStore.getState().selectedItemIds).toEqual(['b', 'a'])

      useCanvasStore.getState().replaceSelection(['c'])
      expect(useCanvasStore.getState().selectedItemIds).toEqual(['c'])
    })

    it('toggleInSelection appends an unselected id at the end', () => {
      useCanvasStore.getState().replaceSelection(['a'])
      useCanvasStore.getState().toggleIdsInSelection(['b'])

      expect(useCanvasStore.getState().selectedItemIds).toEqual(['a', 'b'])
    })

    it('toggleInSelection removes an already-selected id (AE1 ctrl-click contract)', () => {
      useCanvasStore.getState().replaceSelection(['a', 'b', 'c'])
      useCanvasStore.getState().toggleIdsInSelection(['b'])

      expect(useCanvasStore.getState().selectedItemIds).toEqual(['a', 'c'])
    })

    it('clearSelection empties the selection', () => {
      useCanvasStore.getState().replaceSelection(['a', 'b'])
      useCanvasStore.getState().clearSelection()

      expect(useCanvasStore.getState().selectedItemIds).toEqual([])
    })

    it('selection actions never create undo history entries or set dirty', () => {
      useCanvasStore.getState().replaceSelection(['a'])
      useCanvasStore.getState().toggleIdsInSelection(['b'])
      useCanvasStore.getState().clearSelection()

      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
      expect(useCanvasStore.getState().dirty).toBe(false)
    })

    it('selection is untracked: undo never restores an old selection', () => {
      useCanvasStore.getState().createItemLocal(makeItem({ id: 'a' }))
      useCanvasStore.getState().createItemLocal(makeItem({ id: 'b' }))
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().replaceSelection(['a'])
      useCanvasStore.getState().updateItemGeometry('b', { x: 500 })
      useCanvasStore.getState().replaceSelection(['b'])

      undo() // reverts the move only — both items still exist
      expect(useCanvasStore.getState().selectedItemIds).toEqual(['b'])
    })
  })

  describe('updateItemsGeometry', () => {
    it('moves 3 items in ONE history entry — a single undo restores all three', () => {
      useCanvasStore.setState({
        items: [
          makeItem({ id: 'a', x: 10, y: 10 }),
          makeItem({ id: 'b', x: 20, y: 20 }),
          makeItem({ id: 'c', x: 30, y: 30 }),
        ],
      })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemsGeometry([
        { id: 'a', patch: { x: 110, y: 110 } },
        { id: 'b', patch: { x: 120, y: 120 } },
        { id: 'c', patch: { x: 130, y: 130 } },
      ])

      const moved = useCanvasStore.getState().items
      expect(moved.find((item) => item.id === 'a')).toMatchObject({ x: 110, y: 110 })
      expect(moved.find((item) => item.id === 'b')).toMatchObject({ x: 120, y: 120 })
      expect(moved.find((item) => item.id === 'c')).toMatchObject({ x: 130, y: 130 })
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
      expect(useCanvasStore.getState().dirty).toBe(true)

      undo()
      const restored = useCanvasStore.getState().items
      expect(restored.find((item) => item.id === 'a')).toMatchObject({ x: 10, y: 10 })
      expect(restored.find((item) => item.id === 'b')).toMatchObject({ x: 20, y: 20 })
      expect(restored.find((item) => item.id === 'c')).toMatchObject({ x: 30, y: 30 })
    })

    it('patches only listed items, leaving the rest untouched', () => {
      useCanvasStore.setState({
        items: [makeItem({ id: 'a', x: 10 }), makeItem({ id: 'b', x: 20 })],
      })

      useCanvasStore.getState().updateItemsGeometry([{ id: 'a', patch: { x: 99 } }])

      const items = useCanvasStore.getState().items
      expect(items.find((item) => item.id === 'a')?.x).toBe(99)
      expect(items.find((item) => item.id === 'b')?.x).toBe(20)
    })

    it('is a no-op (no history entry, dirty untouched) when no patch id matches', () => {
      const original = [makeItem({ id: 'a' })]
      useCanvasStore.setState({ items: original })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemsGeometry([{ id: 'missing', patch: { x: 1 } }])

      expect(useCanvasStore.getState().items).toBe(original)
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
      expect(useCanvasStore.getState().dirty).toBe(false)
    })

    it('later patches for the same id merge over earlier ones', () => {
      useCanvasStore.setState({ items: [makeItem({ id: 'a', x: 10, y: 10 })] })
      useCanvasStore.temporal.getState().clear() // isolate from the seed setState

      useCanvasStore.getState().updateItemsGeometry([
        { id: 'a', patch: { x: 50 } },
        { id: 'a', patch: { y: 60 } },
      ])

      expect(useCanvasStore.getState().items[0]).toMatchObject({ x: 50, y: 60 })
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
    })

    // U3: a group gesture over a mixed box+Line selection commits in ONE
    // entry — the Line member's translation rides the same batched action
    // via the patch's `points` (folded into properties.points), so a single
    // undo restores the box's x/y AND the Line's points together.
    it('a points patch replaces properties.points in the same single entry as box patches (U3)', () => {
      const originalPoints = [
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ]
      useCanvasStore.setState({
        items: [
          makeItem({ id: 'box', x: 10, y: 10 }),
          makeItem({
            id: 'wall',
            type: 'line_straight',
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            properties: { points: originalPoints, curve_style: 'straight' },
          }),
        ],
      })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemsGeometry([
        { id: 'box', patch: { x: 30, y: 25 } },
        {
          id: 'wall',
          patch: {
            x: 20,
            y: 15,
            width: 100,
            height: 50,
            points: [
              { x: 20, y: 15 },
              { x: 120, y: 65 },
            ],
          },
        },
      ])

      const items = useCanvasStore.getState().items
      expect(items.find((item) => item.id === 'box')).toMatchObject({ x: 30, y: 25 })
      const wall = items.find((item) => item.id === 'wall')
      expect(wall).toMatchObject({ x: 20, y: 15 })
      expect(wall?.properties.points).toEqual([
        { x: 20, y: 15 },
        { x: 120, y: 65 },
      ])
      // `points` must never leak onto the item as a top-level column.
      expect(wall && 'points' in wall).toBe(false)
      // Non-points properties survive the fold.
      expect(wall?.properties.curve_style).toBe('straight')
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

      undo()
      const restored = useCanvasStore.getState().items
      expect(restored.find((item) => item.id === 'box')).toMatchObject({ x: 10, y: 10 })
      expect(restored.find((item) => item.id === 'wall')?.properties.points).toEqual(originalPoints)
    })
  })

  describe('deleteItems', () => {
    it('removes every listed item and clears them from the selection in one history entry; undo restores items with selection staying cleared (pruning contract)', () => {
      useCanvasStore.setState({
        items: [makeItem({ id: 'a' }), makeItem({ id: 'b' }), makeItem({ id: 'c' })],
      })
      useCanvasStore.temporal.getState().clear()
      useCanvasStore.getState().replaceSelection(['a', 'b'])

      useCanvasStore.getState().deleteItems(['a', 'b'])

      expect(useCanvasStore.getState().items.map((item) => item.id)).toEqual(['c'])
      expect(useCanvasStore.getState().selectedItemIds).toEqual([])
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

      // Undo restores the deleted ITEMS — but never the selection, which is
      // untracked: it stays cleared rather than resurrecting as a ghost.
      undo()
      expect(useCanvasStore.getState().items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
      expect(useCanvasStore.getState().selectedItemIds).toEqual([])
    })

    it('keeps unrelated ids in the selection', () => {
      useCanvasStore.setState({
        items: [makeItem({ id: 'a' }), makeItem({ id: 'b' })],
        selectedItemIds: ['a', 'b'],
      })

      useCanvasStore.getState().deleteItems(['a'])

      expect(useCanvasStore.getState().selectedItemIds).toEqual(['b'])
    })

    it('is a no-op (no history entry) when none of the ids match an item', () => {
      const original = [makeItem({ id: 'a' })]
      useCanvasStore.setState({ items: original })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().deleteItems(['missing-1', 'missing-2'])

      expect(useCanvasStore.getState().items).toBe(original)
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
    })
  })

  describe('undo/redo selection pruning', () => {
    it('undoing a create prunes the now-nonexistent id from the selection (no stale-selection ghost)', () => {
      useCanvasStore.getState().createItemLocal(makeItem({ id: 'local-new' }))
      useCanvasStore.getState().replaceSelection(['local-new'])

      undo()

      expect(useCanvasStore.getState().items).toHaveLength(0)
      expect(useCanvasStore.getState().selectedItemIds).toEqual([])
    })

    it('pruning keeps still-existing ids and only drops dead ones', () => {
      useCanvasStore.getState().createItemLocal(makeItem({ id: 'a' }))
      useCanvasStore.getState().createItemLocal(makeItem({ id: 'local-new' }))
      useCanvasStore.getState().replaceSelection(['a', 'local-new'])

      undo() // removes only 'local-new' (the latest create)

      expect(useCanvasStore.getState().items.map((item) => item.id)).toEqual(['a'])
      expect(useCanvasStore.getState().selectedItemIds).toEqual(['a'])
    })

    it('redoing a delete prunes the re-deleted id from the selection', () => {
      useCanvasStore.getState().createItemLocal(makeItem({ id: 'a' }))
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().deleteItems(['a'])
      undo() // item back, selection still empty (deleteItems cleared it)
      useCanvasStore.getState().replaceSelection(['a'])

      redo() // re-applies the delete while 'a' is selected
      expect(useCanvasStore.getState().items).toHaveLength(0)
      expect(useCanvasStore.getState().selectedItemIds).toEqual([])
    })
  })

  describe('reorderZIndexItems', () => {
    it('front: moves all listed items above the previous max, preserving their relative order', () => {
      useCanvasStore.setState({
        items: [
          makeItem({ id: 'a', z_index: 0 }),
          makeItem({ id: 'b', z_index: 5 }),
          makeItem({ id: 'c', z_index: 2 }),
        ],
      })

      // Selection order deliberately differs from z-order: relative order
      // comes from the CURRENT z_index, not the click order.
      useCanvasStore.getState().reorderZIndexItems(['c', 'a'], 'front')

      const items = useCanvasStore.getState().items
      const zOf = (id: string) => items.find((item) => item.id === id)!.z_index
      expect(zOf('a')).toBeGreaterThan(5)
      expect(zOf('c')).toBeGreaterThan(5)
      // 'a' (z 0) was below 'c' (z 2) before, and must stay below it.
      expect(zOf('a')).toBeLessThan(zOf('c'))
      expect(zOf('b')).toBe(5)
    })

    it('back: moves all listed items below the previous min, preserving their relative order', () => {
      useCanvasStore.setState({
        items: [
          makeItem({ id: 'a', z_index: 0 }),
          makeItem({ id: 'b', z_index: 5 }),
          makeItem({ id: 'c', z_index: 2 }),
        ],
      })

      useCanvasStore.getState().reorderZIndexItems(['b', 'c'], 'back')

      const items = useCanvasStore.getState().items
      const zOf = (id: string) => items.find((item) => item.id === id)!.z_index
      expect(zOf('b')).toBeLessThan(0)
      expect(zOf('c')).toBeLessThan(0)
      // 'c' (z 2) was below 'b' (z 5) before, and must stay below it.
      expect(zOf('c')).toBeLessThan(zOf('b'))
      expect(zOf('a')).toBe(0)
    })

    it('a whole-selection reorder is ONE history entry, undoable back to the original z-indexes', () => {
      useCanvasStore.setState({
        items: [
          makeItem({ id: 'a', z_index: 0 }),
          makeItem({ id: 'b', z_index: 5 }),
          makeItem({ id: 'c', z_index: 2 }),
        ],
      })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().reorderZIndexItems(['a', 'c'], 'front')
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

      undo()
      const items = useCanvasStore.getState().items
      expect(items.find((item) => item.id === 'a')!.z_index).toBe(0)
      expect(items.find((item) => item.id === 'c')!.z_index).toBe(2)
    })

    it('is a no-op when no listed id matches an item', () => {
      const original = [makeItem({ id: 'a', z_index: 0 }), makeItem({ id: 'b', z_index: 5 })]
      useCanvasStore.setState({ items: original })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().reorderZIndexItems(['missing'], 'front')

      expect(useCanvasStore.getState().items).toBe(original)
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
    })
  })
})

// U4: persistent flat groups — groupSelection/ungroupSelection stamp/clear
// the client-generated `group_key` in ONE tracked set() each, and
// toggleIdsInSelection is the group-aware ctrl+click's atomic set-toggle.
// (The shared expansion helper `expandIdsByGroup` is exercised in
// CanvasStage.test.ts alongside the click/marquee routing that consumes it.)
describe('canvasStore persistent groups (U4)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemIds: [], activeTool: 'select', dirty: false })
    useCanvasStore.temporal.getState().clear()
  })

  function keyOf(id: CanvasObject['id']): string | null | undefined {
    return useCanvasStore.getState().items.find((item) => item.id === id)?.group_key
  }

  describe('groupSelection', () => {
    it('stamps ONE fresh group- key on every selected item in ONE history entry, setting dirty', () => {
      useCanvasStore.setState({
        items: [makeItem({ id: 'a' }), makeItem({ id: 'b' }), makeItem({ id: 'bystander' })],
        selectedItemIds: ['a', 'b'],
      })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().groupSelection()

      const key = keyOf('a')
      expect(key).toMatch(/^group-/)
      expect(keyOf('b')).toBe(key)
      expect(keyOf('bystander')).toBeUndefined()
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
      expect(useCanvasStore.getState().dirty).toBe(true)
    })

    it('grouping a selection containing an existing group merges into ONE flat key (R9)', () => {
      useCanvasStore.setState({
        items: [
          makeItem({ id: 'a', group_key: 'group-old' }),
          makeItem({ id: 'b', group_key: 'group-old' }),
          makeItem({ id: 'loose' }),
        ],
        selectedItemIds: ['a', 'b', 'loose'],
      })

      useCanvasStore.getState().groupSelection()

      const key = keyOf('a')
      expect(key).toMatch(/^group-/)
      expect(key).not.toBe('group-old')
      expect(keyOf('b')).toBe(key)
      expect(keyOf('loose')).toBe(key)
      // Flat: no item anywhere still carries the swallowed key.
      expect(useCanvasStore.getState().items.some((item) => item.group_key === 'group-old')).toBe(
        false,
      )
    })

    it('mints a DIFFERENT key per group action (two groups never collide)', () => {
      useCanvasStore.setState({
        items: [makeItem({ id: 'a' }), makeItem({ id: 'b' }), makeItem({ id: 'c' }), makeItem({ id: 'd' })],
        selectedItemIds: ['a', 'b'],
      })
      useCanvasStore.getState().groupSelection()
      const firstKey = keyOf('a')

      useCanvasStore.getState().replaceSelection(['c', 'd'])
      useCanvasStore.getState().groupSelection()

      expect(keyOf('c')).toMatch(/^group-/)
      expect(keyOf('c')).not.toBe(firstKey)
    })

    it('no-ops (no history entry, dirty untouched) with fewer than 2 selected members', () => {
      const original = [makeItem({ id: 'a' }), makeItem({ id: 'b' })]
      useCanvasStore.setState({ items: original, selectedItemIds: ['a'] })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().groupSelection()

      expect(useCanvasStore.getState().items).toBe(original)
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
      expect(useCanvasStore.getState().dirty).toBe(false)
    })

    it('no-ops when the selection ids do not match at least 2 real items (stale ids)', () => {
      const original = [makeItem({ id: 'a' })]
      useCanvasStore.setState({ items: original, selectedItemIds: ['a', 'ghost'] })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().groupSelection()

      expect(useCanvasStore.getState().items).toBe(original)
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
    })

    it('undo of a group is ONE entry restoring prior keys; redo restores the group', () => {
      useCanvasStore.setState({
        items: [makeItem({ id: 'a', group_key: 'group-old' }), makeItem({ id: 'b' })],
        selectedItemIds: ['a', 'b'],
      })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().groupSelection()
      const mintedKey = keyOf('a')

      undo()
      expect(keyOf('a')).toBe('group-old')
      expect(keyOf('b')).toBeUndefined()

      redo()
      expect(keyOf('a')).toBe(mintedKey)
      expect(keyOf('b')).toBe(mintedKey)
    })
  })

  describe('ungroupSelection', () => {
    it('mixed selection dissolves ALL groups present in ONE entry; loose items unaffected; everything stays selected', () => {
      useCanvasStore.setState({
        items: [
          makeItem({ id: 'a', group_key: 'group-1' }),
          makeItem({ id: 'b', group_key: 'group-1' }),
          makeItem({ id: 'c', group_key: 'group-2' }),
          makeItem({ id: 'loose' }),
          makeItem({ id: 'unselected', group_key: 'group-3' }),
        ],
        selectedItemIds: ['a', 'b', 'c', 'loose'],
      })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().ungroupSelection()

      expect(keyOf('a')).toBeNull()
      expect(keyOf('b')).toBeNull()
      expect(keyOf('c')).toBeNull()
      // Loose member untouched (never grouped — key stays absent, not null).
      expect(keyOf('loose')).toBeUndefined()
      // Unselected groups are none of this action's business.
      expect(keyOf('unselected')).toBe('group-3')
      expect(useCanvasStore.getState().selectedItemIds).toEqual(['a', 'b', 'c', 'loose'])
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
      expect(useCanvasStore.getState().dirty).toBe(true)
    })

    it('no-ops (no history entry, dirty untouched) when no selected member is grouped', () => {
      const original = [makeItem({ id: 'a' }), makeItem({ id: 'b' })]
      useCanvasStore.setState({ items: original, selectedItemIds: ['a', 'b'] })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().ungroupSelection()

      expect(useCanvasStore.getState().items).toBe(original)
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
      expect(useCanvasStore.getState().dirty).toBe(false)
    })

    it('undo of an ungroup is ONE entry restoring the keys', () => {
      useCanvasStore.setState({
        items: [
          makeItem({ id: 'a', group_key: 'group-1' }),
          makeItem({ id: 'b', group_key: 'group-1' }),
        ],
        selectedItemIds: ['a', 'b'],
      })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().ungroupSelection()
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

      undo()
      expect(keyOf('a')).toBe('group-1')
      expect(keyOf('b')).toBe('group-1')
    })
  })

  describe('toggleIdsInSelection', () => {
    it('appends the missing ids at the end when the set is not fully selected (completes a partial group)', () => {
      useCanvasStore.setState({ selectedItemIds: ['x', 'a'] })

      useCanvasStore.getState().toggleIdsInSelection(['a', 'b'])

      expect(useCanvasStore.getState().selectedItemIds).toEqual(['x', 'a', 'b'])
    })

    it('removes the whole set when every id is already selected', () => {
      useCanvasStore.setState({ selectedItemIds: ['x', 'a', 'b'] })

      useCanvasStore.getState().toggleIdsInSelection(['a', 'b'])

      expect(useCanvasStore.getState().selectedItemIds).toEqual(['x'])
    })

    it('a one-element set behaves exactly like toggleInSelection', () => {
      useCanvasStore.setState({ selectedItemIds: ['a'] })

      useCanvasStore.getState().toggleIdsInSelection(['b'])
      expect(useCanvasStore.getState().selectedItemIds).toEqual(['a', 'b'])

      useCanvasStore.getState().toggleIdsInSelection(['b'])
      expect(useCanvasStore.getState().selectedItemIds).toEqual(['a'])
    })

    it('never creates history entries or sets dirty (selection is untracked)', () => {
      useCanvasStore.setState({ items: [makeItem({ id: 'a' })] })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().toggleIdsInSelection(['a'])
      useCanvasStore.getState().toggleIdsInSelection(['a'])

      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
      expect(useCanvasStore.getState().dirty).toBe(false)
    })
  })
})

// U7 (canvas-tools): text objects. Content commits (`updateItemText`) are
// TRACKED — text content is the object's substance (the "a Line's points
// ARE its shape" precedent) — while styling commits
// (`updateItemTextStyling`) stay UNTRACKED per R15; both carry the
// remeasured mirrored width/height in the same single set().
describe('canvasStore text objects (U7)', () => {
  function makeTextItem(overrides: Partial<CanvasObject> = {}): CanvasObject {
    return makeItem({
      id: 'text-1',
      type: 'text',
      width: 60,
      height: 16,
      properties: {
        text: 'Meeting Room',
        font_family: 'Arial',
        font_size: 16,
        bold: false,
        italic: false,
        color: '#111827',
      },
      ...overrides,
    })
  }

  beforeEach(() => {
    useCanvasStore.setState({ items: [], selectedItemIds: [], dirty: false })
    useCanvasStore.temporal.getState().clear()
  })

  describe('updateItemText (tracked content commit)', () => {
    it('commits the text AND the mirrored width/height in ONE history entry; a single undo restores both', () => {
      useCanvasStore.setState({ items: [makeTextItem()] })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemText('text-1', 'Kitchen', { width: 56, height: 16 })

      const item = useCanvasStore.getState().items[0]
      expect(item.properties.text).toBe('Kitchen')
      expect(item.width).toBe(56)
      expect(item.height).toBe(16)
      expect(useCanvasStore.getState().dirty).toBe(true)
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

      undo()
      const restored = useCanvasStore.getState().items[0]
      expect(restored.properties.text).toBe('Meeting Room')
      expect(restored.width).toBe(60)
      expect(restored.height).toBe(16)
    })

    it('preserves the styling keys (only text and the mirrored box change)', () => {
      useCanvasStore.setState({ items: [makeTextItem()] })

      useCanvasStore.getState().updateItemText('text-1', 'Renamed', { width: 50, height: 16 })

      const properties = useCanvasStore.getState().items[0].properties
      expect(properties.font_family).toBe('Arial')
      expect(properties.font_size).toBe(16)
      expect(properties.color).toBe('#111827')
    })

    it('tracked-content contract: edit text, then move ANOTHER object — a single undo restores only the move, the text survives', () => {
      useCanvasStore.setState({
        items: [makeTextItem(), makeItem({ id: 'chair-1', x: 10, y: 10 })],
      })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemText('text-1', 'Edited content', { width: 90, height: 16 })
      useCanvasStore.getState().updateItemGeometry('chair-1', { x: 200, y: 300 })

      undo()

      const [text, chair] = useCanvasStore.getState().items
      expect(chair.x).toBe(10)
      expect(chair.y).toBe(10)
      // The content edit is its OWN history entry — the single undo above
      // must not have silently reverted it via the whole-items snapshot.
      expect(text.properties.text).toBe('Edited content')
    })

    it('no-ops (no history entry, dirty untouched) for an unknown id', () => {
      useCanvasStore.setState({ items: [makeTextItem()] })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemText('ghost', 'nope', { width: 1, height: 1 })

      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
      expect(useCanvasStore.getState().dirty).toBe(false)
    })
  })

  describe('updateItemTextStyling (untracked styling commit)', () => {
    it('updates properties AND the mirrored box, sets dirty, but pushes NO history entry (R15)', () => {
      useCanvasStore.setState({ items: [makeTextItem()] })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemTextStyling(
        'text-1',
        {
          text: 'Meeting Room',
          font_family: 'Georgia',
          font_size: 24,
          bold: true,
          italic: false,
          color: '#ff0000',
        },
        { width: 132, height: 24 },
      )

      const item = useCanvasStore.getState().items[0]
      expect(item.properties.font_family).toBe('Georgia')
      expect(item.properties.font_size).toBe(24)
      expect(item.properties.bold).toBe(true)
      expect(item.width).toBe(132)
      expect(item.height).toBe(24)
      expect(useCanvasStore.getState().dirty).toBe(true)
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
    })

    it('undo after a styling edit skips it and reverts the previous TRACKED action instead', () => {
      useCanvasStore.setState({ items: [makeTextItem({ x: 0 })] })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemGeometry('text-1', { x: 100 })
      useCanvasStore.getState().updateItemTextStyling(
        'text-1',
        { text: 'Meeting Room', font_family: 'Verdana', font_size: 16, bold: false, italic: false, color: '#111827' },
        { width: 70, height: 16 },
      )

      undo()

      const item = useCanvasStore.getState().items[0]
      expect(item.x).toBe(0) // the move reverted
      // R15: the styling change is not an undo step. (The whole-items
      // snapshot restore does carry the item's pre-move properties, which
      // is exactly why styling stays cheap/untracked — content, by
      // contrast, gets its own TRACKED action above.)
      expect(useCanvasStore.temporal.getState().futureStates).toHaveLength(1)
    })

    it('no-ops for an unknown id', () => {
      useCanvasStore.setState({ items: [makeTextItem()] })
      const before = useCanvasStore.getState().items

      useCanvasStore.getState().updateItemTextStyling('ghost', {}, { width: 1, height: 1 })

      expect(useCanvasStore.getState().items).toBe(before)
      expect(useCanvasStore.getState().dirty).toBe(false)
    })
  })

  describe('updateItemsGeometry font_size fold (transformer resize commit)', () => {
    it('folds a patch font_size into properties.font_size alongside the mirrored box, in ONE entry', () => {
      useCanvasStore.setState({ items: [makeTextItem()] })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemsGeometry([
        {
          id: 'text-1',
          patch: { x: 5, y: 6, rotation: 0, width: 120, height: 32, font_size: 32 },
        },
      ])

      const item = useCanvasStore.getState().items[0]
      expect(item.properties.font_size).toBe(32)
      expect(item.properties.text).toBe('Meeting Room') // untouched
      expect(item.width).toBe(120)
      expect(item.height).toBe(32)
      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

      undo()
      const restored = useCanvasStore.getState().items[0]
      expect(restored.properties.font_size).toBe(16)
      expect(restored.width).toBe(60)
    })

    it('a mixed batch (text font_size fold + box move) stays ONE history entry', () => {
      useCanvasStore.setState({
        items: [makeTextItem(), makeItem({ id: 'chair-1' })],
      })
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().updateItemsGeometry([
        { id: 'text-1', patch: { width: 90, height: 24, font_size: 24 } },
        { id: 'chair-1', patch: { x: 300 } },
      ])

      expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
      expect(useCanvasStore.getState().items[0].properties.font_size).toBe(24)
      expect(useCanvasStore.getState().items[1].x).toBe(300)
    })
  })

  describe('create-then-undo (F3)', () => {
    it('a committed creation via createItemLocal is removed by a SINGLE undo', () => {
      useCanvasStore.temporal.getState().clear()

      useCanvasStore.getState().createItemLocal(
        makeTextItem({ id: 'local-text-abc', properties: { text: 'Storage', font_family: 'Arial', font_size: 16, bold: false, italic: false, color: '#111827' } }),
      )
      expect(useCanvasStore.getState().items).toHaveLength(1)

      undo()

      expect(useCanvasStore.getState().items).toHaveLength(0)
    })
  })
})

// U8 (canvas-tools): the crop tool's store half — `canvasSize` joins the
// TRACKED snapshot (partialize/equality now cover BOTH references) and
// `applyCrop` replaces items + dims in ONE set(), so a crop undoes as a
// single step restoring dims AND every coordinate. Also pinned here: the
// equality regression (untracked actions still push no entries with the
// wider partialize), the exported undo()'s dirty check covering a
// dims-only traversal, the plan-switch reset clearing canvasSize, and
// entering the crop tool clearing the selection.
describe('canvasStore crop (U8)', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      items: [],
      selectedItemIds: [],
      activeTool: 'select',
      canvasSize: null,
      dirty: false,
      zoom: 1,
      stagePosition: { x: 0, y: 0 },
    })
    useCanvasStore.temporal.getState().clear()
  })

  function seedCroppablePlan() {
    useCanvasStore.getState().setItems(
      [
        makeItem({ id: 'inside-box', x: 300, y: 250 }),
        // Fully OUTSIDE the crop region below — must survive the crop at
        // negative coordinates (R22), never be dropped or clamped.
        makeItem({ id: 'outside-box', x: 10, y: 10 }),
        makeItem({
          id: 'line-1',
          type: 'line_straight',
          x: 260,
          y: 300,
          width: 140,
          height: 0,
          properties: {
            points: [
              { x: 260, y: 300 },
              { x: 400, y: 300 },
            ],
            curve_style: 'straight',
          },
        }),
      ],
      { width: 1600, height: 1200 },
    )
  }

  it('applyCrop shifts every coordinate (line points included), shrinks dims, and keeps the fully-outside object at negative coords — ONE undo restores dims AND every coordinate (AE6)', () => {
    seedCroppablePlan()

    useCanvasStore.getState().applyCrop({ x: 200, y: 200, width: 800, height: 600 })

    const state = useCanvasStore.getState()
    expect(state.canvasSize).toEqual({ width: 800, height: 600 })
    expect(state.items.find((item) => item.id === 'inside-box')).toMatchObject({ x: 100, y: 50 })
    expect(state.items.find((item) => item.id === 'outside-box')).toMatchObject({ x: -190, y: -190 })
    const line = state.items.find((item) => item.id === 'line-1')
    expect(line).toMatchObject({ x: 60, y: 100 })
    expect(line?.properties.points).toEqual([
      { x: 60, y: 100 },
      { x: 200, y: 100 },
    ])
    // The whole crop is exactly ONE history entry...
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

    // ...and a single undo restores the dims and every coordinate together.
    undo()
    const restored = useCanvasStore.getState()
    expect(restored.canvasSize).toEqual({ width: 1600, height: 1200 })
    expect(restored.items.find((item) => item.id === 'inside-box')).toMatchObject({ x: 300, y: 250 })
    expect(restored.items.find((item) => item.id === 'outside-box')).toMatchObject({ x: 10, y: 10 })
    expect(restored.items.find((item) => item.id === 'line-1')?.properties.points).toEqual([
      { x: 260, y: 300 },
      { x: 400, y: 300 },
    ])

    // Redo re-applies both halves too.
    redo()
    expect(useCanvasStore.getState().canvasSize).toEqual({ width: 800, height: 600 })
    expect(useCanvasStore.getState().items.find((item) => item.id === 'inside-box')).toMatchObject({ x: 100, y: 50 })
  })

  it('applyCrop marks the store dirty (a crop is unsaved divergence like any other content edit)', () => {
    seedCroppablePlan()
    expect(useCanvasStore.getState().dirty).toBe(false)

    useCanvasStore.getState().applyCrop({ x: 0, y: 0, width: 400, height: 300 })

    expect(useCanvasStore.getState().dirty).toBe(true)
  })

  it('untouched properties (rotation, width/height, group_key) survive a crop', () => {
    useCanvasStore.getState().setItems(
      [makeItem({ id: 'item-1', x: 100, y: 100, width: 80, height: 60, rotation: 45, group_key: 'group-abc' })],
      { width: 1600, height: 1200 },
    )

    useCanvasStore.getState().applyCrop({ x: 50, y: 50, width: 800, height: 600 })

    expect(useCanvasStore.getState().items[0]).toMatchObject({
      x: 50,
      y: 50,
      width: 80,
      height: 60,
      rotation: 45,
      group_key: 'group-abc',
    })
  })

  it('zoom/pan/selection/tool switches still create NO history entries now that partialize carries canvasSize (equality regression)', () => {
    seedCroppablePlan()

    useCanvasStore.getState().replaceSelection(['inside-box'])
    useCanvasStore.getState().toggleIdsInSelection(['outside-box'])
    useCanvasStore.getState().clearSelection()
    useCanvasStore.getState().setActiveTool('shape_rectangle')
    useCanvasStore.getState().setActiveTool('crop')
    useCanvasStore.getState().setActiveTool('select')
    useCanvasStore.getState().setZoomAndPosition(2, { x: 40, y: -20 })
    useCanvasStore.getState().setStagePosition({ x: 9, y: 9 })
    useCanvasStore.getState().zoomIn()
    useCanvasStore.getState().zoomOut()
    useCanvasStore.getState().resetZoom()
    useCanvasStore.getState().markSaved()

    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('a dims-only traversal sets dirty — the exported undo() covers the canvasSize reference, not just items', () => {
    useCanvasStore.getState().setItems([makeItem()], { width: 1600, height: 1200 })
    const itemsBefore = useCanvasStore.getState().items

    // A canvasSize-ONLY tracked change: the items reference is untouched,
    // so the old items-only dirty check would have missed this traversal.
    useCanvasStore.setState({ canvasSize: { width: 800, height: 600 } })
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
    expect(useCanvasStore.getState().dirty).toBe(false)

    undo()

    expect(useCanvasStore.getState().canvasSize).toEqual({ width: 1600, height: 1200 })
    expect(useCanvasStore.getState().items).toBe(itemsBefore)
    expect(useCanvasStore.getState().dirty).toBe(true)
  })

  it('setItems([]) (the plan-switch reset) clears canvasSize, so an unsaved crop cannot leak dims into the next plan', () => {
    seedCroppablePlan()
    useCanvasStore.getState().applyCrop({ x: 100, y: 100, width: 400, height: 300 })
    expect(useCanvasStore.getState().canvasSize).toEqual({ width: 400, height: 300 })
    const entriesAfterCrop = useCanvasStore.temporal.getState().pastStates.length

    useCanvasStore.getState().setItems([])

    expect(useCanvasStore.getState().canvasSize).toBeNull()
    expect(useCanvasStore.getState().dirty).toBe(false)
    // The reset itself is paused — no new history entry (the page's reset
    // effect clears zundo history separately).
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(entriesAfterCrop)
  })

  it('seeding via setItems(items, canvasSize) stamps both refs inside the paused bracket — not undoable, not dirty', () => {
    useCanvasStore.getState().setItems([makeItem()], { width: 900, height: 700 })

    expect(useCanvasStore.getState().canvasSize).toEqual({ width: 900, height: 700 })
    expect(useCanvasStore.getState().dirty).toBe(false)
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)

    undo()
    // Nothing to undo — the seed stays.
    expect(useCanvasStore.getState().canvasSize).toEqual({ width: 900, height: 700 })
  })

  it('entering the crop tool clears the selection; other tools leave it alone', () => {
    seedCroppablePlan()
    useCanvasStore.getState().replaceSelection(['inside-box', 'outside-box'])

    useCanvasStore.getState().setActiveTool('text')
    expect(useCanvasStore.getState().selectedItemIds).toEqual(['inside-box', 'outside-box'])

    useCanvasStore.getState().setActiveTool('crop')
    expect(useCanvasStore.getState().activeTool).toBe('crop')
    expect(useCanvasStore.getState().selectedItemIds).toEqual([])
  })
})

describe('code-review fixes (canvas-tools)', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      items: [],
      selectedItemIds: [],
      activeTool: 'select',
      dirty: false,
      serverIdMap: {},
      canvasSize: { width: 1600, height: 1200 },
    })
    useCanvasStore.temporal.getState().clear()
  })

  it('applyCrop re-clamps a stale rect against the CURRENT canvas (crop only trims)', () => {
    useCanvasStore.setState({ canvasSize: { width: 400, height: 300 } })
    // A rect captured before a redo shrank the canvas: larger than current.
    useCanvasStore.getState().applyCrop({ x: 100, y: 100, width: 1000, height: 800 })

    const size = useCanvasStore.getState().canvasSize
    expect(size).toEqual({ width: 300, height: 200 }) // clipped to 400-100 x 300-100
  })

  it('applyCrop no-ops on a degenerate (fully out-of-canvas) rect', () => {
    useCanvasStore.setState({ canvasSize: { width: 400, height: 300 } })
    useCanvasStore.temporal.getState().clear()
    const before = useCanvasStore.getState().items

    useCanvasStore.getState().applyCrop({ x: 500, y: 500, width: 200, height: 200 })

    expect(useCanvasStore.getState().canvasSize).toEqual({ width: 400, height: 300 })
    expect(useCanvasStore.getState().items).toBe(before)
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('deleteItems dissolves groups reduced to a single member — one history entry', () => {
    useCanvasStore.setState({
      items: [
        makeItem({ id: 'a', group_key: 'group-1' }),
        makeItem({ id: 'b', group_key: 'group-1' }),
        makeItem({ id: 'c' }),
      ],
    })
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().deleteItems(['a'])

    const survivor = useCanvasStore.getState().items.find((item) => item.id === 'b')
    expect(survivor?.group_key).toBeNull()
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
    // Undo restores both the deleted member and the group key.
    undo()
    const restored = useCanvasStore.getState().items.find((item) => item.id === 'b')
    expect(restored?.group_key).toBe('group-1')
  })
})

describe('pan as the idle tool mode (canvas-tools follow-up)', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      items: [makeItem({ id: 'a' })],
      selectedItemIds: ['a'],
      activeTool: 'select',
    })
    useCanvasStore.temporal.getState().clear()
  })

  it("defaults to 'pan' so a plain drag navigates before any tool is chosen", () => {
    // The store's own initial state (not the test fixture above).
    expect(useCanvasStore.getInitialState().activeTool).toBe('pan')
  })

  it('deselecting a tool (-> pan) clears the selection: the canvas ignores clicks in idle mode', () => {
    useCanvasStore.getState().setActiveTool('pan')

    expect(useCanvasStore.getState().activeTool).toBe('pan')
    expect(useCanvasStore.getState().selectedItemIds).toEqual([])
  })

  it('switching tools never creates a history entry', () => {
    useCanvasStore.getState().setActiveTool('pan')
    useCanvasStore.getState().setActiveTool('text')
    useCanvasStore.getState().setActiveTool('select')

    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })
})
