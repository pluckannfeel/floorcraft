import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir: "../", // Read the shared .env at the repo root instead of frontend_ts/
  server: {
    host: true, // Needed for Docker container port mapping (listens on 0.0.0.0)
    port: 5173,
    watch: {
      usePolling: true, // Needed for some Docker desktop volume implementations to catch file edits
    },
    hmr: {
      protocol: "wss", // Nginx now terminates TLS, so HMR websockets must upgrade over wss
      clientPort: 443, // Forces the browser to connect to Nginx (port 443) for WebSockets instead of 5173
    },
  },
});
