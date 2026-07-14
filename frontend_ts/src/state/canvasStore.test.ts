import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasObject } from '../canvas/types'
import { useCanvasStore } from './canvasStore'

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
