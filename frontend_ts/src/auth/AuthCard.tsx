import type { ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

/**
 * U7/R11: shared centered-card layout for the auth pages (login, register,
 * verify email, forgot/reset password) so the flow reads as one coherent
 * set. The title renders as an <h1> so existing
 * `getByRole('heading', ...)` queries keep working.
 */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-10">
      <section className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <h1 className="text-xl leading-none font-semibold tracking-tight">{title}</h1>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">{children}</CardContent>
        </Card>
      </section>
    </main>
  )
}

/**
 * Destructive-styled error block for API failures. Renders nothing when
 * there are no messages, preserving each page's previous
 * `errors.length > 0 && <div role="alert">…` behavior.
 */
export function AuthFormError({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  )
}

/** Consistently styled in-card link (e.g. "Back to login"). */
export function AuthLink(props: LinkProps) {
  return (
    <Link
      {...props}
      className="font-medium text-primary underline-offset-4 hover:underline"
    />
  )
}
