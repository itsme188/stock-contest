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
- [x] Add silent-failure watchdog to daily-refresh.sh — macOS notification when last run was >72h ago (2026-04-24, `4120326`)
- [x] Unblock launchd TCC by moving scripts out of ~/Desktop/ — scripts/install-launchd.sh + ~/Library/Application Support/stock-contest/ as the launchd-executable install location; fixes weekly email silently failing since Feb 13 (2026-04-24, `b7ce3ea`)
- [x] Weekly email reliability + content overhaul — multi-phase rewrite triggered by audit finding only 2 of 13 expected emails had shipped (2026-05-08, `2f4e895`):
   - Hard freshness gate in `runWeeklyEmail`: `refreshAllOpenPrices` on every send; refuse-and-alert if `priceDates` don't match today after retries. Kills the Polygon-/prev-yesterday-as-today silent corruption.
   - VK fetcher filters to "Vital Talking Points Recap" subject only (was aggregating 5 daily digests, diluting market context).
   - Per-ticker trade grouping in prompt with pre-computed day-of-week. Replaces flat trade list that caused the AI to misattribute trades and miscount tranches.
   - Three-layer post-hoc validation on AI commentary: regex (`detectCommentaryViolations` for numbers/ranking-phrases), regex (`detectFactualViolations` for coverage + unknown tickers), and a verifier pass (second Claude call grading prose against trade log). All wired into a 3-attempt retry that picks the lowest-violation pass.
   - Architectural decoupling: extracted `lib/prices-refresh.ts` and `lib/email-flow.ts` from route handlers; new `scripts/run-{weekly-email,daily-refresh}.ts` standalone Node scripts that don't need `localhost:3001`.
   - `email_sends` audit table + `lib/email-alerts.ts` (failure-alert email to isaac@). Dashboard "Recent Email Activity" card via `/api/email/sends`.
   - `install-launchd.sh` now copies all `*.sh` dependencies (fixes the long-standing "Database backup failed" warning) and verifies `launchctl load` actually registered the agent.
   - 298 → 326 tests.

## Planned

- [ ] **Optional, partly mitigated:** `/api/backup` endpoint so DB backup can run from launchd. Symptom is now harmless — `install-launchd.sh` copies `backup-db.sh` so the script no longer logs "No such file or directory", and the call is non-fatal — but launchd still can't read `~/Desktop/stock-contest/data/contest.db` (TCC). An authenticated POST endpoint that writes to `~/Library/Application Support/stock-contest/backups/` would restore automated backups. Not urgent.

- [ ] **Open question, deferred from 2026-05-08:** macOS TCC blocks the new `scripts/run-{weekly-email,daily-refresh}.ts` standalone scripts from running under launchd as long as the project lives at `~/Desktop/stock-contest/` (launchd-spawned `tsx`/`node` can't read TS files there). Two paths to unlock:
   - Move the project off `~/Desktop/` (one-time relocation; updates to plists + AppleScript launcher).
   - Grant Full Disk Access to `/opt/homebrew/bin/node` in System Settings (manual, but reversible).
   The launchd jobs currently still point at `scripts/weekly-email.sh` (curl-based, working) which delegates to `lib/email-flow.ts` via `localhost:3001`. The new TS scripts work for **manual invocation** today (`npx tsx scripts/run-weekly-email.ts`) — they just aren't yet wired into the schedule.

- [ ] **Stylistic:** Market-context paragraph emphasis is whatever the Friday VK recap leads with. User noted on 2026-05-08 that the AI underweighted AI/earnings news and overweighted the Friday jobs report. To control emphasis we'd need either (a) a small pre-summarization Claude call asking "what's the dominant theme this week?" before the main commentary call, or (b) a manual weekly tag the user sets. Defer until needed.
