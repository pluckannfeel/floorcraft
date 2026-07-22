import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import * as ToastContextModule from '../notifications/ToastContext'
import { isEditableTarget } from './coordinates'
import type { FloorPlan } from './types'
import { ScaleUnitControl } from './ScaleUnitControl'

/**
 * U4 control suite. Same conventions as FloorPlanNameEditor.test.tsx:
 * `apiClient` + `useToast` mocked, QueryClientProvider with retries off. The
 * `Harness` mirrors how CanvasEditorPage feeds the control — the scale/unit
 * props come from the `['floorPlan', id]` query, so a successful PATCH's
 * `setQueryData` merge flows back into the control exactly like the real
 * page (relabeling live, AE2), and a failed PATCH (cache untouched) reverts.
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

function Harness({ floorPlanId }: { floorPlanId: number }) {
  const { data } = useQuery({
    queryKey: ['floorPlan', floorPlanId],
    queryFn: async () => {
      const { data } = await apiClient.get<FloorPlan>(`/floor-plans/${floorPlanId}/`)
      return data
    },
  })
  if (!data) return null
  return (
    <ScaleUnitControl
      floorPlanId={data.id}
      realSizePerGridSquare={data.real_size_per_grid_square}
      unit={data.unit}
    />
  )
}

function renderControl() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <Harness floorPlanId={7} />
    </QueryClientProvider>,
  )
  return queryClient
}

const showError = vi.fn()

beforeEach(() => {
  showError.mockClear()
  vi.spyOn(ToastContextModule, 'useToast').mockReturnValue({
    toasts: [],
    showError,
    dismiss: vi.fn(),
  })
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: makePlan() } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScaleUnitControl', () => {
  it('renders the persisted scale scalar and unit', async () => {
    renderControl()
    expect(await screen.findByLabelText('Meters per grid square')).toHaveValue(0.5)
    expect(screen.getByLabelText('Measurement unit')).toHaveValue('meters')
    // No feet hint while metric.
    expect(screen.queryByText(/^=/)).not.toBeInTheDocument()
  })

  it('editing the scale and pressing Enter PATCHes once and the value persists', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      data: makePlan({ real_size_per_grid_square: 1 }),
    } as never)

    const user = userEvent.setup()
    const queryClient = renderControl()
    const input = await screen.findByLabelText('Meters per grid square')

    await user.clear(input)
    await user.type(input, '1{Enter}')

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('/floor-plans/7/', { real_size_per_grid_square: 1 })
    await waitFor(() =>
      expect(
        queryClient.getQueryData<FloorPlan>(['floorPlan', 7])?.real_size_per_grid_square,
      ).toBe(1),
    )
    // The merged value flows back into the input.
    expect(await screen.findByLabelText('Meters per grid square')).toHaveValue(1)
  })

  it('blur commits like Enter', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      data: makePlan({ real_size_per_grid_square: 0.25 }),
    } as never)

    const user = userEvent.setup()
    renderControl()
    const input = await screen.findByLabelText('Meters per grid square')

    await user.clear(input)
    await user.type(input, '0.25')
    await user.tab() // blur

    expect(patchSpy).toHaveBeenCalledWith('/floor-plans/7/', { real_size_per_grid_square: 0.25 })
  })

  it('committing the unchanged scale is a no-op (no PATCH)', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch')

    const user = userEvent.setup()
    renderControl()
    const input = await screen.findByLabelText('Meters per grid square')

    // Re-commit the prefilled value untouched.
    await user.click(input)
    await user.keyboard('{Enter}')

    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('an invalid scale (zero / empty / negative) reverts without a PATCH', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch')

    const user = userEvent.setup()
    renderControl()
    const input = await screen.findByLabelText('Meters per grid square')

    // Zero is rejected by the same > 0 rule the backend enforces.
    await user.clear(input)
    await user.type(input, '0{Enter}')
    expect(patchSpy).not.toHaveBeenCalled()
    expect(input).toHaveValue(0.5) // reverted to persisted

    // Empty reverts too.
    await user.clear(input)
    await user.keyboard('{Enter}')
    expect(patchSpy).not.toHaveBeenCalled()
    expect(input).toHaveValue(0.5)

    // A negative value is rejected the same way.
    await user.clear(input)
    await user.type(input, '-1.5{Enter}')
    expect(patchSpy).not.toHaveBeenCalled()
    expect(input).toHaveValue(0.5)

    // A positive value BELOW the shared 0.0001 floor is caught client-side
    // (no round-trip to a server 400), matching the input's own `min`.
    await user.clear(input)
    await user.type(input, '0.00005{Enter}')
    expect(patchSpy).not.toHaveBeenCalled()
    expect(input).toHaveValue(0.5) // reverted to persisted
  })

  it('Escape reverts the draft and sends no PATCH', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch')

    const user = userEvent.setup()
    renderControl()
    const input = await screen.findByLabelText('Meters per grid square')

    await user.clear(input)
    await user.type(input, '3.3{Escape}')

    expect(patchSpy).not.toHaveBeenCalled()
    expect(input).toHaveValue(0.5)
  })

  it('switching the unit to feet-and-inches PATCHes and shows the architectural equivalent (AE2)', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      data: makePlan({ unit: 'feet_inches' }),
    } as never)

    const user = userEvent.setup()
    renderControl()
    const select = await screen.findByLabelText('Measurement unit')

    await user.selectOptions(select, 'feet_inches')

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('/floor-plans/7/', { unit: 'feet_inches' })
    // The cache-merged unit flows back; the 0.5 m scalar renders as its
    // architectural equivalent (0.5 m ≈ 1' 8"), proving canonical-meters
    // display conversion (not a rescale).
    expect(await screen.findByText(/^= \d+' \d+"$/)).toBeInTheDocument()
  })

  it('a failed scale PATCH reverts the input and raises an error toast', async () => {
    vi.spyOn(apiClient, 'patch').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const user = userEvent.setup()
    renderControl()
    const input = await screen.findByLabelText('Meters per grid square')

    await user.clear(input)
    await user.type(input, '2{Enter}')

    await waitFor(() => expect(showError).toHaveBeenCalledTimes(1))
    // Cache untouched → the input reverts to the persisted value.
    await waitFor(() => expect(input).toHaveValue(0.5))
  })

  it('shows a saving indicator while a PATCH is in flight', async () => {
    vi.spyOn(apiClient, 'patch').mockReturnValueOnce(new Promise(() => {}) as never)

    const user = userEvent.setup()
    renderControl()
    const select = await screen.findByLabelText('Measurement unit')

    await user.selectOptions(select, 'feet_inches')

    expect(await screen.findByRole('status')).toHaveTextContent(/saving/i)
  })

  it('optimistically shows the picked unit while the (non-optimistic) PATCH is in flight', async () => {
    // A never-resolving PATCH holds the mutation pending for the whole test.
    vi.spyOn(apiClient, 'patch').mockReturnValueOnce(new Promise(() => {}) as never)

    const user = userEvent.setup()
    renderControl()
    const select = await screen.findByLabelText('Measurement unit')

    await user.selectOptions(select, 'feet_inches')

    // Without the optimistic `displayUnit`, the controlled <select> would snap
    // back to 'meters' (the still-persisted value) for the whole round-trip.
    expect(select).toHaveValue('feet_inches')
    expect(screen.getByText(/^= \d+' \d+"$/)).toBeInTheDocument()
  })

  it('does NOT clobber an in-progress edit when a prior commit resolves mid-typing', async () => {
    // First commit (0.75) is controllable; resolve it only after the user has
    // re-focused and typed a new, uncommitted value.
    let resolveFirst: (v: unknown) => void = () => {}
    const patchSpy = vi.spyOn(apiClient, 'patch').mockImplementation(
      () => new Promise((resolve) => {
        resolveFirst = resolve
      }) as never,
    )

    const user = userEvent.setup()
    const queryClient = renderControl()
    const input = await screen.findByLabelText('Meters per grid square')

    // Commit 0.75 (PATCH fires, still pending), then re-focus and type 0.9.
    await user.clear(input)
    await user.type(input, '0.75{Enter}')
    expect(patchSpy).toHaveBeenCalledTimes(1)
    await user.click(input)
    await user.clear(input)
    await user.type(input, '0.9')
    expect(input).toHaveValue(0.9)

    // The 0.75 PATCH now resolves; its cache-merge moves the persisted prop
    // from 0.5 to 0.75, forcing a re-render with the new scale prop.
    resolveFirst({ data: makePlan({ real_size_per_grid_square: 0.75 }) })
    await waitFor(() =>
      expect(
        queryClient.getQueryData<FloorPlan>(['floorPlan', 7])?.real_size_per_grid_square,
      ).toBe(0.75),
    )
    // The render-time re-sync must NOT overwrite the FOCUSED draft: the input
    // still shows the user's uncommitted 0.9, not the newly-persisted 0.75.
    expect(input).toHaveValue(0.9)
  })

  it('the scale input and unit select are native editable targets the global shortcut guard skips', async () => {
    const user = userEvent.setup()
    renderControl()
    const input = await screen.findByLabelText('Meters per grid square')

    await user.click(input)
    // The focused element is an INPUT — isEditableTarget returns true, so the
    // global Enter-finalize / Delete handlers skip it: typing a scale value
    // and pressing Enter never finalizes/saves the canvas.
    expect(document.activeElement?.tagName).toBe('INPUT')
    expect(isEditableTarget(document.activeElement?.tagName, false)).toBe(true)

    const select = screen.getByLabelText('Measurement unit')
    expect(select.tagName).toBe('SELECT')
    expect(isEditableTarget(select.tagName, false)).toBe(true)
  })
})
