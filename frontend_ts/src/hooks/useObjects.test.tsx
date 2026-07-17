import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import {
  buildClipboardPayload,
  clearClipboard,
  mintClipboardItems,
  setClipboard,
} from '../canvas/clipboard'
import * as ToastContextModule from '../notifications/ToastContext'
import { redo, undo, useCanvasStore } from '../state/canvasStore'
import type { CanvasObject } from '../canvas/types'
import { useObjects, useSaveObjects } from './useObjects'

/**
 * Explicit-save test suite. The old per-action mutation tests (optimistic
 * create/update/delete with rollback) died with that architecture — the
 * only write path now is `useSaveObjects`' single PUT, so coverage centers
 * on: the payload's id translation through `serverIdMap`, and the
 * on-success contract (merge id_map, clear `dirty` only when nothing
 * changed mid-flight, update the query cache, and NEVER touch `items` or
 * the undo history — the fix for "undo/redo doesn't work after saving").
 *
 * Same conventions as before: `apiClient` mocked via `vi.spyOn`, `useToast`
 * mocked so no ToastProvider is needed, QueryClientProvider wrapper with
 * retries off.
 */

function makeObject(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 1,
    floor_plan: 7,
    type: 'tables',
    name: 'Table',
    x: 0,
    y: 0,
    width: 40,
    height: 40,
    rotation: 0,
    z_index: 0,
    properties: {},
    ...overrides,
  } as CanvasObject
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const showError = vi.fn()

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  useCanvasStore.setState({
    items: [],
    selectedItemIds: [],
    activeTool: 'select',
    dirty: false,
    serverIdMap: {},
  })
  useCanvasStore.temporal.getState().clear()
  clearClipboard()
  showError.mockClear()
  vi.spyOn(ToastContextModule, 'useToast').mockReturnValue({
    toasts: [],
    showError,
    dismiss: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useObjects (load query)', () => {
  it('fetches the floor plan objects with the floor_plan param', async () => {
    const objects = [makeObject()]
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValue({ data: objects } as never)

    const { result } = renderHook(() => useObjects(7), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual(objects))
    expect(getSpy).toHaveBeenCalledWith('/objects/', {
      params: { floor_plan: 7 },
    })
  })

  it('never fires for a malformed floor plan id', () => {
    const getSpy = vi.spyOn(apiClient, 'get')

    renderHook(() => useObjects(Number.NaN), { wrapper })

    expect(getSpy).not.toHaveBeenCalled()
  })
})

describe('useSaveObjects', () => {
  it('PUTs the full items list with ids translated through serverIdMap', async () => {
    // Three identity cases in one payload: a server row (numeric id, no
    // mapping), a fresh local item (unmapped local id, sent as-is), and a
    // previously-saved local item (local id mapped to its real row).
    useCanvasStore.setState({
      items: [
        makeObject({ id: 10, name: 'From server' }),
        makeObject({ id: 'local-fresh' as never, name: 'Fresh' }),
        makeObject({ id: 'local-saved' as never, name: 'Saved before' }),
      ],
      dirty: true,
      serverIdMap: { 'local-saved': 42 },
    })
    const putSpy = vi.spyOn(apiClient, 'put').mockResolvedValue({
      data: { objects: [], id_map: {} },
    } as never)

    const { result } = renderHook(() => useSaveObjects(7), { wrapper })
    act(() => result.current.mutate())

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const [url, body] = putSpy.mock.calls[0] as [
      string,
      { objects: Record<string, unknown>[] },
    ]
    expect(url).toBe('/floor-plans/7/objects/')
    expect(body.objects.map((o) => o.id)).toEqual([10, 'local-fresh', 42])
    // floor_plan and server-owned timestamps are stripped from every item.
    for (const item of body.objects) {
      expect(item).not.toHaveProperty('floor_plan')
      expect(item).not.toHaveProperty('created_at')
      expect(item).not.toHaveProperty('updated_at')
    }
  })

  it('on success: merges id_map, clears dirty, updates the cache — never touching items or history', async () => {
    useCanvasStore.setState({
      items: [makeObject({ id: 'local-abc' as never, name: 'New' })],
      dirty: true,
    })
    // A real history entry that must survive the save.
    act(() => {
      useCanvasStore
        .getState()
        .updateItemGeometry('local-abc' as never, { x: 5 })
    })
    const itemsAfterEdit = useCanvasStore.getState().items
    const pastDepth = useCanvasStore.temporal.getState().pastStates.length
    expect(pastDepth).toBeGreaterThan(0)

    const canonical = [makeObject({ id: 99, name: 'New', x: 5 })]
    vi.spyOn(apiClient, 'put').mockResolvedValue({
      data: { objects: canonical, id_map: { 'local-abc': 99 } },
    } as never)

    const { result } = renderHook(() => useSaveObjects(7), { wrapper })
    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const state = useCanvasStore.getState()
    // The fix for "undo/redo doesn't work after saving": items keep their
    // client-side identity and the undo stack is intact.
    expect(state.items).toBe(itemsAfterEdit)
    expect(useCanvasStore.temporal.getState().pastStates.length).toBe(
      pastDepth,
    )
    // Bookkeeping updated.
    expect(state.serverIdMap).toEqual({ 'local-abc': 99 })
    expect(state.dirty).toBe(false)
    expect(queryClient.getQueryData(['objects', 7])).toEqual(canonical)
  })

  it('undo after save still works, and the next save reuses the mapped id (no duplicate create)', async () => {
    // Edit -> save -> undo -> save again: the second payload must send the
    // item under its MAPPED server id (an update), not as a fresh create.
    act(() => {
      useCanvasStore
        .getState()
        .createItemLocal(makeObject({ id: 'local-abc' as never, x: 0 }))
    })
    act(() => {
      useCanvasStore
        .getState()
        .updateItemGeometry('local-abc' as never, { x: 50 })
    })

    const putSpy = vi.spyOn(apiClient, 'put').mockResolvedValue({
      data: {
        objects: [makeObject({ id: 99, x: 50 })],
        id_map: { 'local-abc': 99 },
      },
    } as never)

    const { result } = renderHook(() => useSaveObjects(7), { wrapper })
    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(useCanvasStore.getState().dirty).toBe(false)

    // Undo AFTER the save: history is intact and the traversal re-dirties
    // the canvas.
    act(() => undo())
    expect(useCanvasStore.getState().items[0]).toEqual(
      expect.objectContaining({ id: 'local-abc', x: 0 }),
    )
    expect(useCanvasStore.getState().dirty).toBe(true)

    // Save #2: the item still carries its local id client-side, but the
    // payload translates it to the row save #1 created.
    act(() => result.current.mutate())
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2))
    const secondBody = putSpy.mock.calls[1][1] as {
      objects: Record<string, unknown>[]
    }
    expect(secondBody.objects.map((o) => o.id)).toEqual([99])
  })

  it('carries group_key in every payload item — the stored key for grouped items, an explicit null otherwise (U4)', async () => {
    useCanvasStore.setState({
      items: [
        makeObject({ id: 1, name: 'Member', group_key: 'group-abc' }),
        makeObject({ id: 2, name: 'Never grouped' }),
        makeObject({ id: 3, name: 'Ungrouped', group_key: null }),
      ],
      dirty: true,
    })
    const putSpy = vi.spyOn(apiClient, 'put').mockResolvedValue({
      data: { objects: [], id_map: {} },
    } as never)

    const { result } = renderHook(() => useSaveObjects(7), { wrapper })
    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const body = putSpy.mock.calls[0][1] as {
      objects: Record<string, unknown>[]
    }
    // Explicit null (never an omitted field): an ungroup must round-trip
    // as a CLEAR server-side, and never-grouped items must stay NULL.
    expect(body.objects.map((o) => o.group_key)).toEqual([
      'group-abc',
      null,
      null,
    ])
  })

  it('undo ACROSS a save of a grouping change stays consistent — mapped ids reused, key toggles cleanly (U4)', async () => {
    // The chain: create 2 -> group -> save #1 -> undo (ungroups) ->
    // save #2 (mapped ids, null keys) -> redo (regroups with the SAME
    // key from the snapshot) -> save #3 (mapped ids, key back). Group
    // keys are client-generated, so no id_map machinery ever touches
    // them — they must ride the items snapshots verbatim.
    act(() => {
      useCanvasStore
        .getState()
        .createItemLocal(makeObject({ id: 'local-a' as never, name: 'A' }))
    })
    act(() => {
      useCanvasStore
        .getState()
        .createItemLocal(makeObject({ id: 'local-b' as never, name: 'B' }))
    })
    act(() => {
      useCanvasStore.getState().replaceSelection(['local-a', 'local-b'])
    })
    act(() => {
      useCanvasStore.getState().groupSelection()
    })
    const groupKey = useCanvasStore.getState().items[0].group_key
    expect(groupKey).toMatch(/^group-/)

    const putSpy = vi.spyOn(apiClient, 'put').mockResolvedValue({
      data: {
        objects: [
          makeObject({ id: 1, name: 'A', group_key: groupKey }),
          makeObject({ id: 2, name: 'B', group_key: groupKey }),
        ],
        id_map: { 'local-a': 1, 'local-b': 2 },
      },
    } as never)

    const { result } = renderHook(() => useSaveObjects(7), { wrapper })
    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const firstBody = putSpy.mock.calls[0][1] as {
      objects: Record<string, unknown>[]
    }
    expect(firstBody.objects.map((o) => o.group_key)).toEqual([
      groupKey,
      groupKey,
    ])

    // Undo AFTER the save reverts ONLY the grouping (one entry) and
    // re-dirties; the items keep their client-side local ids.
    act(() => undo())
    expect(
      useCanvasStore.getState().items.map((item) => item.group_key ?? null),
    ).toEqual([null, null])
    expect(useCanvasStore.getState().dirty).toBe(true)

    // Save #2: ids translate through serverIdMap (updates, not duplicate
    // creates) and the cleared keys go out as explicit nulls.
    act(() => result.current.mutate())
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2))
    const secondBody = putSpy.mock.calls[1][1] as {
      objects: Record<string, unknown>[]
    }
    expect(secondBody.objects.map((o) => o.id)).toEqual([1, 2])
    expect(secondBody.objects.map((o) => o.group_key)).toEqual([null, null])

    // Redo restores the grouping with the ORIGINAL client-generated key
    // (snapshots carry it verbatim); save #3 sends it under mapped ids.
    act(() => redo())
    act(() => result.current.mutate())
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(3))
    const thirdBody = putSpy.mock.calls[2][1] as {
      objects: Record<string, unknown>[]
    }
    expect(thirdBody.objects.map((o) => o.id)).toEqual([1, 2])
    expect(thirdBody.objects.map((o) => o.group_key)).toEqual([
      groupKey,
      groupKey,
    ])
  })

  it('paste → save → undo → save follows the stable-id invariants (pasted item translates through serverIdMap on save #2) (U5)', async () => {
    // The chain-repair suite, extended to PASTED objects: a paste mints a
    // fresh `local-` id (never reusing the copied item's identity), save #1
    // creates its row and maps the local id, and after an undo the second
    // save must send the pasted item under its MAPPED server id (an
    // update) — never a duplicate create.
    const source = makeObject({ id: 10, name: 'Source', x: 0, y: 0 })
    useCanvasStore.setState({ items: [source] })
    useCanvasStore.temporal.getState().clear()

    // Copy the source, paste it at (100, 100) — mirrors handleCopy +
    // handlePasteAt (batched create, then select).
    const payload = buildClipboardPayload([10], [source])!
    setClipboard(payload)
    const minted = mintClipboardItems(payload, { x: 100, y: 100 }, 7, 1)
    act(() => {
      useCanvasStore.getState().createItemsLocal(minted)
      useCanvasStore.getState().replaceSelection(minted.map((item) => item.id))
    })
    const pastedId = minted[0].id
    expect(String(pastedId)).toMatch(/^local-/)

    const putSpy = vi.spyOn(apiClient, 'put').mockResolvedValue({
      data: {
        objects: [source, makeObject({ id: 55, name: 'Source', x: 100, y: 100 })],
        id_map: { [String(pastedId)]: 55 },
      },
    } as never)

    // Save #1: the pasted item goes out under its local id (a create).
    const { result } = renderHook(() => useSaveObjects(7), { wrapper })
    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const firstBody = putSpy.mock.calls[0][1] as {
      objects: Record<string, unknown>[]
    }
    expect(firstBody.objects.map((o) => o.id)).toEqual([10, pastedId])
    expect(useCanvasStore.getState().serverIdMap).toEqual({
      [String(pastedId)]: 55,
    })

    // Post-save edit, then undo it — the pasted item keeps its client-side
    // local id through the whole traversal (ids in snapshots stay valid all
    // session; translation happens only at the save boundary).
    act(() => {
      useCanvasStore.getState().updateItemGeometry(pastedId, { x: 300 })
    })
    act(() => undo())
    expect(
      useCanvasStore.getState().items.map((item) => item.id),
    ).toEqual([10, pastedId])
    expect(useCanvasStore.getState().items[1].x).toBe(100)
    expect(useCanvasStore.getState().dirty).toBe(true)

    // Save #2: the pasted item translates through serverIdMap — sent as
    // row 55 (an update), not re-created under a fresh id.
    act(() => result.current.mutate())
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2))
    const secondBody = putSpy.mock.calls[1][1] as {
      objects: Record<string, unknown>[]
    }
    expect(secondBody.objects.map((o) => o.id)).toEqual([10, 55])
  })

  it('keeps dirty set when the user edited while the PUT was in flight', async () => {
    useCanvasStore.setState({
      items: [makeObject({ id: 10, x: 0 })],
      dirty: true,
    })
    let releasePut: ((value: unknown) => void) | null = null
    vi.spyOn(apiClient, 'put').mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePut = resolve
        }) as never,
    )

    const { result } = renderHook(() => useSaveObjects(7), { wrapper })
    act(() => result.current.mutate())
    await waitFor(() => expect(releasePut).not.toBeNull())

    // Mid-flight edit: not covered by the in-flight save.
    act(() => {
      useCanvasStore.getState().updateItemGeometry(10, { x: 999 })
    })

    act(() => {
      releasePut!({ data: { objects: [], id_map: {} } })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(useCanvasStore.getState().dirty).toBe(true)
  })

  it('on failure: toast, items untouched, still dirty', async () => {
    const items = [makeObject({ id: 10 })]
    useCanvasStore.setState({ items, dirty: true })
    vi.spyOn(apiClient, 'put').mockRejectedValue({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const { result } = renderHook(() => useSaveObjects(7), { wrapper })
    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(showError).toHaveBeenCalledWith(
      "Couldn't save your changes. Please try again.",
    )
    expect(useCanvasStore.getState().items).toBe(items)
    expect(useCanvasStore.getState().dirty).toBe(true)
  })

  it('skips the toast for auth failures (the global interceptor owns those)', async () => {
    useCanvasStore.setState({ items: [], dirty: true })
    vi.spyOn(apiClient, 'put').mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: {} },
    })

    const { result } = renderHook(() => useSaveObjects(7), { wrapper })
    act(() => result.current.mutate())
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(showError).not.toHaveBeenCalled()
  })
})
