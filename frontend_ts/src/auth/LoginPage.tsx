import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { useAuth } from './AuthContext'
import { flattenApiErrors } from './apiErrors'

// Canvas route: "/" for now (U7 hasn't landed yet). If U7 ends up mounting
// the canvas editor at a different path, update this constant and
// routes.tsx's placeholder route together.
const CANVAS_ROUTE = '/'

interface LocationState {
  from?: { pathname: string }
}

/**
 * R6: login form. Per Key Technical Decisions, the backend intentionally
 * returns the SAME generic error for wrong-password, unverified, and
 * nonexistent-user cases to avoid enumeration — so this page shows exactly
 * one generic error message from the API response and does not attempt to
 * distinguish "unverified" from any other failure.
 */
export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const mutation = useMutation({
    mutationFn: () => login(email, password),
    onSuccess: () => {
      const state = location.state as LocationState | null
      const redirectTo = state?.from?.pathname ?? CANVAS_ROUTE
      navigate(redirectTo, { replace: true })
    },
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate()
  }

  const errors = mutation.isError
    ? flattenApiErrors(mutation.error, 'Unable to log in with the provided credentials.')
    : []

  return (
    <section>
      <h1>Log in</h1>
      <form onSubmit={handleSubmit}>
        {errors.length > 0 && (
          <div role="alert">
            {errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}

        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p>
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      <p>
        Don&apos;t have an account? <Link to="/register">Register</Link>
      </p>
    </section>
  )
}
