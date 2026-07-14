import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { VerifyEmailPage } from './VerifyEmailPage'
import { apiClient } from '../api/client'

function renderVerifyEmailPage(token: string) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/verify-email/${token}`]}>
        <Routes>
          <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows success for a valid token', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: { detail: 'Your email has been verified. You can now log in.' },
    })

    renderVerifyEmailPage('valid-token')

    await waitFor(() => {
      expect(screen.getByText(/email verified/i)).toBeInTheDocument()
    })
    expect(screen.getByText('Your email has been verified. You can now log in.')).toBeInTheDocument()
  })

  it('shows an error with a resend option for an expired/invalid token', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 400,
        data: { detail: 'This verification link has expired. Please request a new one.' },
      },
    })

    renderVerifyEmailPage('expired-token')

    await waitFor(() => {
      expect(screen.getByText(/verification failed/i)).toBeInTheDocument()
    })
    expect(screen.getByText('This verification link has expired. Please request a new one.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /resend verification email/i })).toBeInTheDocument()
  })
})
