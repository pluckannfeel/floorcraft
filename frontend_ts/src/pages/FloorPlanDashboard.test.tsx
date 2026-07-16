import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import * as ToastContextModule from '../notifications/ToastContext'
import type { FloorPlan } from '../canvas/types'
import { DEFAULT_FLOOR_PLAN_NAME } from '../hooks/useFloorPlans'
import { FloorPlanDashboard } from './FloorPlanDashboard'

/**
 * U4 test suite. Follows the established conventions:
 * - `apiClient` is mocked directly via `vi.spyOn(apiClient, ...)`
 *   (useObjects.test.tsx / RegisterPage.test.tsx pattern).
 * - `useToast` is mocked via `vi.spyOn(ToastContextModule, 'useToast')`
 *   (useObjects.test.tsx pattern) so no real ToastProvider is needed —
 *   assertions run against the mocked `showError`.
 * - QueryClientProvider + MemoryRouter wrappers with retries disabled
 *   (LoginPage.test.tsx pattern); a placeholder route stands in for the
 *   editor so navigation can be asserted without mounting Konva.
 */

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

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/floor-plans']}>
        <Routes>
          <Route path="/floor-plans" element={<FloorPlanDashboard />} />
          <Route path="/floor-plans/:floorPlanId" element={<div>Editor Placeholder</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const showError = vi.fn()

beforeEach(() => {
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

describe('FloorPlanDashboard', () => {
  it('lists all of the user\'s floor plans (AE2)', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: [
        makePlan({ id: 1, name: 'Office layout' }),
        makePlan({ id: 2, name: 'Warehouse floor' }),
      ],
    } as never)

    renderDashboard()

    expect(await screen.findByText('Office layout')).toBeInTheDocument()
    expect(screen.getByText('Warehouse floor')).toBeInTheDocument()
    // Each card links to its own editor route (R6/R7).
    expect(screen.getByRole('link', { name: /office layout/i })).toHaveAttribute(
      'href',
      '/floor-plans/1',
    )
    expect(screen.getByRole('link', { name: /warehouse floor/i })).toHaveAttribute(
      'href',
      '/floor-plans/2',
    )
  })

  it('clicking "Create new" POSTs the default payload and navigates to the new plan\'s editor route (AE2)', async () => {
    // Not `...Once`: onSettled's ['floorPlans'] invalidation fires before
    // the navigation unmounts the dashboard, so the list refetches once.
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: [makePlan({ id: 1 })],
    } as never)
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: makePlan({ id: 42, name: DEFAULT_FLOOR_PLAN_NAME }),
    } as never)

    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('Office layout')

    await user.click(screen.getByRole('button', { name: /create new/i }))

    await waitFor(() => {
      expect(screen.getByText('Editor Placeholder')).toBeInTheDocument()
    })
    expect(postSpy).toHaveBeenCalledTimes(1)
    expect(postSpy).toHaveBeenCalledWith('/floor-plans/', {
      name: DEFAULT_FLOOR_PLAN_NAME,
    })
  })

  it('zero plans renders the empty state (not an error, no auto-create), still surfacing Create', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: [] } as never)
    const postSpy = vi.spyOn(apiClient, 'post')

    renderDashboard()

    expect(await screen.findByText('No floor plans yet')).toBeInTheDocument()
    // Distinct from the error state...
    expect(screen.queryByText(/couldn't load your floor plans/i)).not.toBeInTheDocument()
    // ...no plan was auto-created...
    expect(postSpy).not.toHaveBeenCalled()
    // ...and the Create action is still available.
    expect(screen.getAllByRole('button', { name: /create new/i }).length).toBeGreaterThan(0)
  })

  it('double-clicking "Create new" fires only one POST (button disabled while pending)', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: [makePlan({ id: 1 })],
    } as never)
    // A never-resolving POST keeps the mutation in-flight for the whole
    // test, so the second click of the double-click lands while pending.
    const postSpy = vi
      .spyOn(apiClient, 'post')
      .mockReturnValueOnce(new Promise(() => {}) as never)

    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('Office layout')

    await user.dblClick(screen.getByRole('button', { name: /creat/i }))

    expect(postSpy).toHaveBeenCalledTimes(1)
    // The pending state is user-visible: the button is disabled.
    expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled()
  })

  it('a failed list query renders a distinct error state with a retry affordance, not the empty state', async () => {
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 500, data: {} },
      })
      .mockResolvedValueOnce({ data: [makePlan({ id: 1 })] } as never)

    const user = userEvent.setup()
    renderDashboard()

    expect(await screen.findByText(/couldn't load your floor plans/i)).toBeInTheDocument()
    // NOT the zero-plans empty state copy.
    expect(screen.queryByText('No floor plans yet')).not.toBeInTheDocument()

    // The retry affordance refetches and recovers.
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByText('Office layout')).toBeInTheDocument()
    expect(getSpy).toHaveBeenCalledTimes(2)
  })

  it('a failed create stays on the dashboard with an error toast and no navigation', async () => {
    // Not `...Once`: the mutation's onSettled invalidates ['floorPlans']
    // while the dashboard is still mounted, so the list refetches — that
    // refetch must also resolve from the mock.
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: [makePlan({ id: 1 })],
    } as never)
    vi.spyOn(apiClient, 'post').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const user = userEvent.setup()
    renderDashboard()
    await screen.findByText('Office layout')

    await user.click(screen.getByRole('button', { name: /create new/i }))

    await waitFor(() => expect(showError).toHaveBeenCalledTimes(1))
    // Still on the dashboard: no navigation to the editor route, the list
    // is still rendered, and the Create button is re-enabled for a retry.
    expect(screen.queryByText('Editor Placeholder')).not.toBeInTheDocument()
    expect(screen.getByText('Office layout')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create new/i })).toBeEnabled()
  })
})
