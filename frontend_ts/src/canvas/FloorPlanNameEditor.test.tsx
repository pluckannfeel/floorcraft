import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import * as ToastContextModule from '../notifications/ToastContext'
import type { FloorPlan } from './types'
import { FloorPlanNameEditor } from './FloorPlanNameEditor'

/**
 * U6 test suite. Follows the established conventions:
 * - `apiClient` mocked via `vi.spyOn(apiClient, ...)`
 *   (FloorPlanDashboard.test.tsx / useObjects.test.tsx pattern).
 * - `useToast` mocked via `vi.spyOn(ToastContextModule, 'useToast')` so no
 *   real ToastProvider is needed.
 * - QueryClientProvider wrapper with retries disabled.
 *
 * The `Harness` mirrors how CanvasEditorPage actually feeds the component:
 * `name` comes from the `['floorPlan', id]` query's cached data, so a
 * successful rename's `setQueryData` flows back into the label exactly like
 * in the real page — and a failed rename (cache untouched) reverts it.
 */

function makePlan(overrides: Partial<FloorPlan> = {}): FloorPlan {
  return {
    id: 7,
    name: 'Office layout',
    grid_size: 20,
    canvas_width: 1600,
    canvas_height: 1200,
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
  return <FloorPlanNameEditor floorPlanId={data.id} name={data.name} />
}

function renderEditor() {
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

describe('FloorPlanNameEditor', () => {
  it('click name → edit → Enter PATCHes the new name and the label shows it', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      data: makePlan({ name: 'HQ layout' }),
    } as never)

    const user = userEvent.setup()
    const queryClient = renderEditor()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    // Clicking the name itself enters edit mode, prefilled with the
    // current name.
    await user.click(await screen.findByRole('button', { name: 'Office layout' }))
    const input = screen.getByRole('textbox', { name: /floor plan name/i })
    expect(input).toHaveValue('Office layout')

    await user.clear(input)
    await user.type(input, 'HQ layout{Enter}')

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('/floor-plans/7/', { name: 'HQ layout' })

    // Edit mode exited; once the PATCH resolves, the label reflects the
    // new name via the updated ['floorPlan', 7] cache...
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'HQ layout' })).toBeInTheDocument()
    await waitFor(() =>
      expect(queryClient.getQueryData<FloorPlan>(['floorPlan', 7])?.name).toBe('HQ layout'),
    )
    // ...and the dashboard list was invalidated so it reflects the rename.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['floorPlans'] }),
    )
  })

  it('the pencil button also enters edit mode', async () => {
    const user = userEvent.setup()
    renderEditor()
    await screen.findByRole('button', { name: 'Office layout' })

    await user.click(screen.getByRole('button', { name: 'Rename floor plan' }))

    expect(screen.getByRole('textbox', { name: /floor plan name/i })).toHaveValue(
      'Office layout',
    )
  })

  it('blur commits like Enter', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch').mockResolvedValueOnce({
      data: makePlan({ name: 'Blurred name' }),
    } as never)

    const user = userEvent.setup()
    renderEditor()

    await user.click(await screen.findByRole('button', { name: 'Office layout' }))
    const input = screen.getByRole('textbox', { name: /floor plan name/i })
    await user.clear(input)
    await user.type(input, 'Blurred name')
    await user.tab() // move focus away → blur

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('/floor-plans/7/', { name: 'Blurred name' })
    expect(await screen.findByRole('button', { name: 'Blurred name' })).toBeInTheDocument()
  })

  it('Escape reverts to the pre-edit name and sends no PATCH', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch')

    const user = userEvent.setup()
    renderEditor()

    await user.click(await screen.findByRole('button', { name: 'Office layout' }))
    const input = screen.getByRole('textbox', { name: /floor plan name/i })
    await user.clear(input)
    await user.type(input, 'Discarded name{Escape}')

    expect(patchSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Office layout' })).toBeInTheDocument()
  })

  it('an empty or whitespace-only name falls back to the previous name without a PATCH', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch')

    const user = userEvent.setup()
    renderEditor()

    // Fully empty.
    await user.click(await screen.findByRole('button', { name: 'Office layout' }))
    await user.clear(screen.getByRole('textbox', { name: /floor plan name/i }))
    await user.keyboard('{Enter}')
    expect(patchSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Office layout' })).toBeInTheDocument()

    // Whitespace-only.
    await user.click(screen.getByRole('button', { name: 'Office layout' }))
    const input = screen.getByRole('textbox', { name: /floor plan name/i })
    await user.clear(input)
    await user.type(input, '   {Enter}')
    expect(patchSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Office layout' })).toBeInTheDocument()
  })

  it('a failed PATCH reverts the label and shows an error toast', async () => {
    vi.spyOn(apiClient, 'patch').mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const user = userEvent.setup()
    renderEditor()

    await user.click(await screen.findByRole('button', { name: 'Office layout' }))
    const input = screen.getByRole('textbox', { name: /floor plan name/i })
    await user.clear(input)
    await user.type(input, 'Doomed name{Enter}')

    await waitFor(() => expect(showError).toHaveBeenCalledTimes(1))
    // The cache was never touched, so the label reverted to the previous
    // name and the rejected name is gone.
    expect(screen.getByRole('button', { name: 'Office layout' })).toBeInTheDocument()
    expect(screen.queryByText('Doomed name')).not.toBeInTheDocument()
    // Controls re-enabled for another attempt.
    expect(screen.getByRole('button', { name: 'Rename floor plan' })).toBeEnabled()
  })

  it('committing the unchanged name exits edit mode without a PATCH', async () => {
    const patchSpy = vi.spyOn(apiClient, 'patch')

    const user = userEvent.setup()
    renderEditor()

    await user.click(await screen.findByRole('button', { name: 'Office layout' }))
    // The input is autofocused and prefilled — commit it untouched.
    await user.keyboard('{Enter}')

    expect(patchSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Office layout' })).toBeInTheDocument()
  })

  it('while the PATCH is pending, a saving indicator shows and edit mode cannot be re-entered', async () => {
    // A never-resolving PATCH keeps the rename in flight for the whole test.
    const patchSpy = vi
      .spyOn(apiClient, 'patch')
      .mockReturnValueOnce(new Promise(() => {}) as never)

    const user = userEvent.setup()
    renderEditor()

    await user.click(await screen.findByRole('button', { name: 'Office layout' }))
    const input = screen.getByRole('textbox', { name: /floor plan name/i })
    await user.clear(input)
    await user.type(input, 'Slow name{Enter}')

    expect(patchSpy).toHaveBeenCalledTimes(1)
    // The pending state is user-visible: saving indicator, optimistic
    // label with the submitted name, both entry points disabled.
    expect(await screen.findByRole('status')).toHaveTextContent(/saving/i)
    expect(screen.getByRole('button', { name: 'Slow name' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Rename floor plan' })).toBeDisabled()

    // Neither the label nor the pencil re-opens the input while pending,
    // and no second PATCH can be issued.
    await user.click(screen.getByRole('button', { name: 'Slow name' }))
    await user.click(screen.getByRole('button', { name: 'Rename floor plan' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(patchSpy).toHaveBeenCalledTimes(1)
  })
})
