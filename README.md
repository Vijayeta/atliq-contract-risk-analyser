# AtliQ Contract Risk Analyzer

A contract review assistant for AtliQ Technologies. Upload a contract and it reads every clause, flags risk with the exact quote behind each finding, checks the AtliQ legal entity, and catches clashes with promises AtliQ has already signed (non-competes, best-price clauses, exclusivity). People make every decision; the app never signs, approves or sends anything.

Built as a capstone demo: a FastAPI + SQLite backend and a React web app. It runs for free on a deterministic rules engine, and can add Claude for a second opinion when an Anthropic API key is set.

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
| `ATLIQ_DB` | `api/atliq.db` | SQLite database file |
| `ATLIQ_UPLOADS` | `api/uploads/` | Where uploaded contracts are stored |

To reset the demo data: `curl -X POST -H "X-User: kd" localhost:8000/api/admin/reset`

## Tests and evaluation

```bash
cd api
uv run pytest                    # 69 tests: parsing, segmentation, detection, conflicts, access rules, uploads
uv run python -m app.eval        # score the analyzer against the golden set (eval/expected.json)
```

The golden set lists 66 expected issues and 11 cross-contract conflicts across 15 draft contracts. The rules engine scores 100% on it, but its rules were written on those same drafts, so expect lower accuracy on contracts it hasn't seen.

> **Note:** the source dataset (`Dataset/`: contracts, tracker and notes) isn't in this repository yet. The app runs without it, from `api/seed/seed.json`. Tests that read the original contracts, and rebuilding the seed with `uv run python -m app.dataset`, need it added at `Dataset/` next to `api/`.

## Project layout

```
api/                      FastAPI backend
  app/main.py             Routes; every access rule is enforced here
  app/access.py           Coverage, ready-to-sign gates, approver and delegation rules
  app/company.py          AtliQ facts: the two legal entities, insurance, payment terms, "today"
  app/rules.py            Entity and governing-law rules
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
```
