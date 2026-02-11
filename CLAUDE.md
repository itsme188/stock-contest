# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stock Picking Contest tracker for 3 players (Daddy, Eli, Yitzi). Each player gets $100k virtual cash, max 5 open positions at a time. Tracks trades, P&L (realized + unrealized via FIFO), leaderboard rankings, and performance over time.

## Commands

```bash
npm run dev        # Start dev server at http://localhost:3001
npm run build      # Production build
npm run lint       # ESLint check
npm run test       # Run Vitest tests
npm run test:watch # Vitest in watch mode
```

## Tech Stack

- **Framework**: Next.js 16 with React 19, TypeScript 5
- **Styling**: Tailwind CSS 4
- **Charts**: Recharts
- **Storage**: SQLite via better-sqlite3 (server-side, `data/contest.db`)
- **Email**: nodemailer (Gmail SMTP with App Password)
- **AI**: @anthropic-ai/sdk (Claude Sonnet for weekly email commentary)
- **Prices**: Polygon.io API (free tier, 5 calls/min)
- **Testing**: Vitest (88 tests)

## Architecture

### Data Flow
1. All data stored in SQLite (`data/contest.db`) via API routes
2. Client loads from `GET /api/contest`, saves via debounced `PUT /api/contest` (500ms)
3. Client-side computation of positions, P&L, leaderboard
4. Price fetching via server-side Polygon.io API (no CORS proxies)
5. Import/export contest data as JSON files

### API Routes
- `GET/PUT /api/contest` — Full contest data persistence (SQLite)
- `GET /api/prices?ticker=AAPL&date=2026-01-15` — Single ticker price fetch
- `POST /api/prices/update` — Refresh all open ticker prices (batch, rate-limited)
- `POST /api/prices/backfill` — Bulk historical daily prices via Polygon range API
- `POST /api/email/weekly` — Weekly email report with AI commentary

### Key Files
- `app/dashboard/StockContestTracker.tsx` — State shell (~410 lines), all state + handlers
- `app/dashboard/components/` — DashboardTab, TradesTab, PlayersTab, SettingsTab
- `lib/contest.ts` — Pure business logic (types, FIFO, P&L, stats, validation, chart data)
- `lib/email.ts` — Email report logic (report data, AI prompt, HTML template, SMTP send)
- `lib/db.ts` — SQLite connection, schema, CRUD
- `data/` — SQLite database + exported contest data snapshots

### Contest Rules
- $100,000 starting cash per player
- Maximum 5 open positions at any time
- Default position size: $20,000
- FIFO cost basis tracking for realized P&L

### Import Aliases
Use `@/*` for imports.

## Workflow

### Planning
- Enter plan mode for any non-trivial task (3+ steps or architectural decisions)
- Write plan to `tasks/todo.md` with checkable items before implementing
- If something goes sideways, STOP and re-plan immediately

### Execution
- Use subagents liberally for research, exploration, and parallel analysis
- Mark items complete as you go
- High-level summary at each step

### Verification
- Never mark a task complete without proving it works
- Run tests, check logs, demonstrate correctness

### After Corrections
- Update `tasks/lessons.md` with the pattern after any user correction
- Write rules that prevent the same mistake

## Project History

Originally a single-file React app (Jan 14, 2026), ported to this Next.js project on Feb 8, 2026. Dev server runs on port 3001 (port 3000 is used by vanguard-skin).

**Feb 8**: Scaffolded Next.js 16 project, ported JSX to TypeScript, seeded contest data.

**Feb 11**: Extracted business logic to `lib/contest.ts` (73 tests), decomposed UI into 4 tab components, migrated localStorage to SQLite, added server-side price fetching.

**Feb 11**: Added weekly email reports with AI commentary (`lib/email.ts`, 15 tests), automated price refresh and historical backfill via Polygon.io range API.

Seed data: 3 players, 17 trades, prices through Jan 30 — load via Settings > Import from `data/stock-contest-2026-01-30.json`.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary.
- **Demand Elegance**: For non-trivial changes, pause and ask "is there a more elegant way?" Skip for simple, obvious fixes.
