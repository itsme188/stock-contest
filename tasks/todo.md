# Stock Contest - Todo

## Completed
- [x] Set up Next.js project with TypeScript, Tailwind, Recharts
- [x] Port StockContestTracker component from JSX to TypeScript
- [x] Create CLAUDE.md project guidance
- [x] Extract pure business logic into `lib/contest.ts` (73 tests)
- [x] Break UI into 4 sub-components (DashboardTab, TradesTab, PlayersTab, SettingsTab)
- [x] Migrate from localStorage to SQLite (`lib/db.ts` + `/api/contest`)
- [x] Server-side price fetching (`/api/prices`) — no more CORS proxies
- [x] Weekly email report with AI commentary (`lib/email.ts` + `/api/email/weekly`, 15 tests)
- [x] Automated price refresh (`/api/prices/update`) — Refresh Prices button on Dashboard
- [x] Historical price backfill (`/api/prices/backfill`) — Polygon range API for smooth chart data
- [x] Desktop launch experience (`Stock Contest.app` with 📈 icon, `start.sh`, `launcher.applescript`)
- [x] Root page renders dashboard directly (no landing page click)
- [x] Code cleanup (ESLint, unused SVGs, README, fixed email script paths)
- [x] Configurable AI model for weekly email (Sonnet/Haiku/Opus dropdown in Settings)
- [x] Context-aware position sizing (`getLastSaleProceeds` sizes new buys to match last sale)
- [x] Same-day closing prices — Polygon `/prev` at 4:20 PM + staleness detection + retry + IBKR TWS fallback
- [x] IBKR TWS price endpoint (`/api/prices/ibkr`) with non-US ticker support (TSX via `.TO` suffix)
- [x] IBKR refresh button on Dashboard
- [x] Integrate Vital Knowledge (vitalknowledge.net) market commentary into weekly email (shipped Feb 27 session 3; hardened Mar 13 and Mar 27 — see CLAUDE.md)
- [x] Fix wrong "% today" on position cards — daily launchd refresh Mon-Fri x {9:31, 16:20} (IBKR primary, Polygon fallback, backfill on every run) + 4-day staleness guard in `getPositionDailyChange` + weekly-email.sh flipped to IBKR-first (2026-04-24, `3a950b3`)

## Planned

_(Nothing active.)_
