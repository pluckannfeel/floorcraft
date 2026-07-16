import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth/RequireAuth";
import { RegisterPage } from "./auth/RegisterPage";
import { VerifyEmailPage } from "./auth/VerifyEmailPage";
import { LoginPage } from "./auth/LoginPage";
import { ForgotPasswordPage } from "./auth/ForgotPasswordPage";
import { ResetPasswordPage } from "./auth/ResetPasswordPage";
import { FloorPlanDashboard } from "./pages/FloorPlanDashboard";
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
      {/* U4/R4: the dashboard is the post-login landing page. */}
      <Route
        path="/floor-plans"
        element={
          <RequireAuth>
            <FloorPlanDashboard />
          </RequireAuth>
        }
      />
      {/* U4/R7: per-plan editor route. Home still renders the hardcoded
          editor for now — U5 wires :floorPlanId into it. */}
      <Route
        path="/floor-plans/:floorPlanId"
        element={
          <RequireAuth>
            <Home />
          </RequireAuth>
        }
      />
      <Route path="/" element={<Navigate to="/floor-plans" replace />} />
      <Route path="*" element={<Navigate to="/floor-plans" replace />} />
    </Routes>
  );
}
