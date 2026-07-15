import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth/RequireAuth";
import { RegisterPage } from "./auth/RegisterPage";
import { VerifyEmailPage } from "./auth/VerifyEmailPage";
import { LoginPage } from "./auth/LoginPage";
import { ForgotPasswordPage } from "./auth/ForgotPasswordPage";
import { ResetPasswordPage } from "./auth/ResetPasswordPage";
import Home from "./pages/Home";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route
        path="/reset-password/:uid/:token"
        element={<ResetPasswordPage />}
      />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Home />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
