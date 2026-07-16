import { useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from './AuthContext'
import { AuthCard, AuthFormError, AuthLink } from './AuthCard'
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
    <AuthCard title="Log in">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <AuthFormError messages={errors} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <Button type="submit" disabled={mutation.isPending} className="w-full">
          {mutation.isPending ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
      <p className="text-sm">
        <AuthLink to="/forgot-password">Forgot your password?</AuthLink>
      </p>
      <p className="text-sm text-muted-foreground">
        Don&apos;t have an account? <AuthLink to="/register">Register</AuthLink>
      </p>
    </AuthCard>
  )
}
