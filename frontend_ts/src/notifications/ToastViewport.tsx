import { useToast } from './ToastContext'

/**
 * Renders the current stack of toasts (U13/R17) in a fixed corner overlay.
 * Mounted once near the app root (`main.tsx`) so it's available regardless
 * of which route/component triggered the error (canvas mutations, but
 * nothing stops future units from calling `useToast().showError(...)` from
 * elsewhere).
 */
export function ToastViewport() {
  const { toasts, dismiss } = useToast()

  if (toasts.length === 0) return null

  return (
    <div
      role="region"
      aria-label="Notifications"
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 1000,
        maxWidth: 360,
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            background: '#dc2626',
            color: '#ffffff',
            padding: '10px 12px',
            borderRadius: 6,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
            fontSize: 13,
          }}
        >
          <span style={{ flex: 1 }}>{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(toast.id)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#ffffff',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
