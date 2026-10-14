import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // VITE_API_URL can come from the environment or from web/.env.production (the hosted API on Render).
  const apiUrl = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL
  return {
    plugins: [react(), tailwindcss()],
    // The FastAPI backend (Project/api) runs on :8000 — see Project/api/README.md.
    server: { proxy: { '/api': 'http://localhost:8000' } },
    // On Vercel without an API address there is no API to call: build the hosted demo (sample data only).
    define: process.env.VERCEL && !apiUrl ? { 'import.meta.env.VITE_HOSTED_DEMO': JSON.stringify('1') } : {},
  }
})
