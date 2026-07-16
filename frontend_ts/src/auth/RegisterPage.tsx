import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiClient } from '../api/client'
import { AuthCard, AuthFormError, AuthLink } from './AuthCard'
import { flattenApiErrors } from './apiErrors'

interface RegisterPayload {
  full_name: string
  email: string
  contact_number: string
  country: string
  job_title: string
  password: string
}

/**
 * R1/R3/R4: registration form. On success, shows a "check your email"
 * confirmation in place rather than auto-navigating away (there is nothing
 * to navigate to yet — the account can't log in until it's verified).
 */
export function RegisterPage() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [country, setCountry] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [password, setPassword] = useState('')

  const mutation = useMutation({
    mutationFn: (payload: RegisterPayload) => apiClient.post('/auth/register/', payload),
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.mutate({
      full_name: fullName,
      email,
      contact_number: contactNumber,
      country,
      job_title: jobTitle,
      password,
    })
  }

  if (mutation.isSuccess) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-muted-foreground">
          Registration successful. We&apos;ve sent a verification link to{' '}
          <strong className="font-medium text-foreground">{email}</strong>. Please check your
          email to verify your account before logging in.
        </p>
        <p className="text-sm">
          <AuthLink to="/login">Back to login</AuthLink>
        </p>
      </AuthCard>
    )
  }

  const errors = mutation.isError ? flattenApiErrors(mutation.error, 'Registration failed. Please try again.') : []

  return (
    <AuthCard title="Register">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <AuthFormError messages={errors} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="full_name">Full name</Label>
          <Input
            id="full_name"
            name="full_name"
            type="text"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            required
          />
        </div>

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
          <Label htmlFor="contact_number">Contact number</Label>
          <Input
            id="contact_number"
            name="contact_number"
            type="tel"
            value={contactNumber}
            onChange={(event) => setContactNumber(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="country">Country</Label>
          <Input
            id="country"
            name="country"
            type="text"
            value={country}
            onChange={(event) => setCountry(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="job_title">Job title</Label>
          <Input
            id="job_title"
            name="job_title"
            type="text"
            value={jobTitle}
            onChange={(event) => setJobTitle(event.target.value)}
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
          {mutation.isPending ? 'Registering…' : 'Register'}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Already have an account? <AuthLink to="/login">Log in</AuthLink>
      </p>
    </AuthCard>
  )
}
