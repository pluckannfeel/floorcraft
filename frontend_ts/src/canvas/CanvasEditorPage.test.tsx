import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import * as AuthContextModule from '../auth/AuthContext'
import * as ToastContextModule from '../notifications/ToastContext'
import { undo, useCanvasStore } from '../state/canvasStore'
import type { CanvasObject, FloorPlan } from './types'
import { CanvasEditorPage } from './CanvasEditorPage'

/**
 * U5 test suite: the editor is driven by the `/floor-plans/:floorPlanId`
 * route param (the hardcoded default floor-plan-id constant is gone).
 *
 * Conventions follow the established patterns:
 * - `apiClient` mocked via `vi.spyOn(apiClient, ...)` (useObjects.test.tsx /
 *   FloorPlanDashboard.test.tsx).
 * - `useAuth`/`useToast` mocked via `vi.spyOn` on their modules
 *   (LoginPage.test.tsx / useObjects.test.tsx) — no real providers needed.
 * - QueryClientProvider + MemoryRouter with retries disabled by default
 *   (FloorPlanDashboard.test.tsx); a placeholder route stands in for the
 *   dashboard so the not-found state's link target can be asserted.
 *
 * `CanvasStage` is stubbed below: it mounts a real Konva `Stage`, which
 * needs a real `<canvas>` 2D context that jsdom cannot provide (the same
 * limitation ShapeTool.test.tsx / SelectionTransformer.test.tsx document —
 * no test in this codebase mounts a Konva component). Everything else the
 * page composes (Toolbar/Sidebar/PropertyPanel, the queries, the store
 * seeding, the route-state branches) is real and exercised here.
 */
vi.mock('./CanvasStage', () => ({
  CanvasStage: () => <div data-testid="canvas-stage" />,
}))

function makePlan(overrides: Partial<FloorPlan> = {}): FloorPlan {
  return {
    id: 1,
    name: 'Office layout',
    grid_size: 20,
    canvas_width: 1600,
    canvas_height: 1200,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-10T15:30:00Z',
    ...overrides,
  }
}

function makeObject(overrides: Partial<CanvasObject> = {}): CanvasObject {
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

interface PlanFixture {
  plan: FloorPlan
  objects: CanvasObject[]
}

/** Dispatches mocked GETs by URL: `/floor-plans/<id>/` resolves the
 * fixture's plan (or rejects with an axios-shaped 404 when no fixture
 * exists — mirroring U2's ownership scoping), `/objects/` resolves the
 * fixture's objects for the requested `floor_plan` param. */
function mockGetForPlans(fixtures: Record<number, PlanFixture>) {
  return vi.spyOn(apiClient, 'get').mockImplementation(((
    url: string,
    config?: { params?: { floor_plan?: number } },
  ) => {
    const planMatch = /^\/floor-plans\/(\d+)\/$/.exec(url)
    if (planMatch) {
      const fixture = fixtures[Number(planMatch[1])]
      if (!fixture) {
        return Promise.reject({
          isAxiosError: true,
          response: { status: 404, data: {} },
        })
      }
      return Promise.resolve({ data: fixture.plan })
    }
    if (url === '/objects/') {
      const fixture = fixtures[config?.params?.floor_plan ?? -1]
      return Promise.resolve({ data: fixture?.objects ?? [] })
    }
    return Promise.reject(new Error(`Unexpected GET ${url}`))
  }) as never)
}

/** Captures react-router's `navigate` so tests can move between two plans'
 * editor routes without unmounting the router (a real in-app navigation —
 * the same Route element stays mounted and only the param changes). */
const navigateRef: { current: ReturnType<typeof useNavigate> | null } = {
  current: null,
}

function CaptureNavigate() {
  const navigate = useNavigate()
  useEffect(() => {
    navigateRef.current = navigate
  }, [navigate])
  return null
}

function renderEditor(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <CaptureNavigate />
        <Routes>
          <Route path="/floor-plans" element={<div>Dashboard Placeholder</div>} />
          <Route path="/floor-plans/:floorPlanId" element={<CanvasEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  return { ...result, queryClient }
}

const logout = vi.fn()

beforeEach(() => {
  useCanvasStore.setState({ items: [], selectedItemId: null, activeTool: 'select' })
  useCanvasStore.temporal.getState().clear()
  navigateRef.current = null
  logout.mockClear()
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    user: { id: 1, email: 'ada@example.com' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout,
  })
  vi.spyOn(ToastContextModule, 'useToast').mockReturnValue({
    toasts: [],
    showError: vi.fn(),
    dismiss: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CanvasEditorPage (route-driven floor plan, U5)', () => {
  it("loads the ROUTE param's floor plan and objects — not a hardcoded id", async () => {
    const getSpy = mockGetForPlans({
      7: {
        plan: makePlan({ id: 7, name: 'Route Plan Seven' }),
        objects: [makeObject({ id: 701, floor_plan: 7 })],
      },
    })

    renderEditor('/floor-plans/7')

    expect(await screen.findByText('Route Plan Seven')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-stage')).toBeInTheDocument()

    // Both fetches target the route's id...
    expect(getSpy).toHaveBeenCalledWith('/floor-plans/7/')
    expect(getSpy).toHaveBeenCalledWith('/objects/', { params: { floor_plan: 7 } })
    // ...and nothing requested the previously hardcoded plan 1.
    expect(getSpy).not.toHaveBeenCalledWith('/floor-plans/1/')
    expect(getSpy).not.toHaveBeenCalledWith('/objects/', { params: { floor_plan: 1 } })

    // The store is seeded with THAT plan's objects.
    await waitFor(() =>
      expect(useCanvasStore.getState().items).toEqual([
        expect.objectContaining({ id: 701, floor_plan: 7 }),
      ]),
    )
  })

  it('a 404 floor plan shows the not-found state with a dashboard link — no crash, no logout, no retry loop', async () => {
    // No fixtures: every floor-plan GET rejects with an axios-shaped 404,
    // exactly what U2's ownership scoping returns for a foreign or
    // nonexistent id (R14).
    const getSpy = mockGetForPlans({})

    renderEditor('/floor-plans/9')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/floor plan not found/i)
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      '/floor-plans',
    )

    // A 404 is definitive — exactly one request, no retry loop.
    const planCalls = getSpy.mock.calls.filter(([url]) => url === '/floor-plans/9/')
    expect(planCalls).toHaveLength(1)

    // The ownership 404 must not masquerade as a session failure (R14's
    // whole point: 404, not 403, so no logout path is triggered).
    expect(logout).not.toHaveBeenCalled()
  })

  it('a malformed :floorPlanId renders the not-found state without firing any request', async () => {
    const getSpy = mockGetForPlans({})

    renderEditor('/floor-plans/not-a-number')

    expect(await screen.findByRole('alert')).toHaveTextContent(/floor plan not found/i)
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      '/floor-plans',
    )
    // A param that can never match a backend row fires no garbage requests.
    expect(getSpy).not.toHaveBeenCalled()
  })

  it("navigating from plan A's editor to plan B's shows B's data and does not leak A's undo history", async () => {
    mockGetForPlans({
      1: {
        plan: makePlan({ id: 1, name: 'Plan A' }),
        objects: [makeObject({ id: 101, floor_plan: 1 })],
      },
      2: {
        plan: makePlan({ id: 2, name: 'Plan B' }),
        objects: [makeObject({ id: 202, floor_plan: 2, x: 77 })],
      },
    })

    renderEditor('/floor-plans/1')

    expect(await screen.findByText('Plan A')).toBeInTheDocument()
    await waitFor(() =>
      expect(useCanvasStore.getState().items).toEqual([
        expect.objectContaining({ id: 101, floor_plan: 1 }),
      ]),
    )

    // A tracked user action on plan A pushes a real undo history entry.
    act(() => {
      useCanvasStore.getState().updateItemGeometry(101, { x: 500 })
    })
    expect(useCanvasStore.temporal.getState().pastStates.length).toBeGreaterThan(0)

    // In-app navigation to plan B: the same Route element stays mounted,
    // only the :floorPlanId param changes — the hardest variant of the
    // plan-switch (nothing remounts to reset state for free).
    act(() => {
      navigateRef.current?.('/floor-plans/2')
    })

    expect(await screen.findByText('Plan B')).toBeInTheDocument()
    await waitFor(() =>
      expect(useCanvasStore.getState().items).toEqual([
        expect.objectContaining({ id: 202, floor_plan: 2 }),
      ]),
    )

    // Plan A's undo stack must not apply onto plan B's canvas: the
    // floorPlanId-keyed effect cleared zundo's history on the switch.
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
    expect(useCanvasStore.temporal.getState().futureStates).toHaveLength(0)
  })

  it('undo does not bounce through the stale cache while its refetch is in flight (jitter regression)', async () => {
    // Reproduces the visual "shake" on undo: the store shows the undone
    // state instantly, the undo's PATCH settles (isMutating drops to 0)
    // and invalidates — but the query cache still holds the PRE-undo
    // snapshot until the refetch returns. An isMutating-only gate lets the
    // resync effect fire in that window and briefly snap objects back to
    // their pre-undo positions before the fresh data lands. The fix also
    // gates on isFetching.
    const initialObjects = [makeObject({ id: 701, floor_plan: 7, x: 200 })]
    const movedObjects = [makeObject({ id: 701, floor_plan: 7, x: 300 })]
    let releaseRefetch: ((value: { data: CanvasObject[] }) => void) | null = null

    let objectsCall = 0
    vi.spyOn(apiClient, 'get').mockImplementation(((url: string) => {
      if (url === '/floor-plans/7/') {
        return Promise.resolve({ data: makePlan({ id: 7, name: 'Jitter Plan' }) })
      }
      if (url === '/objects/') {
        objectsCall += 1
        if (objectsCall === 1) return Promise.resolve({ data: initialObjects })
        if (objectsCall === 2) return Promise.resolve({ data: movedObjects })
        // Third call: the post-undo refetch — held pending so the test can
        // assert the store's state inside the stale-cache window.
        return new Promise((resolve) => {
          releaseRefetch = resolve
        })
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`))
    }) as never)
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValue({
      data: makeObject({ id: 701, floor_plan: 7, x: 200 }),
    } as never)

    const { queryClient } = renderEditor('/floor-plans/7')

    expect(await screen.findByText('Jitter Plan')).toBeInTheDocument()
    await waitFor(() =>
      expect(useCanvasStore.getState().items[0]).toEqual(expect.objectContaining({ x: 200 })),
    )

    // A tracked move (x: 200 → 300), then a resync that refreshes the
    // cache to the moved state — mirroring the real flow where the move's
    // own PATCH already invalidated and refetched.
    act(() => {
      useCanvasStore.getState().updateItemGeometry(701, { x: 300 })
    })
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['objects', 7] })
    })
    await waitFor(() =>
      expect(useCanvasStore.getState().items[0]).toEqual(expect.objectContaining({ x: 300 })),
    )

    // Undo: the store snaps back to x=200 immediately and dispatches the
    // PATCH persisting it.
    act(() => {
      undo()
    })
    expect(useCanvasStore.getState().items[0]).toEqual(expect.objectContaining({ x: 200 }))

    // Wait until the PATCH settled and its invalidation kicked off the
    // (held-pending) refetch — this is exactly the stale-cache window.
    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    await waitFor(() => expect(releaseRefetch).not.toBeNull())
    await act(async () => {})

    // THE regression assertion: inside the window the store must still
    // show the undone position, not the cache's stale pre-undo x=300.
    expect(useCanvasStore.getState().items[0]).toEqual(expect.objectContaining({ x: 200 }))

    // Releasing the refetch lands the fresh post-undo server state.
    act(() => {
      releaseRefetch!({ data: [makeObject({ id: 701, floor_plan: 7, x: 200 })] })
    })
    await waitFor(() =>
      expect(useCanvasStore.getState().items[0]).toEqual(expect.objectContaining({ x: 200 })),
    )
  })
})
