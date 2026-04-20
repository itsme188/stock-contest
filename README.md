# Stock Picking Contest

Private portfolio-tracking dashboard for a small stock-picking contest (three players, $100k virtual cash each, max 5 open positions). Local Next.js app with SQLite persistence, live quotes from IBKR TWS (Polygon fallback), a weekly AI-written email report, and professional-grade per-player stats.

## Quick start

Double-click **Stock Contest.app** on the Desktop — starts the dev server and opens Safari.

Or from the terminal:

```bash
./scripts/start.sh
# then open http://localhost:3001
```

IBKR Trader Workstation must be running on port 7496 for live quotes. Without TWS, Polygon.io is used as a fallback. Copy `.env.example` to `.env.local` and set `POLYGON_API_KEY`, `ANTHROPIC_API_KEY`, Gmail credentials, etc.

## Features

**Dashboard**
- Leaderboard with total value, P&L %, rank changes
- Performance chart with S&P 500 (SPY) benchmark line
- Period selector: 1D / 1W / 1M / YTD / ALL
- Player cards with 6 tiles: Cash, Unrealized P&L, Realized P&L, Realized Losses, Win Rate, annualized Sharpe ratio
- Per-position detail: weight %, cost basis → current price, gain %, % today, days held
- Price staleness indicator

**Trades & prices**
- Buy/sell logging with FIFO cost-basis tracking for realized P&L
- Validation (position limits, cash check, share check) before commit
- Trade import/export (JSON)
- Audit log of all trade edits and deletes
- Price sources: IBKR TWS (`@stoqey/ib`, client ID 2) primary, Polygon.io fallback
- Historical backfill for held tickers + S&P 500 benchmark

**Weekly email (Friday 4:45 PM ET)**
- launchd cron at `scripts/com.stockcontest.weekly-email.plist`
- Refreshes prices, backfills history, refreshes benchmark, sends via Gmail
- AI-generated market commentary (configurable Claude model)
- Market context enriched from Vital Knowledge briefings fetched via IMAP
- Same-day idempotency guard: manual send during the 4:00–4:45 review window prevents the cron from double-sending

**Persistence**
- SQLite at `data/contest.db` (normalized `trades` table + `contest_data` JSON blob)
- Daily DB backup step in the weekly cron
- Recharts for charts, Tailwind v4 for styling

## Architecture

| Layer | Tech |
|---|---|
| Frontend | Next.js 16 App Router, React 19, TypeScript 5, Tailwind 4, Recharts |
| Backend routes | Next.js route handlers under `app/api/` |
| Storage | better-sqlite3 (WAL mode), file at `data/contest.db` |
| Broker API | IBKR TWS via `@stoqey/ib` (`IBApi`, client ID 2, port 7496) |
| Market data | Polygon.io REST (fallback + benchmark fallback) |
| AI | `@anthropic-ai/sdk` — commentary generation, model configurable in Settings |
| Email | nodemailer over Gmail App Password |
| Scheduling | macOS `launchd` (`StartCalendarInterval`, Fri 16:45 local) |
| Tests | Vitest (290+ unit tests) |

## Testing

```bash
npm test          # vitest run
npx tsc --noEmit  # type check
```

## Layout

```
app/
  dashboard/           Dashboard page, tabs, player cards, chart
  api/
    contest/           GET/PUT the full contest data blob
    trades/            CRUD + import
    prices/            update, ibkr, backfill, benchmark
    email/weekly/      Build + send weekly email (with idempotency guard)
lib/
  contest.ts           Pure functions: positions, P&L, Sharpe, daily change
  db.ts                better-sqlite3 access, schema, backup
  prices.ts            IBKR + Polygon backfill
  email.ts             Report data, commentary, Gmail send
  vital-knowledge.ts   IMAP fetch of market briefings
scripts/
  weekly-email.sh      Cron entrypoint (backup → prices → benchmark → email)
  com.stockcontest.weekly-email.plist   launchd agent
```
