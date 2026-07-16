import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiClient } from '../api/client'
import { AuthCard, AuthFormError, AuthLink } from './AuthCard'
import { flattenApiErrors } from './apiErrors'

/**
 * R4/R5: reads the verification token from the URL, verifies on mount, and
 * shows success/error state. The backend treats an already-used/reused
 * token as an idempotent success (not an error), so "already verified" is
 * naturally covered by the success branch. A resend action is available
 * from the error state for expired/invalid tokens.
 */
export function VerifyEmailPage() {
  const { token } = useParams<{ token: string }>()
  const [resendEmail, setResendEmail] = useState('')

  const verifyQuery = useQuery({
    queryKey: ['verify-email', token],
    queryFn: () => apiClient.get<{ detail: string }>(`/auth/verify-email/${token}/`),
    enabled: Boolean(token),
    retry: false,
  })

  const resendMutation = useMutation({
    mutationFn: (email: string) => apiClient.post('/auth/resend-verification/', { email }),
  })

  function handleResend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    resendMutation.mutate(resendEmail)
  }

  if (verifyQuery.isPending) {
    return (
      <AuthCard title="Verifying your email…">
        <p role="status" className="text-sm text-muted-foreground">
          Please wait.
        </p>
      </AuthCard>
    )
  }

  if (verifyQuery.isSuccess) {
    return (
      <AuthCard title="Email verified">
        <p className="text-sm text-muted-foreground">{verifyQuery.data.data.detail}</p>
        <p className="text-sm">
          <AuthLink to="/login">Log in</AuthLink>
        </p>
      </AuthCard>
    )
  }

  const errorMessages = flattenApiErrors(
    verifyQuery.error,
    'This verification link is invalid or has expired.',
  )

  return (
    <AuthCard title="Verification failed">
      <AuthFormError messages={errorMessages} />

      <h2 className="mt-2 text-base leading-none font-semibold">Resend verification email</h2>
      {resendMutation.isSuccess ? (
        <p className="text-sm text-muted-foreground">
          If an account with that email exists and needs verification, a new verification email
          has been sent.
        </p>
      ) : (
        <form onSubmit={handleResend} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="resend-email">Email</Label>
            <Input
              id="resend-email"
              name="resend-email"
              type="email"
              value={resendEmail}
              onChange={(event) => setResendEmail(event.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={resendMutation.isPending} className="w-full">
            {resendMutation.isPending ? 'Sending…' : 'Resend verification email'}
          </Button>
        </form>
      )}
      <p className="text-sm">
        <AuthLink to="/login">Back to login</AuthLink>
      </p>
    </AuthCard>
  )
}
