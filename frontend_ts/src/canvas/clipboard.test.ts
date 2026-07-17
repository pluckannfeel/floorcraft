import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildClipboardPayload,
  clearClipboard,
  getClipboard,
  hasClipboardContent,
  mintClipboardItems,
  resolvePastePoint,
  setClipboard,
} from './clipboard'
import { undo, useCanvasStore } from '../state/canvasStore'
import type { CanvasObject, Point } from './types'

/**
 * U5's clipboard: the pure payload build/mint helpers carry the bulk of the
 * coverage (the plan's jsdom-can't-mount-Konva convention), plus the
 * module-level clipboard value's cross-plan survival and the paste flow's
 * store-level contracts (one history entry per paste, undo/selection
 * behavior) exercised against the real canvasStore.
 */

function makeObject(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 'item-1',
    floor_plan: 7,
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

function makeLine(
  points: Point[],
  overrides: Partial<CanvasObject> = {},
): CanvasObject {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return makeObject({
    id: 'line-1',
    type: 'line_straight',
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    properties: { points, curve_style: 'straight' },
    ...overrides,
  })
}

/** Mirrors CanvasEditorPage's `handlePasteAt`: mint from the module
 * clipboard, commit through the batched store action, select the set. */
function pasteIntoStore(point: Point, floorPlanId: number): CanvasObject[] {
  const payload = getClipboard()
  if (!payload) return []
  const { items } = useCanvasStore.getState()
  const maxZIndex = items.reduce((max, item) => Math.max(max, item.z_index), -1)
  const minted = mintClipboardItems(payload, point, floorPlanId, maxZIndex + 1)
  useCanvasStore.getState().createItemsLocal(minted)
  useCanvasStore.getState().replaceSelection(minted.map((item) => item.id))
  return minted
}

beforeEach(() => {
  clearClipboard()
  useCanvasStore.setState({
    items: [],
    selectedItemIds: [],
    activeTool: 'select',
    dirty: false,
    serverIdMap: {},
  })
  useCanvasStore.temporal.getState().clear()
})

describe('buildClipboardPayload', () => {
  it('returns null when the selection matches no items', () => {
    expect(buildClipboardPayload([], [makeObject()])).toBeNull()
    expect(buildClipboardPayload(['ghost'], [makeObject()])).toBeNull()
  })

  it('stores offsets relative to the selected set bbox origin', () => {
    const a = makeObject({ id: 'a', x: 100, y: 100, z_index: 0 })
    const b = makeObject({ id: 'b', x: 200, y: 160, z_index: 1 })
    const payload = buildClipboardPayload(['a', 'b'], [a, b])!

    expect(payload.entries).toHaveLength(2)
    expect(payload.entries[0].offset).toEqual({ x: 0, y: 0 })
    expect(payload.entries[1].offset).toEqual({ x: 100, y: 60 })
    expect(payload.entries.map((entry) => entry.type)).toEqual(['chairs', 'chairs'])
  })

  it('orders entries by the set internal z-order (ascending z_index, then id), not store order', () => {
    const upper = makeObject({ id: 'upper', name: 'Upper', z_index: 5 })
    const lower = makeObject({ id: 'lower', name: 'Lower', z_index: 2 })
    // Store order deliberately upper-first; the payload sorts bottom-most
    // first, so paste can renumber contiguously from zIndexStart upward.
    const payload = buildClipboardPayload(['upper', 'lower'], [upper, lower])!

    expect(payload.entries.map((entry) => entry.name)).toEqual(['Lower', 'Upper'])
  })

  it('deep-copies properties — later edits to the live item never mutate the snapshot', () => {
    const item = makeObject({ id: 'a', properties: { color: 'red', nested: { k: 1 } } })
    const payload = buildClipboardPayload(['a'], [item])!

    ;(item.properties.nested as { k: number }).k = 999
    item.properties.color = 'blue'

    expect(payload.entries[0].properties).toEqual({ color: 'red', nested: { k: 1 } })
  })

  it('never carries item ids or original group keys — group structure is an index partition (no id leakage)', () => {
    const a = makeObject({ id: 41, group_key: 'group-original-A', z_index: 0 })
    const b = makeObject({ id: 42, group_key: 'group-original-A', z_index: 1 })
    const c = makeObject({ id: 43, group_key: 'group-original-B', z_index: 2 })
    const loose = makeObject({ id: 44, z_index: 3 })
    const payload = buildClipboardPayload([41, 42, 43, 44], [a, b, c, loose])!

    expect(payload.entries.map((entry) => entry.groupIndex)).toEqual([0, 0, 1, null])
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('group-original')
    expect(serialized).not.toContain('"id"')
  })

  it('rebases a Line entry points to the set bbox origin (absolute points never enter the clipboard)', () => {
    const line = makeLine([
      { x: 100, y: 100 },
      { x: 200, y: 150 },
    ])
    const box = makeObject({ id: 'box', x: 50, y: 50, z_index: 1 })
    const payload = buildClipboardPayload(['line-1', 'box'], [line, box])!

    // Set bbox origin is (50, 50) — the box's corner.
    const lineEntry = payload.entries[0]
    expect(lineEntry.type).toBe('line_straight')
    expect(lineEntry.properties.points).toEqual([
      { x: 50, y: 50 },
      { x: 150, y: 100 },
    ])
    // Non-points properties ride along untouched.
    expect(lineEntry.properties.curve_style).toBe('straight')
  })
})

describe('mintClipboardItems', () => {
  it('positions the set at the paste point preserving relative offsets, with fresh local ids', () => {
    const a = makeObject({ id: 1, name: 'A', x: 100, y: 100, z_index: 0 })
    const b = makeObject({ id: 2, name: 'B', x: 200, y: 160, z_index: 1, rotation: 30 })
    const payload = buildClipboardPayload([1, 2], [a, b])!

    const minted = mintClipboardItems(payload, { x: 500, y: 300 }, 7, 10)

    expect(minted.map((item) => ({ x: item.x, y: item.y }))).toEqual([
      { x: 500, y: 300 },
      { x: 600, y: 360 },
    ])
    expect(minted.map((item) => item.name)).toEqual(['A', 'B'])
    expect(minted[1].rotation).toBe(30)
    for (const item of minted) {
      expect(String(item.id)).toMatch(/^local-/)
      expect(item.floor_plan).toBe(7)
    }
    expect(minted[0].id).not.toBe(minted[1].id)
  })

  it('assigns z_index from zIndexStart upward, preserving the set internal order', () => {
    const lower = makeObject({ id: 'lower', name: 'Lower', z_index: 2 })
    const upper = makeObject({ id: 'upper', name: 'Upper', z_index: 5 })
    const payload = buildClipboardPayload(['upper', 'lower'], [upper, lower])!

    const minted = mintClipboardItems(payload, { x: 0, y: 0 }, 7, 11)

    expect(minted.map((item) => [item.name, item.z_index])).toEqual([
      ['Lower', 11],
      ['Upper', 12],
    ])
  })

  it('pasting the same payload twice mints different ids and different group keys each time', () => {
    const a = makeObject({ id: 'a', group_key: 'group-orig', z_index: 0 })
    const b = makeObject({ id: 'b', group_key: 'group-orig', z_index: 1 })
    const payload = buildClipboardPayload(['a', 'b'], [a, b])!

    const first = mintClipboardItems(payload, { x: 0, y: 0 }, 7, 2)
    const second = mintClipboardItems(payload, { x: 0, y: 0 }, 7, 4)

    const firstIds = new Set(first.map((item) => item.id))
    for (const item of second) expect(firstIds.has(item.id)).toBe(false)
    expect(first[0].group_key).not.toBe(second[0].group_key)
  })

  it('a copied group pastes as a group with ONE fresh key; two distinct groups stay two distinct fresh keys', () => {
    const a = makeObject({ id: 'a', group_key: 'group-one', z_index: 0 })
    const b = makeObject({ id: 'b', group_key: 'group-one', z_index: 1 })
    const c = makeObject({ id: 'c', group_key: 'group-two', z_index: 2 })
    const loose = makeObject({ id: 'd', z_index: 3 })
    const payload = buildClipboardPayload(['a', 'b', 'c', 'd'], [a, b, c, loose])!

    const minted = mintClipboardItems(payload, { x: 0, y: 0 }, 7, 4)

    const [mintedA, mintedB, mintedC, mintedLoose] = minted
    expect(mintedA.group_key).toMatch(/^group-/)
    expect(mintedA.group_key).toBe(mintedB.group_key)
    expect(mintedC.group_key).toMatch(/^group-/)
    expect(mintedC.group_key).not.toBe(mintedA.group_key)
    expect(mintedLoose.group_key).toBeNull()
    // Internal grouping preserved, original identity not.
    expect(mintedA.group_key).not.toBe('group-one')
    expect(mintedC.group_key).not.toBe('group-two')
  })

  it('re-absolutizes a Line entry points at the paste point and recomputes its bbox metadata', () => {
    const line = makeLine([
      { x: 100, y: 100 },
      { x: 200, y: 150 },
    ])
    const payload = buildClipboardPayload(['line-1'], [line])!

    const minted = mintClipboardItems(payload, { x: 500, y: 300 }, 7, 1)

    expect(minted[0].properties.points).toEqual([
      { x: 500, y: 300 },
      { x: 600, y: 350 },
    ])
    // Descriptive metadata recomputed from the NEW absolute points.
    expect(minted[0].x).toBe(500)
    expect(minted[0].y).toBe(300)
    expect(minted[0].width).toBe(100)
    expect(minted[0].height).toBe(50)
  })

  it('cross-plan paste: server-id originals from plan A mint as pure local creates in plan B (Line included)', () => {
    // Plan A items with REAL server identity (numeric ids, floor_plan 7).
    const box = makeObject({ id: 31, x: 20, y: 20, z_index: 0 })
    const line = makeLine(
      [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
      ],
      { id: 32, z_index: 1 },
    )
    const payload = buildClipboardPayload([31, 32], [box, line])!

    // Pasted into plan 42 at (300, 400): set origin (20, 20) lands there.
    const minted = mintClipboardItems(payload, { x: 300, y: 400 }, 42, 1)

    for (const item of minted) {
      expect(item.floor_plan).toBe(42)
      expect(String(item.id)).toMatch(/^local-/)
    }
    expect(minted[0]).toMatchObject({ x: 300, y: 400 })
    expect(minted[1].properties.points).toEqual([
      { x: 300, y: 460 },
      { x: 400, y: 460 },
    ])
  })
})

describe('module clipboard value', () => {
  it('starts empty: no content, nothing to paste', () => {
    expect(hasClipboardContent()).toBe(false)
    expect(getClipboard()).toBeNull()
  })

  it('survives a plan switch (store reset + history clear) — cross-plan paste creates local objects (AE4)', () => {
    // Copy in plan A…
    const source = makeObject({ id: 5, floor_plan: 7, x: 10, y: 10 })
    useCanvasStore.setState({ items: [source] })
    setClipboard(buildClipboardPayload([5], [source])!)

    // …then a plan switch: CanvasEditorPage's reset effect empties the
    // store and clears the undo history. The clipboard is a module value —
    // none of that touches it.
    useCanvasStore.getState().setItems([])
    useCanvasStore.getState().clearSelection()
    useCanvasStore.temporal.getState().clear()

    expect(hasClipboardContent()).toBe(true)
    const minted = pasteIntoStore({ x: 50, y: 60 }, 99)

    expect(minted).toHaveLength(1)
    expect(useCanvasStore.getState().items).toHaveLength(1)
    expect(useCanvasStore.getState().items[0]).toMatchObject({
      floor_plan: 99,
      x: 50,
      y: 60,
    })
    expect(String(useCanvasStore.getState().items[0].id)).toMatch(/^local-/)
  })
})

describe('paste flow through the store (AE4)', () => {
  it('copy 2 objects, paste at a point: offsets preserved, fresh ids, set selected, ONE undo removes both', () => {
    const a = makeObject({ id: 'a', x: 100, y: 100, z_index: 0 })
    const b = makeObject({ id: 'b', x: 200, y: 160, z_index: 1 })
    const c = makeObject({ id: 'c', x: 400, y: 400, z_index: 2 })
    useCanvasStore.setState({ items: [a, b, c] })
    useCanvasStore.temporal.getState().clear()

    setClipboard(buildClipboardPayload(['a', 'b'], [a, b])!)
    const minted = pasteIntoStore({ x: 500, y: 300 }, 7)

    const state = useCanvasStore.getState()
    expect(state.items).toHaveLength(5)
    // Relative offsets preserved at the paste point.
    expect(minted.map((item) => ({ x: item.x, y: item.y }))).toEqual([
      { x: 500, y: 300 },
      { x: 600, y: 360 },
    ])
    // Pasted set on top: above the current max (2), internal order kept.
    expect(minted.map((item) => item.z_index)).toEqual([3, 4])
    // The pasted set IS the selection.
    expect(state.selectedItemIds).toEqual(minted.map((item) => item.id))
    // ONE history entry for the whole paste…
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)
    expect(state.dirty).toBe(true)

    // …so a single undo removes both pasted items (and prunes them from
    // the selection).
    undo()
    expect(useCanvasStore.getState().items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(useCanvasStore.getState().selectedItemIds).toEqual([])
  })

  it('cut then undo restores the originals; the clipboard still pastes', () => {
    const a = makeObject({ id: 'a', x: 10, y: 10, z_index: 0 })
    const b = makeObject({ id: 'b', x: 60, y: 10, z_index: 1 })
    useCanvasStore.setState({ items: [a, b], selectedItemIds: ['a', 'b'] })
    useCanvasStore.temporal.getState().clear()

    // Cut = copy + batched delete (mirrors handleCut).
    setClipboard(buildClipboardPayload(['a', 'b'], [a, b])!)
    useCanvasStore.getState().deleteItems(['a', 'b'])
    expect(useCanvasStore.getState().items).toHaveLength(0)
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(1)

    // Undo restores the cut originals…
    undo()
    expect(useCanvasStore.getState().items.map((item) => item.id)).toEqual(['a', 'b'])

    // …and the clipboard is unaffected: paste still mints the pair.
    const minted = pasteIntoStore({ x: 200, y: 200 }, 7)
    expect(minted).toHaveLength(2)
    expect(useCanvasStore.getState().items).toHaveLength(4)
    expect(minted.map((item) => ({ x: item.x, y: item.y }))).toEqual([
      { x: 200, y: 200 },
      { x: 250, y: 200 },
    ])
  })

  it('paste with an empty clipboard is a no-op: no items, no selection change, no history entry', () => {
    const existing = makeObject({ id: 'a' })
    useCanvasStore.setState({ items: [existing], selectedItemIds: ['a'] })
    useCanvasStore.temporal.getState().clear()
    const itemsBefore = useCanvasStore.getState().items

    const minted = pasteIntoStore({ x: 100, y: 100 }, 7)

    expect(minted).toEqual([])
    expect(useCanvasStore.getState().items).toBe(itemsBefore)
    expect(useCanvasStore.getState().selectedItemIds).toEqual(['a'])
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('createItemsLocal with an empty list is a no-op (no history entry, dirty untouched)', () => {
    const existing = makeObject({ id: 'a' })
    useCanvasStore.setState({ items: [existing], dirty: false })
    useCanvasStore.temporal.getState().clear()
    const itemsBefore = useCanvasStore.getState().items

    useCanvasStore.getState().createItemsLocal([])

    expect(useCanvasStore.getState().items).toBe(itemsBefore)
    expect(useCanvasStore.getState().dirty).toBe(false)
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })
})

describe('resolvePastePoint (Ctrl+V paste point)', () => {
  const containerRect = { left: 100, top: 50, width: 800, height: 600 }

  it('uses the pointer position when the cursor is over the canvas, converting through zoom/pan', () => {
    const point = resolvePastePoint({
      lastPointer: { x: 300, y: 250 },
      containerRect,
      viewportWidth: 1920,
      viewportHeight: 1080,
      zoom: 2,
      stagePosition: { x: 50, y: 50 },
    })
    // Container-relative (200, 200) → model ((200-50)/2, (200-50)/2).
    expect(point).toEqual({ x: 75, y: 75 })
  })

  it('falls back to the visible-canvas center when the cursor is off-canvas', () => {
    const point = resolvePastePoint({
      lastPointer: { x: 20, y: 20 }, // left of the container
      containerRect,
      viewportWidth: 1000,
      viewportHeight: 500,
      zoom: 1,
      stagePosition: { x: 0, y: 0 },
    })
    // Visible part: x [100, 900], y [50, 500] → center (500, 275) →
    // container-relative (400, 225).
    expect(point).toEqual({ x: 400, y: 225 })
  })

  it('falls back to the visible-canvas center when no pointer position was ever observed', () => {
    const point = resolvePastePoint({
      lastPointer: null,
      containerRect,
      viewportWidth: 1000,
      viewportHeight: 500,
      zoom: 1,
      stagePosition: { x: 0, y: 0 },
    })
    expect(point).toEqual({ x: 400, y: 225 })
  })

  it('treats a pointer inside the container rect but outside the viewport as off-canvas', () => {
    const point = resolvePastePoint({
      lastPointer: { x: 800, y: 600 }, // in the rect, below the 500px viewport
      containerRect,
      viewportWidth: 1000,
      viewportHeight: 500,
      zoom: 1,
      stagePosition: { x: 0, y: 0 },
    })
    expect(point).toEqual({ x: 400, y: 225 })
  })

  it('uses the raw container center when the canvas is entirely outside the viewport', () => {
    const point = resolvePastePoint({
      lastPointer: null,
      containerRect: { left: 2000, top: 50, width: 800, height: 600 },
      viewportWidth: 1000,
      viewportHeight: 500,
      zoom: 1,
      stagePosition: { x: 0, y: 0 },
    })
    // Raw center (2400, 350) → container-relative (400, 300).
    expect(point).toEqual({ x: 400, y: 300 })
  })

  it('respects zoom/pan in the center fallback too', () => {
    const point = resolvePastePoint({
      lastPointer: null,
      containerRect,
      viewportWidth: 1000,
      viewportHeight: 500,
      zoom: 2,
      stagePosition: { x: 100, y: 100 },
    })
    // Container-relative center (400, 225) → ((400-100)/2, (225-100)/2).
    expect(point).toEqual({ x: 150, y: 62.5 })
  })
})
