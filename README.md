# AtliQ Contract Risk Analyzer

**Live app: [atliq-contract-risk-analyser.vercel.app](https://atliq-contract-risk-analyser.vercel.app/)** · API: [atliq-api.onrender.com](https://atliq-api.onrender.com/api/health)

> **The full app is hosted, on three free services:** the web app on Vercel, the API on Render, and the data on Supabase. Uploads, reviews and decisions are saved. Things to know:
> - **The API sleeps when idle.** The first visit after a quiet spell can take about a minute while Render wakes it up; the app says so and offers Retry.
> - **The API isn't on Vercel** because it needs a lasting database and long-running review jobs, and Vercel runs Python as short-lived functions (the database would be wiped, reviews cut off, uploads capped at 4.5 MB).
> - **Claude is on in the hosted version** (Claude Haiku 5.5 alongside the rules engine). A review with Claude takes about a minute. Keep a monthly spend limit on the API key (Claude Console → Settings → Billing → Spend limits); if it's reached, reviews fall back to the free rules engine until the next month.
> - **Anyone with the link can use it.** There's no real sign-in; "Viewing as" picks the user. Sample data can be restored with a reset (see [Configuration](#configuration)).

A contract review assistant for AtliQ Technologies. Upload a contract and it reads every clause, flags risk with the exact quote behind each finding, checks the AtliQ legal entity, and catches clashes with promises AtliQ has already signed (non-competes, best-price clauses, exclusivity). People make every decision; the app never signs, approves or sends anything.

Built as a capstone demo: a FastAPI backend (SQLite locally, Postgres on Supabase when hosted) and a React web app. It runs for free on a deterministic rules engine, and can add Claude for a second opinion when an Anthropic API key is set.

## What it does

- **Reviews contracts** in PDF, Word (.docx), Markdown and plain text, up to about 100 pages
- **Flags issues by severity**, each with a verified quote from the contract, why it matters, and suggested wording based on AtliQ precedent
- **Checks the legal entity**: US clients contract with AtliQ Inc, everyone else with AtliQ Technologies Pvt Ltd
- **Finds cross-contract conflicts** against an obligation register built from AtliQ's signed contracts
- **Blocks "Ready to sign"** while high-severity findings, live conflicts, entity problems or blocking questions remain
- **Enforces access rules on the server**: reviewers see only their contracts; only Karandeep (or a time-limited delegate) approves, and only Karandeep records a signature
- **Keeps an audit log** of every AI and human action

## Quick start

You need [uv](https://docs.astral.sh/uv/) (it installs Python 3.12+ for you) and [Node.js](https://nodejs.org/) 20.19 or newer.

```bash
# 1. API — creates and seeds a local SQLite database on first start
cd api
uv run uvicorn app.main:app --port 8000      # API docs: http://localhost:8000/docs

# 2. Web app — in a second terminal
cd web
npm install
npm run dev                                  # open http://localhost:5173
```

The web app proxies `/api` to port 8000. If the API isn't running, it still opens with sample data and an "Offline demo" banner.

Use **Viewing as** in the top bar to switch between Karandeep (approver), Bhavin, Dhaval and Jay and see the access rules in action.

## Adding Claude (optional)

Without a key, reviews use the rules engine only. To add Claude, set `ANTHROPIC_API_KEY` before starting the API:

```bash
export ANTHROPIC_API_KEY=sk-ant-...          # macOS / Linux
$env:ANTHROPIC_API_KEY = "sk-ant-..."         # Windows PowerShell, current terminal only
```

On Windows you can also save it permanently under *Start → "Edit environment variables for your account"*, then restart your terminal or editor.

The API log shows `AI analyzer: Claude (claude-haiku-5-5)` when it's on. Claude reviews alongside the rules engine, never instead of it:

- The counterparty's name is masked before the contract is sent
- The contract is passed as untrusted data, so instructions hidden in it are ignored
- Every quote Claude returns is checked against the contract text; unverifiable ones are dropped
- On any error or refusal, the review falls back to the rules engine

Each upload or re-run with Claude is a paid API call.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | not set | Turns on Claude alongside the rules engine |
| `ATLIQ_MODEL` | `claude-haiku-5-5` | Claude model to use |
| `ATLIQ_AS_OF` | `2026-09-28` | The date treated as "today" for obligation status and due dates |
| `DATABASE_URL` | not set | Postgres connection string (e.g. Supabase). When set, the API uses Postgres instead of SQLite |
| `ATLIQ_DB` | `api/atliq.db` | SQLite database file, used when `DATABASE_URL` isn't set |
| `ATLIQ_UPLOADS` | `api/uploads/` | Working copies of uploaded files (the originals are also kept in the database) |
| `ATLIQ_CORS_ORIGINS` | not set | Extra web app addresses allowed to call the API, comma-separated (`localhost:5173` is always allowed) |
| `ATLIQ_CORS_ORIGIN_REGEX` | this project's Vercel addresses | Pattern of allowed addresses; by default the production domain, its aliases and the team's preview links |
| `VITE_API_URL` (web app) | not set | Address of the API, for a web app hosted separately from it. Locally, `/api` is proxied to port 8000 |

To reset the demo data: `curl -X POST -H "X-User: kd" localhost:8000/api/admin/reset`

## Deployment

The web app is the `web/` folder deployed on Vercel (imported as a single project, Vite preset). Every push to `main` redeploys it. `.vercelignore` keeps `api/` out of the upload, so Vercel doesn't turn the Python files into serverless functions.

Vercel sets `VERCEL=1` during builds. The web app calls the API named by `VITE_API_URL`, set in `web/.env.production`. Without an API address, `web/vite.config.ts` builds a sample-data-only demo instead, with a banner saying so.

### Hosting the full app

Web app on Vercel, API on Render, data on Supabase, all on free plans.

1. **Supabase:** create a project, then copy its connection string from **Connect → Session pooler** (Render can't reach Supabase's direct connection). Put your database password into it.
2. **Anthropic (only if you want Claude):** in the Claude Console, set a monthly spend limit under **Settings → Billing → Spend limits**, e.g. $5. When it's reached, reviews fall back to the free rules engine.
3. **Render:** **New → Blueprint**, pick this repository. `render.yaml` defines the `atliq-api` service. Paste the Supabase string into `DATABASE_URL` and, optionally, your key into `ANTHROPIC_API_KEY`. On first start the API creates its tables in Supabase and loads the sample data. Check `https://<your-service>.onrender.com/api/health`: it shows `"ok": true`, whether Claude is on, and the deployed commit (`version`).
4. **Vercel:** the API address is set in `web/.env.production` (`VITE_API_URL`), so every Vercel build talks to it. To point at a different API, change that file (or set `VITE_API_URL` in Vercel's environment variables, which takes priority).
5. The API already accepts this project's Vercel addresses. For any other web address, add it to `ATLIQ_CORS_ORIGINS` on Render.

Things to know: Render's free service sleeps when idle, so the first visit after a quiet spell takes about a minute. Anyone with the link can use the app; there's no real sign-in (the "Viewing as" switcher picks the user). Resetting the demo (`POST /api/admin/reset` as `kd`) reloads the sample data in Supabase in a couple of seconds, as one transaction.

## Tests and evaluation

```bash
cd api
uv run pytest                    # 80 tests: parsing, segmentation, detection, conflicts, access rules, uploads, delegations, precedents, CORS
uv run python -m app.eval        # score the analyzer against the golden set (eval/expected.json)
```

The tests use SQLite by default. Set `DATABASE_URL` to an empty Postgres database to run the same suite against Postgres; all 80 pass on both.

The golden set lists 66 expected issues and 11 cross-contract conflicts across 15 draft contracts. The rules engine scores 100% on it, but its rules were written on those same drafts, so expect lower accuracy on contracts it hasn't seen.

To rebuild the pre-built reviews after changing the analyzer: `uv run python -m app.dataset --reset` (rewrites `seed/seed.json` from `Dataset/` and reloads the database, discarding uploads and decisions).

## The dataset

`Dataset/` is the capstone dataset everything is built from. "Today" is 28 Sep 2026, as the dataset instructs.

- `incoming/`: 15 draft contracts waiting for review
- `signed_contracts/`: 17 signed contracts; the obligation register is drawn from these
- `contract_tracker.csv`: who asked for each contract, when it arrived and when it's due
- `negotiation_notes.md`, `meeting_notes/`, `karandeep_contract_checklist.md`, `atliq_entities.md`: AtliQ's positions, past negotiations and entity rules

To try an upload, use any file from `Dataset/incoming/` on **New review**.

## Project layout

```
Dataset/                  Source contracts, tracker and notes (see above)
Project Documents/        PRD, AI opportunity map, user research, cost estimate and project deck
render.yaml               Render Blueprint for hosting the API
api/                      FastAPI backend
  app/main.py             Routes; every access rule is enforced here
  app/access.py           Coverage, ready-to-sign gates, approver and delegation rules
  app/company.py          AtliQ facts: the two legal entities, insurance, payment terms, "today"
  app/rules.py            Entity and governing-law rules
  app/db.py               Storage: SQLite locally, Postgres (Supabase) when DATABASE_URL is set
  app/pipeline/           parse → segment → detect → rules / Claude → conflicts → verify → summary
  app/dataset.py          Builds seed/seed.json from the source dataset
  app/eval.py             Golden-set evaluation
  dataset/                Obligation register and negotiation precedents (curated)
  eval/expected.json      Golden set
  seed/seed.json          Pre-built reviews loaded on first start
  tests/                  pytest suite
web/                      React + TypeScript + Vite + Tailwind front end
  src/App.tsx             App shell, routing and state
  src/Review.tsx          The contract review page
  src/pages.tsx           Queue, register, precedents, audit log, team, new review
  src/api.ts              Typed client for the API
  .env.production         The hosted API's address (VITE_API_URL), used by production builds
```
