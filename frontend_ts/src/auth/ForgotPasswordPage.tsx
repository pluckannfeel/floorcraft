import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { apiClient } from '../api/client'

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
      <section>
        <h1>Check your email</h1>
        <p>{CONFIRMATION_MESSAGE}</p>
        <p>
          <Link to="/login">Back to login</Link>
        </p>
      </section>
    )
  }

  return (
    <section>
      <h1>Forgot your password?</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
      <p>
        <Link to="/login">Back to login</Link>
      </p>
    </section>
  )
}
