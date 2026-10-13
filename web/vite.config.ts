import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The FastAPI backend (Project/api) runs on :8000 — see Project/api/README.md.
  server: { proxy: { '/api': 'http://localhost:8000' } },
})
