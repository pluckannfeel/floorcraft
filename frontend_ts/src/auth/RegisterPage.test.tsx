import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RegisterPage } from './RegisterPage'
import { apiClient } from '../api/client'

function renderRegisterPage() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RegisterPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, email: string) {
  await user.type(screen.getByLabelText('Full name'), 'Ada Lovelace')
  await user.type(screen.getByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), 'a-strong-password-123')
  await user.click(screen.getByRole('button', { name: /register/i }))
}

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a "check your email" confirmation on valid registration', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
      data: { detail: 'Registration successful. Please check your email to verify your account.' },
    })
    const user = userEvent.setup()
    renderRegisterPage()

    await fillAndSubmit(user, 'ada@example.com')

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /check your email/i })).toBeInTheDocument()
    })
    expect(screen.getByText(/ada@example\.com/)).toBeInTheDocument()
  })

  it('shows the API rejection message when the email is already in use by a verified account', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 400,
        data: { email: ['An account with this email already exists.'] },
      },
    })
    const user = userEvent.setup()
    renderRegisterPage()

    await fillAndSubmit(user, 'existing@example.com')

    await waitFor(() => {
      expect(screen.getByText('An account with this email already exists.')).toBeInTheDocument()
    })
    expect(screen.queryByText(/check your email/i)).not.toBeInTheDocument()
  })
})
