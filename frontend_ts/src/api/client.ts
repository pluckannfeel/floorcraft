import axios from 'axios'

/**
 * Single shared axios instance for all API calls.
 *
 * The stack is genuinely same-origin (Nginx-fronted in both dev and prod, see
 * vite.config.ts), so we use Django session auth + CSRF rather than JWT:
 * - `withCredentials: true` sends the httpOnly session cookie on every request.
 * - `xsrfCookieName`/`xsrfHeaderName` make axios automatically read the
 *   (non-httpOnly) `csrftoken` cookie and echo it back as `X-CSRFToken` on
 *   unsafe methods, satisfying Django's CsrfViewMiddleware.
 */
export const apiClient = axios.create({
  baseURL: '/api',
  withCredentials: true,
  xsrfCookieName: 'csrftoken',
  xsrfHeaderName: 'X-CSRFToken',
})

/**
 * Module-level callback AuthContext registers on mount so the response
 * interceptor below can clear auth state without importing React context
 * machinery into a plain axios module (and without a circular import between
 * api/client.ts and auth/AuthContext.tsx).
 */
let onAuthFailure: (() => void) | null = null

export function registerAuthFailureHandler(handler: (() => void) | null): void {
  onAuthFailure = handler
}

// R30: a 401/403 during canvas use (expired session or stale CSRF token)
// triggers a redirect to login, distinct from the per-mutation revert-and-toast
// handling of other failures (R17).
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status
    if (status === 401 || status === 403) {
      onAuthFailure?.()
    }
    return Promise.reject(error)
  },
)
