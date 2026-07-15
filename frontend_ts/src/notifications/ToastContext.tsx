import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

/**
 * U13/R17: a lightweight transient-toast mechanism — the plan's chosen error
 * surface for persistence failures ("a transient toast notification, not an
 * inline banner or modal ... multiple concurrent errors stack rather than
 * replace each other"). This is the first unit that needs any user-visible
 * error surfacing (prior units' failures were either impossible — read-only
 * queries — or handled inline on a form, e.g. `LoginPage.tsx`), so no such
 * mechanism existed yet to reuse.
 *
 * Deliberately minimal: a React Context holding an array of `{id, message}`
 * toasts, a `showError` action appending one (auto-dismissed after a fixed
 * delay), and a `dismiss` action for manual close. `ToastViewport.tsx`
 * renders the array; kept as a separate component so `useObjects.ts`'s
 * mutation hooks (which call `useToast().showError(...)` from inside
 * `onError`/`onSuccess` callbacks, not JSX) don't need to import any
 * rendering code.
 */

export interface Toast {
  id: string
  message: string
}

interface ToastContextValue {
  toasts: Toast[]
  showError: (message: string) => void
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)

/** How long an unacknowledged toast stays visible before auto-dismissing. */
const AUTO_DISMISS_MS = 6000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  // Tracks each toast's auto-dismiss timer so a manual `dismiss()` can clear
  // it (avoiding a stale timeout firing against an id that's already gone,
  // or double-removing if both fire).
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const showError = useCallback(
    (message: string) => {
      const id = crypto.randomUUID()
      // Appends (never replaces) — concurrent errors from independently
      // in-flight mutations (Key Technical Decisions) stack as separate
      // toasts rather than one clobbering another's message.
      setToasts((current) => [...current, { id, message }])
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
      timers.current.set(id, timer)
    },
    [dismiss],
  )

  const value = useMemo<ToastContextValue>(() => ({ toasts, showError, dismiss }), [toasts, showError, dismiss])

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

// Context + hook colocated in one file — same pattern as AuthContext.tsx's
// useAuth export.
// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return ctx
}
