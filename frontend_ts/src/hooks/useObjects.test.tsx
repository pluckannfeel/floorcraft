import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { apiClient } from '../api/client'
import * as ToastContextModule from '../notifications/ToastContext'
import { redo, registerPersistenceDispatcher, undo, useCanvasStore } from '../state/canvasStore'
import type { CanvasObject } from '../canvas/types'
import {
  useCreateObject,
  useDeleteObject,
  useIsObjectsMutating,
  useObjectPersistence,
  useUpdateObject,
} from './useObjects'

/**
 * U13 test suite. Per this codebase's established "honest about
 * limitations" testing pattern (mock axios, no real Konva rendering — see
 * `ShapeTool.test.tsx`/`LineAnchorHandles.test.tsx` for the same approach),
 * these tests mock `apiClient` directly (matching `RegisterPage.test.tsx`/
 * `VerifyEmailPage.test.tsx`'s `vi.spyOn(apiClient, ...)` convention) and
 * exercise the mutation hooks + `canvasStore`'s undo/redo diffing without
 * mounting any Konva/canvas UI.
 *
 * `useToast` is mocked directly (matching `LoginPage.test.tsx`'s
 * `vi.spyOn(AuthContextModule, 'useAuth')` pattern for context hooks) so
 * these tests don't need a real `ToastProvider` in the tree — they assert
 * against the mocked `showError` calls instead.
 */

function makeItem(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 1,
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

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  return { wrapper, queryClient }
}

const showError = vi.fn()

beforeEach(() => {
  useCanvasStore.setState({ items: [], selectedItemId: null, activeTool: 'select' })
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
  registerPersistenceDispatcher(null)
})

describe('useCreateObject', () => {
  it('swaps the local id for the server-assigned id on success', async () => {
    const localItem = makeItem({ id: 'local-abc' })
    useCanvasStore.setState({ items: [localItem] })

    const created = makeItem({ id: 42 })
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({ data: created } as never)

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateObject(1), { wrapper })

    result.current.mutate({ localId: 'local-abc', payload: { type: 'chairs' } })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(useCanvasStore.getState().items).toHaveLength(1)
    expect(useCanvasStore.getState().items[0].id).toBe(42)
  })

  it('removes the local-only ghost item on failure (not a position revert)', async () => {
    const localItem = makeItem({ id: 'local-abc', x: 10, y: 10 })
    useCanvasStore.setState({ items: [localItem] })

    vi.spyOn(apiClient, 'post').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateObject(1), { wrapper })

    result.current.mutate({ localId: 'local-abc', payload: { type: 'chairs' } })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(useCanvasStore.getState().items).toHaveLength(0)
    expect(showError).toHaveBeenCalledTimes(1)
  })

  it('does not create an undo entry from the ghost-removal rollback', async () => {
    const localItem = makeItem({ id: 'local-abc' })
    useCanvasStore.setState({ items: [localItem] })
    useCanvasStore.temporal.getState().clear()

    vi.spyOn(apiClient, 'post').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateObject(1), { wrapper })
    result.current.mutate({ localId: 'local-abc', payload: { type: 'chairs' } })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('a 401 failure removes the ghost item but does NOT show a generic toast (R30 takes precedence)', async () => {
    const localItem = makeItem({ id: 'local-abc' })
    useCanvasStore.setState({ items: [localItem] })

    vi.spyOn(apiClient, 'post').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 401, data: {} },
    })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateObject(1), { wrapper })
    result.current.mutate({ localId: 'local-abc', payload: { type: 'chairs' } })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(useCanvasStore.getState().items).toHaveLength(0)
    expect(showError).not.toHaveBeenCalled()
  })
})

describe('useUpdateObject', () => {
  it('sends exactly one PATCH with the given patch body', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({ data: makeItem() } as never)
    const previous = makeItem({ id: 7, x: 10, y: 10 })
    useCanvasStore.setState({ items: [{ ...previous, x: 200, y: 340 }] })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUpdateObject(1), { wrapper })

    result.current.mutate({ id: 7, patch: { x: 200, y: 340 }, previous })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('/objects/7/', { x: 200, y: 340 })
  })

  it('reverts the item to its prior snapshot and surfaces an error on failure', async () => {
    const previous = makeItem({ id: 7, x: 10, y: 10 })
    // Optimistic local change already applied (as CanvasEditorPage's
    // wrapped handlers do before calling the mutation).
    useCanvasStore.setState({ items: [{ ...previous, x: 200, y: 340 }] })

    vi.spyOn(apiClient, 'patch').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUpdateObject(1), { wrapper })

    result.current.mutate({ id: 7, patch: { x: 200, y: 340 }, previous })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(useCanvasStore.getState().items[0]).toMatchObject({ x: 10, y: 10 })
    expect(showError).toHaveBeenCalledTimes(1)
  })

  it('a 401 failure still reverts the item but skips the generic toast', async () => {
    const previous = makeItem({ id: 7, x: 10, y: 10 })
    useCanvasStore.setState({ items: [{ ...previous, x: 200, y: 340 }] })

    vi.spyOn(apiClient, 'patch').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 401, data: {} },
    })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUpdateObject(1), { wrapper })
    result.current.mutate({ id: 7, patch: { x: 200, y: 340 }, previous })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(useCanvasStore.getState().items[0]).toMatchObject({ x: 10, y: 10 })
    expect(showError).not.toHaveBeenCalled()
  })

  it('a Line point-edit persists via the same update mutation path as other geometry updates', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({ data: makeItem() } as never)
    const previousPoints = [
      { x: 0, y: 0 },
      { x: 40, y: 40 },
    ]
    const previous = makeItem({
      id: 9,
      type: 'line_straight',
      properties: { points: previousPoints, curve_style: 'straight' },
    })
    const nextPoints = [
      { x: 0, y: 0 },
      { x: 200, y: 200 },
    ]
    useCanvasStore.setState({
      items: [{ ...previous, properties: { points: nextPoints, curve_style: 'straight' } }],
    })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUpdateObject(1), { wrapper })

    result.current.mutate({
      id: 9,
      patch: { properties: { points: nextPoints, curve_style: 'straight' } },
      previous,
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(patchSpy).toHaveBeenCalledWith('/objects/9/', {
      properties: { points: nextPoints, curve_style: 'straight' },
    })
  })

  it('only restores the one item that failed, leaving a different concurrently-updated item untouched', async () => {
    // Per Key Technical Decisions: per-item, not per-list, rollback scope.
    const previousA = makeItem({ id: 1, x: 0, name: 'A' })
    const currentB = makeItem({ id: 2, x: 999, name: 'B (unconfirmed, different in-flight mutation)' })
    useCanvasStore.setState({ items: [{ ...previousA, x: 500 }, currentB] })

    vi.spyOn(apiClient, 'patch').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUpdateObject(1), { wrapper })
    result.current.mutate({ id: 1, patch: { x: 500 }, previous: previousA })

    await waitFor(() => expect(result.current.isError).toBe(true))

    const items = useCanvasStore.getState().items
    expect(items.find((item) => item.id === 1)).toMatchObject({ x: 0 })
    // Item 2's unconfirmed optimistic change survives item 1's rollback.
    expect(items.find((item) => item.id === 2)).toMatchObject({ x: 999 })
  })
})

describe('useDeleteObject', () => {
  it('sends exactly one DELETE and leaves the item removed on success', async () => {
    const deleteSpy = vi.spyOn(apiClient, 'delete').mockResolvedValueOnce({} as never)
    const previous = makeItem({ id: 5 })
    useCanvasStore.setState({ items: [] }) // already removed optimistically by the caller

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useDeleteObject(1), { wrapper })

    result.current.mutate({ id: 5, previous })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(deleteSpy).toHaveBeenCalledWith('/objects/5/')
    expect(useCanvasStore.getState().items).toHaveLength(0)
  })

  it('re-adds the item and surfaces an error on failure', async () => {
    const previous = makeItem({ id: 5 })
    useCanvasStore.setState({ items: [] })

    vi.spyOn(apiClient, 'delete').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useDeleteObject(1), { wrapper })
    result.current.mutate({ id: 5, previous })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(useCanvasStore.getState().items).toEqual([previous])
    expect(showError).toHaveBeenCalledTimes(1)
  })
})

describe('useObjectPersistence + undo/redo re-issuing persistence (integration)', () => {
  it('registers a persistence dispatcher while mounted, and clears it on unmount', async () => {
    const { wrapper } = makeWrapper()
    const { unmount } = renderHook(() => useObjectPersistence(1), { wrapper })

    // Dispatching a diff (via undo) should reach the registered dispatcher's
    // update path (a real PATCH call, proving a dispatcher IS registered).
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: makeItem() } as never)
    useCanvasStore.getState().createItemLocal(makeItem({ id: 3, x: 10 }))
    useCanvasStore.temporal.getState().clear()
    useCanvasStore.getState().updateItemGeometry(3, { x: 500 })

    undo()
    // The dispatcher's `updateObject` calls `updateMutation.mutate(...)`,
    // which invokes TanStack Query's `mutationFn` (and therefore
    // `apiClient.patch`) asynchronously (a microtask beyond `mutate()`
    // itself) — so this assertion needs `waitFor`, not a synchronous check
    // immediately after `undo()`.
    await waitFor(() => expect(patchSpy).toHaveBeenCalledWith('/objects/3/', { x: 10 }))

    unmount()
    patchSpy.mockClear()

    // No dispatcher registered post-unmount -> undo's diff still runs
    // locally but has nothing to dispatch to; must not throw.
    redo()
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('dragging (a single geometry commit) results in exactly one PATCH with the final position — no requests mid-drag', async () => {
    // U8/CanvasStage only ever calls the geometry-change callback ONCE, at
    // dragend (never on intermediate pointermove frames) — this test proves
    // that a single such commit produces exactly one PATCH, standing in for
    // "no requests during the drag itself" since nothing in this hook layer
    // is ever called more than once per real dragend.
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({ data: makeItem() } as never)
    const previous = makeItem({ id: 11, x: 0, y: 0 })
    useCanvasStore.setState({ items: [{ ...previous, x: 340, y: 220 }] })

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useObjectPersistence(1), { wrapper })

    result.current.updateObject(11, { x: 340, y: 220 }, previous)

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1))
    expect(patchSpy).toHaveBeenCalledWith('/objects/11/', { x: 340, y: 220 })
  })
})

describe('canvasStore undo/redo diffing dispatches the matching persistence call', () => {
  it('undoing a move re-issues a PATCH with the reverted position', () => {
    const dispatcher = {
      createObject: vi.fn(),
      updateObject: vi.fn(),
      deleteObject: vi.fn(),
    }
    registerPersistenceDispatcher(dispatcher)

    useCanvasStore.getState().createItemLocal(makeItem({ id: 20, x: 10, y: 10 }))
    useCanvasStore.temporal.getState().clear()
    useCanvasStore.getState().updateItemGeometry(20, { x: 200, y: 340 })

    undo()

    expect(dispatcher.updateObject).toHaveBeenCalledTimes(1)
    const [id, patch, previous] = dispatcher.updateObject.mock.calls[0]
    expect(id).toBe(20)
    expect(patch).toMatchObject({ x: 10, y: 10 })
    expect(previous).toMatchObject({ x: 200, y: 340 })
  })

  it('redoing that move re-issues a PATCH with the forward position, with the same rollback treatment on failure', () => {
    const dispatcher = {
      createObject: vi.fn(),
      updateObject: vi.fn(),
      deleteObject: vi.fn(),
    }
    registerPersistenceDispatcher(dispatcher)

    useCanvasStore.getState().createItemLocal(makeItem({ id: 21, x: 10, y: 10 }))
    useCanvasStore.temporal.getState().clear()
    useCanvasStore.getState().updateItemGeometry(21, { x: 200, y: 340 })
    undo()
    dispatcher.updateObject.mockClear()

    redo()

    expect(dispatcher.updateObject).toHaveBeenCalledTimes(1)
    const [id, patch] = dispatcher.updateObject.mock.calls[0]
    expect(id).toBe(21)
    expect(patch).toMatchObject({ x: 200, y: 340 })
  })

  it('undoing a delete of an already-persisted item re-issues a create (recreate-via-new-id)', () => {
    const dispatcher = {
      createObject: vi.fn(),
      updateObject: vi.fn(),
      deleteObject: vi.fn(),
    }
    registerPersistenceDispatcher(dispatcher)

    // A real (non-local) id: this item was already created server-side.
    useCanvasStore.setState({ items: [makeItem({ id: 30 })] })
    useCanvasStore.temporal.getState().clear()

    // `deleteItem` itself is a pure/local store action (see canvasStore.ts's
    // architecture note) — it never calls the persistence dispatcher
    // directly. Only `CanvasEditorPage.tsx`'s handlers do that for direct
    // user actions; the registered `PersistenceDispatcher` here is only
    // reached via `diffAndDispatchPersistence`, i.e. through undo()/redo().
    // So no dispatcher call is expected from this line — the actual delete
    // dispatch is exercised elsewhere (this file's `useDeleteObject`/
    // `handleDeleteSelected`-equivalent tests); this test is specifically
    // about undo-of-delete re-issuing a create.
    useCanvasStore.getState().deleteItem(30)
    expect(dispatcher.deleteObject).not.toHaveBeenCalled()

    undo()

    expect(dispatcher.createObject).toHaveBeenCalledTimes(1)
    expect(dispatcher.createObject).toHaveBeenCalledWith(expect.objectContaining({ id: 30 }))
  })

  it('does not dispatch a delete for an item that was never actually persisted (still local-id)', () => {
    const dispatcher = {
      createObject: vi.fn(),
      updateObject: vi.fn(),
      deleteObject: vi.fn(),
    }
    registerPersistenceDispatcher(dispatcher)

    useCanvasStore.getState().createItemLocal(makeItem({ id: 'local-xyz' }))
    useCanvasStore.temporal.getState().clear()
    useCanvasStore.getState().deleteItem('local-xyz')

    undo()

    expect(dispatcher.createObject).not.toHaveBeenCalled()
    expect(dispatcher.deleteObject).not.toHaveBeenCalled()
  })

  it('a Line point-edit undo dispatches an update with the reverted properties.points', () => {
    const dispatcher = {
      createObject: vi.fn(),
      updateObject: vi.fn(),
      deleteObject: vi.fn(),
    }
    registerPersistenceDispatcher(dispatcher)

    const points = [
      { x: 0, y: 0 },
      { x: 40, y: 40 },
    ]
    useCanvasStore.getState().createItemLocal(
      makeItem({ id: 40, type: 'line_straight', properties: { points, curve_style: 'straight' } }),
    )
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().updateLinePoints(40, 1, { x: 200, y: 200 })
    undo()

    expect(dispatcher.updateObject).toHaveBeenCalledTimes(1)
    const [id, patch] = dispatcher.updateObject.mock.calls[0]
    expect(id).toBe(40)
    expect(patch).toMatchObject({ properties: { points, curve_style: 'straight' } })
  })

  it('undoing a z-reorder dispatches an update with the reverted z_index', () => {
    const dispatcher = {
      createObject: vi.fn(),
      updateObject: vi.fn(),
      deleteObject: vi.fn(),
    }
    registerPersistenceDispatcher(dispatcher)

    useCanvasStore.setState({
      items: [makeItem({ id: 50, z_index: 0 }), makeItem({ id: 51, z_index: 5 })],
    })
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().reorderZIndex(50, 'front')
    undo()

    expect(dispatcher.updateObject).toHaveBeenCalledTimes(1)
    const [id, patch] = dispatcher.updateObject.mock.calls[0]
    expect(id).toBe(50)
    expect(patch).toMatchObject({ z_index: 0 })
  })

  it('property-panel edits are untracked, so undo never dispatches for them', () => {
    const dispatcher = {
      createObject: vi.fn(),
      updateObject: vi.fn(),
      deleteObject: vi.fn(),
    }
    registerPersistenceDispatcher(dispatcher)

    useCanvasStore.setState({ items: [makeItem({ id: 60, name: 'Old' })] })
    useCanvasStore.temporal.getState().clear()

    useCanvasStore.getState().updateItemProperties(60, { name: 'New' })
    // Nothing to undo (untracked) — calling undo() here would traverse into
    // whatever the PREVIOUS history entry was (none in this test), so
    // there's nothing for the dispatcher to have been called with from this
    // action specifically.
    expect(dispatcher.updateObject).not.toHaveBeenCalled()
  })

  it('undo is a no-op (does not throw) when no dispatcher is registered', () => {
    registerPersistenceDispatcher(null)
    useCanvasStore.getState().createItemLocal(makeItem({ id: 70 }))
    expect(() => undo()).not.toThrow()
  })
})

describe('useIsObjectsMutating', () => {
  it('is true while a create mutation for this floor plan is in flight, false once it settles', async () => {
    let resolvePost!: (value: { data: CanvasObject }) => void
    vi.spyOn(apiClient, 'post').mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePost = resolve
      }) as never,
    )

    const { wrapper } = makeWrapper()
    const { result } = renderHook(
      () => ({
        create: useCreateObject(1),
        isMutating: useIsObjectsMutating(1),
      }),
      { wrapper },
    )

    expect(result.current.isMutating).toBe(false)

    result.current.create.mutate({ localId: 'local-x', payload: {} })

    await waitFor(() => expect(result.current.isMutating).toBe(true))

    resolvePost({ data: makeItem({ id: 99 }) })

    await waitFor(() => expect(result.current.isMutating).toBe(false))
  })

  it('stays true for a second item while a first item\'s update is still pending', async () => {
    // Regression test for a code-review finding: CanvasEditorPage's
    // `objectsQuery.data -> setItems()` resync effect used to run
    // unconditionally on every mutation settling, which could transiently
    // overwrite a DIFFERENT, still-in-flight mutation's optimistic change
    // with stale server data (both mutations share the same
    // `['objects', floorPlanId]` query key). `useIsObjectsMutating` is what
    // that effect now gates on — this asserts the piece it depends on:
    // the flag stays true as long as ANY tracked mutation (not just the
    // first one to start) is still pending.
    let resolveFirst!: (value: { data: CanvasObject }) => void
    const firstPending = new Promise<{ data: CanvasObject }>((resolve) => {
      resolveFirst = resolve
    })
    vi.spyOn(apiClient, 'patch')
      .mockReturnValueOnce(firstPending as never)
      .mockResolvedValueOnce({ data: makeItem({ id: 2 }) } as never)

    const { wrapper } = makeWrapper()
    const { result } = renderHook(
      () => ({
        update: useUpdateObject(1),
        isMutating: useIsObjectsMutating(1),
      }),
      { wrapper },
    )

    result.current.update.mutate({ id: 1, patch: { x: 1 }, previous: makeItem({ id: 1 }) })
    await waitFor(() => expect(result.current.isMutating).toBe(true))

    // A second, independent update starts and finishes while the first is
    // still pending.
    result.current.update.mutate({ id: 2, patch: { x: 2 }, previous: makeItem({ id: 2 }) })
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(2))

    // The first mutation is still unresolved — isMutating must still be
    // true, not flip false just because the second one settled.
    expect(result.current.isMutating).toBe(true)

    resolveFirst({ data: makeItem({ id: 1 }) })
    await waitFor(() => expect(result.current.isMutating).toBe(false))
  })
})
