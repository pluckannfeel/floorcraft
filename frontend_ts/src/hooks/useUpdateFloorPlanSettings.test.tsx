import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import * as ToastContextModule from '../notifications/ToastContext'
import type { FloorPlan } from '../canvas/types'
import { useUpdateFloorPlanSettings } from './useFloorPlans'

/**
 * U4 hook suite. Same conventions as useObjects.test.tsx: `apiClient` mocked
 * via `vi.spyOn`, `useToast` mocked so no ToastProvider is needed,
 * QueryClientProvider wrapper with retries off. The hook mirrors
 * `useRenameFloorPlan` — a not-optimistic PATCH whose success MERGES the
 * response into `['floorPlan', id]` (so the page relabels the rulers live)
 * and invalidates the dashboard list; failure leaves the cache untouched.
 */

function makePlan(overrides: Partial<FloorPlan> = {}): FloorPlan {
  return {
    id: 7,
    name: 'Office layout',
    grid_size: 20,
    canvas_width: 1600,
    canvas_height: 1200,
    real_size_per_grid_square: 0.5,
    unit: 'meters' as const,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-10T15:30:00Z',
    ...overrides,
  }
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

const showError = vi.fn()

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
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

describe('useUpdateFloorPlanSettings', () => {
  it('PATCHes the scale and MERGES the response into the cached plan (AE2)', async () => {
    // Seed the cache the way the page holds it, with fields the PATCH
    // response won't echo (created_at) — the merge must preserve them.
    queryClient.setQueryData<FloorPlan>(['floorPlan', 7], makePlan())
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      data: makePlan({ real_size_per_grid_square: 1 }),
    } as never)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useUpdateFloorPlanSettings(7), { wrapper })
    result.current.mutate({ real_size_per_grid_square: 1 })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(patchSpy).toHaveBeenCalledWith('/floor-plans/7/', { real_size_per_grid_square: 1 })

    const cached = queryClient.getQueryData<FloorPlan>(['floorPlan', 7])
    expect(cached?.real_size_per_grid_square).toBe(1)
    expect(cached?.created_at).toBe('2026-07-01T10:00:00Z') // merge preserved it
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['floorPlans'] })
  })

  it('PATCHes a unit change on its own field', async () => {
    queryClient.setQueryData<FloorPlan>(['floorPlan', 7], makePlan())
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      data: makePlan({ unit: 'feet_inches' }),
    } as never)

    const { result } = renderHook(() => useUpdateFloorPlanSettings(7), { wrapper })
    result.current.mutate({ unit: 'feet_inches' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // Only the unit field is sent — the scale value the user didn't touch
    // is left for the server to keep (canonical size unchanged, AE2).
    expect(patchSpy).toHaveBeenCalledWith('/floor-plans/7/', { unit: 'feet_inches' })
    expect(queryClient.getQueryData<FloorPlan>(['floorPlan', 7])?.unit).toBe('feet_inches')
  })

  it('a failed PATCH surfaces an error toast and does NOT corrupt the cached plan', async () => {
    queryClient.setQueryData<FloorPlan>(['floorPlan', 7], makePlan())
    vi.spyOn(apiClient, 'patch').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const { result } = renderHook(() => useUpdateFloorPlanSettings(7), { wrapper })
    result.current.mutate({ real_size_per_grid_square: 99 })

    await waitFor(() => expect(showError).toHaveBeenCalledTimes(1))
    // The cache was never touched — the previous scale survives intact.
    expect(queryClient.getQueryData<FloorPlan>(['floorPlan', 7])?.real_size_per_grid_square).toBe(
      0.5,
    )
  })

  it('skips the generic toast on an auth error (the global interceptor owns it)', async () => {
    queryClient.setQueryData<FloorPlan>(['floorPlan', 7], makePlan())
    vi.spyOn(apiClient, 'patch').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 401, data: {} },
    })

    const { result } = renderHook(() => useUpdateFloorPlanSettings(7), { wrapper })
    result.current.mutate({ unit: 'feet_inches' })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(showError).not.toHaveBeenCalled()
  })
})
