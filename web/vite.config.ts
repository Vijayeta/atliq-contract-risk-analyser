import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The FastAPI backend (Project/api) runs on :8000 — see Project/api/README.md.
  server: { proxy: { '/api': 'http://localhost:8000' } },
  // On Vercel without VITE_API_URL there is no API to call: build the hosted demo (sample data only).
  // With VITE_API_URL set (the hosted API on Render), the web app talks to that API instead.
  define: process.env.VERCEL && !process.env.VITE_API_URL ? { 'import.meta.env.VITE_HOSTED_DEMO': JSON.stringify('1') } : {},
})
