import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import { flattenApiErrors } from './apiErrors'

/**
 * R7: reads uid/token from the URL (matching the backend's
 * password-reset-confirm/ payload shape: `uid`, `token`, `new_password`)
 * and submits a new password. Shows success + a link to login, or an error
 * for expired/invalid tokens/weak passwords.
 */
export function ResetPasswordPage() {
  const { uid, token } = useParams<{ uid: string; token: string }>()
  const [newPassword, setNewPassword] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      apiClient.post('/auth/password-reset-confirm/', {
        uid,
        token,
        new_password: newPassword,
      }),
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate()
  }

  if (mutation.isSuccess) {
    return (
      <section>
        <h1>Password reset</h1>
        <p>Your password has been reset. You can now log in.</p>
        <p>
          <Link to="/login">Log in</Link>
        </p>
      </section>
    )
  }

  const errors = mutation.isError
    ? flattenApiErrors(mutation.error, 'This password reset link is invalid or has expired.')
    : []

  return (
    <section>
      <h1>Reset your password</h1>
      <form onSubmit={handleSubmit}>
        {errors.length > 0 && (
          <div role="alert">
            {errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}

        <label htmlFor="new_password">New password</label>
        <input
          id="new_password"
          name="new_password"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />

        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Resetting…' : 'Reset password'}
        </button>
      </form>
      <p>
        <Link to="/login">Back to login</Link>
      </p>
    </section>
  )
}
