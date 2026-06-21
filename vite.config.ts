import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  // Entry index.html lives at repo root; default outDir is repo-root dist/ which is wrong.
  // Build the SPA into web/dist so the server can serve it as a single origin (spec §7).
  build: {
    outDir: 'web/dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    fs: { allow: ['.'] },
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
