import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LoginPage } from './LoginPage'
import * as AuthContextModule from './AuthContext'

function renderLoginPage(login: (email: string, password: string) => Promise<void>) {
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login,
    logout: vi.fn(),
  })

  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/floor-plans" element={<div>Canvas Placeholder</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'ada@example.com')
  await user.type(screen.getByLabelText('Password'), 'correct-password')
  await user.click(screen.getByRole('button', { name: /log in/i }))
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('redirects to the canvas route on valid login', async () => {
    const login = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderLoginPage(login)

    await fillAndSubmit(user)

    await waitFor(() => {
      expect(screen.getByText('Canvas Placeholder')).toBeInTheDocument()
    })
    expect(login).toHaveBeenCalledWith('ada@example.com', 'correct-password')
  })

  it('shows the generic error message on bad credentials, without revealing why', async () => {
    const login = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: { detail: 'Unable to log in with the provided credentials.' },
      },
    })
    const user = userEvent.setup()
    renderLoginPage(login)

    await fillAndSubmit(user)

    await waitFor(() => {
      expect(screen.getByText('Unable to log in with the provided credentials.')).toBeInTheDocument()
    })
    expect(screen.queryByText('Canvas Placeholder')).not.toBeInTheDocument()
  })
})
