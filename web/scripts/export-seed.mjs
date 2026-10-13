// Copies the API's seed (built from Project/Dataset by `uv run python -m app.dataset`) into
// src/seed.json, which the app uses only when the API isn't running.
// Run: node scripts/export-seed.mjs
import { copyFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const from = fileURLToPath(new URL('../../api/seed/seed.json', import.meta.url))
const to = fileURLToPath(new URL('../src/seed.json', import.meta.url))
copyFileSync(from, to)
console.log(`copied ${from} → ${to} (${Math.round(statSync(to).size / 1024)} KB)`)
