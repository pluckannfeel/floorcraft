import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { RequireAuth } from './RequireAuth'
import * as AuthContextModule from './AuthContext'

function renderWithAuth(authValue: Partial<ReturnType<typeof AuthContextModule.useAuth>>) {
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    ...authValue,
  })

  return render(
    <MemoryRouter initialEntries={['/canvas']}>
      <Routes>
        <Route
          path="/canvas"
          element={
            <RequireAuth>
              <div>Protected Content</div>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RequireAuth', () => {
  it('renders children when authenticated', () => {
    renderWithAuth({ isAuthenticated: true, isLoading: false, user: { id: 1, email: 'a@b.com' } })

    expect(screen.getByText('Protected Content')).toBeInTheDocument()
  })

  it('shows a loading state while the boot-time auth check is in flight', () => {
    renderWithAuth({ isAuthenticated: false, isLoading: true })

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
  })

  it('redirects to /login when unauthenticated', () => {
    renderWithAuth({ isAuthenticated: false, isLoading: false })

    expect(screen.getByText('Login Page')).toBeInTheDocument()
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
  })
})
