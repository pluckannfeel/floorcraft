import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import * as ToastContextModule from '../notifications/ToastContext'
import { undo, useCanvasStore } from '../state/canvasStore'
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
    selectedItemId: null,
    activeTool: 'select',
    dirty: false,
    serverIdMap: {},
  })
  useCanvasStore.temporal.getState().clear()
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
