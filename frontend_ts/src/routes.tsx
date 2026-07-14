import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import { RegisterPage } from './auth/RegisterPage'
import { VerifyEmailPage } from './auth/VerifyEmailPage'
import { LoginPage } from './auth/LoginPage'
import { ForgotPasswordPage } from './auth/ForgotPasswordPage'
import { ResetPasswordPage } from './auth/ResetPasswordPage'

/**
 * Placeholder for the canvas editor route (U7 replaces this with
 * `canvas/CanvasEditorPage.tsx`). Mounted at "/" — see LoginPage's
 * `CANVAS_ROUTE` constant, which must be kept in sync with this path.
 */
function CanvasPlaceholder() {
  return (
    <section>
      <h1>Canvas editor</h1>
      <p>The canvas editor will be built in U7.</p>
    </section>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:uid/:token" element={<ResetPasswordPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <CanvasPlaceholder />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
