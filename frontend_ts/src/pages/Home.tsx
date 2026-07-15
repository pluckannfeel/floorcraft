import React from "react";
import { useAuth } from "../auth/AuthContext";
import { CanvasEditorPage } from "../canvas/CanvasEditorPage";

const Home: React.FC = () => {
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  return (
    <React.Fragment>
      <div>
        <h3>Welcome, {user?.full_name || user?.email}!</h3>

        <button onClick={handleLogout}>Logout</button>
      </div>
      <CanvasEditorPage />
    </React.Fragment>
  );
};

export default Home;
