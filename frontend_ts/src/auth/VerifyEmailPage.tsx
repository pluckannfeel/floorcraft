import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { apiClient } from '../api/client'
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
      <section>
        <h1>Verifying your email…</h1>
        <p role="status">Please wait.</p>
      </section>
    )
  }

  if (verifyQuery.isSuccess) {
    return (
      <section>
        <h1>Email verified</h1>
        <p>{verifyQuery.data.data.detail}</p>
        <p>
          <Link to="/login">Log in</Link>
        </p>
      </section>
    )
  }

  const errorMessages = flattenApiErrors(
    verifyQuery.error,
    'This verification link is invalid or has expired.',
  )

  return (
    <section>
      <h1>Verification failed</h1>
      <div role="alert">
        {errorMessages.map((message) => (
          <p key={message}>{message}</p>
        ))}
      </div>

      <h2>Resend verification email</h2>
      {resendMutation.isSuccess ? (
        <p>If an account with that email exists and needs verification, a new verification email has been sent.</p>
      ) : (
        <form onSubmit={handleResend}>
          <label htmlFor="resend-email">Email</label>
          <input
            id="resend-email"
            name="resend-email"
            type="email"
            value={resendEmail}
            onChange={(event) => setResendEmail(event.target.value)}
            required
          />
          <button type="submit" disabled={resendMutation.isPending}>
            {resendMutation.isPending ? 'Sending…' : 'Resend verification email'}
          </button>
        </form>
      )}
      <p>
        <Link to="/login">Back to login</Link>
      </p>
    </section>
  )
}
