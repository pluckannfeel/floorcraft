import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors vite.config.ts's "@" alias — vitest.config.ts takes precedence
    // over vite.config.ts, so the alias must be declared here too for tests
    // that exercise components importing via "@/".
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
