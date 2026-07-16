import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { apiClient } from '../api/client'
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
      <section>
        <h1>Check your email</h1>
        <p>
          Registration successful. We&apos;ve sent a verification link to <strong>{email}</strong>.
          Please check your email to verify your account before logging in.
        </p>
        <p>
          <Link to="/login">Back to login</Link>
        </p>
      </section>
    )
  }

  const errors = mutation.isError ? flattenApiErrors(mutation.error, 'Registration failed. Please try again.') : []

  return (
    <section>
      <h1>Register</h1>
      <form onSubmit={handleSubmit}>
        {errors.length > 0 && (
          <div role="alert">
            {errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}

        <label htmlFor="full_name">Full name</label>
        <input
          id="full_name"
          name="full_name"
          type="text"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          required
        />

        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />

        <label htmlFor="contact_number">Contact number</label>
        <input
          id="contact_number"
          name="contact_number"
          type="tel"
          value={contactNumber}
          onChange={(event) => setContactNumber(event.target.value)}
        />

        <label htmlFor="country">Country</label>
        <input
          id="country"
          name="country"
          type="text"
          value={country}
          onChange={(event) => setCountry(event.target.value)}
        />

        <label htmlFor="job_title">Job title</label>
        <input
          id="job_title"
          name="job_title"
          type="text"
          value={jobTitle}
          onChange={(event) => setJobTitle(event.target.value)}
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
          {mutation.isPending ? 'Registering…' : 'Register'}
        </button>
      </form>
      <p>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </section>
  )
}
