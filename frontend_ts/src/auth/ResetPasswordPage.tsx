import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiClient } from '../api/client'
import { AuthCard, AuthFormError, AuthLink } from './AuthCard'
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
      <AuthCard title="Password reset">
        <p className="text-sm text-muted-foreground">
          Your password has been reset. You can now log in.
        </p>
        <p className="text-sm">
          <AuthLink to="/login">Log in</AuthLink>
        </p>
      </AuthCard>
    )
  }

  const errors = mutation.isError
    ? flattenApiErrors(mutation.error, 'This password reset link is invalid or has expired.')
    : []

  return (
    <AuthCard title="Reset your password">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <AuthFormError messages={errors} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="new_password">New password</Label>
          <Input
            id="new_password"
            name="new_password"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
          />
        </div>

        <Button type="submit" disabled={mutation.isPending} className="w-full">
          {mutation.isPending ? 'Resetting…' : 'Reset password'}
        </Button>
      </form>
      <p className="text-sm">
        <AuthLink to="/login">Back to login</AuthLink>
      </p>
    </AuthCard>
  )
}
