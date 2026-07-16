import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiClient } from '../api/client'
import { AuthCard, AuthLink } from './AuthCard'

const CONFIRMATION_MESSAGE = 'If an account with that email exists, a password reset email has been sent.'

/**
 * R7: password-reset request form. Shows the same generic confirmation
 * regardless of the API response (success or failure) — matching the
 * backend's non-enumeration design, which never reveals whether the email
 * is actually registered.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const mutation = useMutation({
    mutationFn: () => apiClient.post('/auth/password-reset/', { email }),
    onSettled: () => setSubmitted(true),
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate()
  }

  if (submitted) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-muted-foreground">{CONFIRMATION_MESSAGE}</p>
        <p className="text-sm">
          <AuthLink to="/login">Back to login</AuthLink>
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Forgot your password?">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
        <Button type="submit" disabled={mutation.isPending} className="w-full">
          {mutation.isPending ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      <p className="text-sm">
        <AuthLink to="/login">Back to login</AuthLink>
      </p>
    </AuthCard>
  )
}
