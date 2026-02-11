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
