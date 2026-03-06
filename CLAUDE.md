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
npm run email:send      # Manually trigger price refresh + weekly email
npm run email:install   # Install launchd job (Friday 4:20 PM)
npm run email:uninstall # Remove launchd job
npm run email:status    # Check if launchd job is loaded
```

## Tech Stack

- **Framework**: Next.js 16 with React 19, TypeScript 5
- **Styling**: Tailwind CSS 4
- **Charts**: Recharts
- **Storage**: SQLite via better-sqlite3 (server-side, `data/contest.db`)
- **Email**: nodemailer (Gmail SMTP with App Password)
- **AI**: @anthropic-ai/sdk (Claude Sonnet for weekly email commentary)
- **Prices**: Polygon.io API (free tier, 5 calls/min) + IBKR TWS fallback via @stoqey/ib
- **Market Context**: Vital Knowledge email digests via IMAP (imapflow)
- **Testing**: Vitest (203 tests)

## Architecture

### Data Flow
1. All data stored in SQLite (`data/contest.db`) via API routes
2. Client loads from `GET /api/contest`; settings/prices save via debounced `PUT /api/contest` (500ms)
3. Trades persist atomically via `POST /api/trades` and `DELETE /api/trades/[id]` (no debounce)
4. Client-side computation of positions, P&L, leaderboard
5. Price fetching via server-side Polygon.io API (no CORS proxies)
6. Import/export contest data as JSON files

### API Routes
- `GET/PUT /api/contest` — Settings, prices, players persistence (SQLite key-value). PUT ignores trades.
- `GET /api/health` — DB health check (integrity_check pragma, player/trade counts)
- `POST /api/trades` — Create trade (server-validated, UUID assigned, audit logged)
- `DELETE /api/trades/[id]` — Delete trade (audit logged)
- `POST /api/trades/import` — Bulk import trades (used by Settings > Import)
- `GET /api/prices?ticker=AAPL&date=2026-01-15` — Single ticker price fetch
- `POST /api/prices/update` — Refresh all open ticker prices via Polygon (batch, rate-limited, returns `priceDates`)
- `POST /api/prices/ibkr` — Refresh all open ticker prices via IBKR TWS (fallback, requires TWS running)
- `POST /api/prices/backfill` — Bulk historical daily prices via Polygon range API
- `POST /api/email/preview` — Generate email preview (AI commentary + rendered HTML, no send)
- `POST /api/email/weekly` — Weekly email report with AI commentary (accepts optional pre-generated commentary)

### Key Files
- `app/dashboard/StockContestTracker.tsx` — State shell (~410 lines), all state + handlers
- `app/dashboard/components/` — DashboardTab, TradesTab, PlayersTab, SettingsTab
- `lib/contest.ts` — Pure business logic (types, FIFO, P&L, stats, validation, chart data)
- `lib/email.ts` — Email report logic (report data, week deltas, AI prompt, HTML/plain text templates, SMTP send)
- `lib/vital-knowledge.ts` — Vital Knowledge email fetcher (IMAP, Gmail, market context for AI prompt)
- `app/email/preview/page.tsx` — Email preview page (iframe preview, regenerate, send)
- `lib/prices.ts` — Price backfill logic (IBKR primary, Polygon fallback), used by email routes and backfill API
- `app/api/prices/ibkr/route.ts` — IBKR TWS price fetcher (fallback, non-US ticker support via EXCHANGE_MAP)
- `lib/db.ts` — SQLite connection, schema, CRUD, trade table, audit log, blob→table migration
- `scripts/start.sh` — Dev server startup with auto-restart, stale port cleanup
- `scripts/backup-db.sh` — SQLite online backup to timestamped file in `data/backups/`
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

**Feb 11 (session 2)**: Fixed trade form: wired up Fetch Price button (was disconnected during UI decomposition), added sell-order ticker dropdown, cash-aware share calculation, manual "Calculate Shares" button (no API needed). Fixed Dashboard: Refresh Prices always visible, portfolio value shows cash+positions. Fixed Polygon rate limiting (61s between batches).

**Feb 11 (session 3)**: Overhauled weekly email: polished HTML template (gradient header, week-over-week deltas with ▲/▼ arrows, gain/loss bars, portfolio details), added plain text fallback, built email preview page (`/email/preview`) with regenerate + send. Rewrote AI commentary prompt — hedge fund investor letter tone (Buffett-style), expanded banned AI words to 56 (sourced from Wikipedia "Signs of AI writing" + academic research), fixed position data to show total dollars deployed instead of just per-share price. 32 email tests.

**Feb 13**: Added automated weekly email via macOS launchd. Shell script (`scripts/weekly-email.sh`) refreshes prices then sends email every Friday at 4:10 PM. Install with `npm run email:install`, test with `npm run email:send`. Logs at `data/logs/weekly-email.log`. Fixed week-over-week calculations: was using current prices for previous-week valuation (players with no trades showed $0 change), now uses `getPlayerValueAtDate()` with `priceHistory` for true historical values. Added per-position weekly price changes to AI prompt (distinguishes "% total" from "% this week") so commentary no longer confuses cost-basis returns with weekly moves.

**Feb 27**: Desktop launch experience (start.sh + AppleScript + .app bundle with 📈 icon), root page renders dashboard directly, code cleanup (ESLint, unused SVGs, README), fixed email script paths. Cherry-picked from gifted-meninsky: configurable AI model, context-aware position sizing, load error banner, last-refreshed timestamp.

**Feb 27 (session 2)**: Fixed same-day pricing: Polygon `/prev` updates ~15 min after close but email was firing at 4:10 PM (too early). Moved to 4:20 PM, added staleness detection (checks `priceDates` from Polygon response), retry loop (2 retries, 5 min apart), and IBKR TWS fallback via `@stoqey/ib`. New `/api/prices/ibkr` endpoint + IBKR button on dashboard.

**Feb 27 (session 3)**: Vital Knowledge integration. Auto-fetches VK market commentary emails from Gmail via IMAP (`imapflow`), injects into AI prompt so weekly email references real market conditions. New `lib/vital-knowledge.ts` (IMAP fetch, HTML stripping, MIME parsing, 23 tests). Added optional `marketContext` param to `buildCommentaryPrompt()` and `generateCommentary()`. Weekly route now accepts `to` override for test sends. 138 total tests.

**Feb 27 (session 4)**: Fixed stale "% this week" in email AI prompt. Price history was sparse (last refresh 14 days prior), causing `getPriceAtDate` to compare against old prices. Extracted `backfillPrices()` into `lib/prices.ts` — runs automatically before email generation. IBKR TWS is primary backfill source (fast, supports CAD tickers); Polygon is fallback. Also fixed missing WW sell trade for Eli (lost during simultaneous trade entry due to debounced PUT). 138 tests.

**Mar 2**: Atomic trade persistence. Eli's BNED buy was lost (same debounced-PUT bug as the WW sell). Root cause: entire app state saved via single debounced PUT — stale closures could overwrite trades. Fix: normalized `trades` table in SQLite with dedicated `POST/DELETE /api/trades` endpoints. Server generates UUIDs (no more `Date.now()` collisions), validates via `validateTrade()`, and audit-logs every operation. Auto-migration moves existing blob trades to normalized table on first request. Debounced PUT still handles settings/prices/players but trades are stripped at both client and server layers. Added Eli's BNED trade (1818 shares @ $8.25, Feb 19). 138 tests.

**Mar 2 (session 2)**: Reliability overhaul. Added 65 tests (203 total) covering DB layer (`lib/db.test.ts`, 33 tests) and API routes (32 tests across 4 files). Fixed NaN timestamp bug in trade creation, hardened import validation (`!t.price` → `t.price == null`), added Polygon response type guards. New infrastructure: save-failure banner, `/api/health` endpoint, `scripts/backup-db.sh` (SQLite online backup), macOS failure notifications in weekly email script. Player delete now cascades trades to DB. Price staleness indicator on Dashboard.

**Mar 2 (session 3)**: IBKR-first trade form pricing. Trade form "Fetch Price & Calculate Shares" now tries IBKR TWS first (no API key needed), falls back to Polygon. Smart price types: current price during market hours, closing price outside hours, opening price for historical dates. Client labels each clearly. Fixed staleness indicator bug — `getPriceStaleness()` was checking ALL tickers in `currentPrices` including closed positions, anchoring the indicator to stale dates. Now accepts optional `openTickers` param. 218 tests (15 new).

Seed data: 3 players, 17 trades, prices through Jan 30 — load via Settings > Import from `data/stock-contest-2026-01-30.json`.

## Known Limitations

- **Polygon.io free tier**: 5 API calls/min. Batch refresh takes ~1 min per 5 tickers. Trade form fetch shares the same quota.
- **IBKR TWS (primary price source)**: Requires Trader Workstation running on localhost:7496. Used for trade form pricing, batch refresh, and backfill. Falls back to Polygon if TWS is not running.
- **Vitest picks up worktree test files.** Running `npm test` from main globs into `.claude/worktrees/*/` and finds duplicate test files. Always clean up worktrees after merge (`git worktree remove`, `git branch -d`). ESLint ignores worktrees via `.claude/**` in `eslint.config.mjs`.

## Lessons

- **When decomposing UI into components, verify all functions are passed as props.** The `void functionName` pattern to suppress unused warnings is a red flag — it means the function was disconnected.
- **Always provide a non-API fallback for user actions.** The trade form needs a manual "Calculate Shares" button that works without Polygon, since the API has strict rate limits.
- **Polygon `/prev` endpoint returns the most recently completed session's close.** It updates ~15 min after market close. Schedule automated jobs at least 20 min after close (4:20 PM+). Always pass a date parameter to get opening prices for trade logging.
- **Return machine-readable metadata from API responses.** The Polygon update route now returns `priceDates` (bar dates) so callers can detect stale data programmatically instead of guessing.
- **Layered fallbacks beat single-source dependencies.** Price fetching: IBKR TWS (primary) → Polygon (fallback). Each layer fails gracefully. IBKR is faster and has no rate limits; Polygon is the safety net.
- **Labels must match data.** "Portfolio Value" showing only positions (not cash) was confusing. Use precise labels: "Total Value" (cash+positions), "Cash", "Positions".
- **Pre-compute everything for the AI — never make it do math.** Show `$19,888 deployed, now worth $20,500 (+3.07%)`, not `44 shares @ $452 avg cost`. The model will confuse per-share price with position size.
- **When data can be misinterpreted, add an explicit rule.** Even with better data, add a strict rule like "Position size = total dollars deployed, NOT per-share price." Belt and suspenders.
- **AI writing tells are well-documented — ban them explicitly.** Wikipedia's "Signs of AI writing" page lists words (delve, elevate, resonate, seamless, testament, intricate, etc.) whose usage spiked post-LLM. Also ban rhetorical patterns ("it's not X, it's Y") and glazing (impressive, incredible, remarkable).
- **Tone instructions need a concrete example.** "Be dry and matter-of-fact" is vague. A full example paragraph in the desired voice produces much more consistent output.
- **Week-over-week comparisons need historical prices.** Using current prices for both "before" and "after" snapshots makes price movements invisible — only trades show up as changes. Use `getPlayerValueAtDate()` with `priceHistory` for true historical portfolio values.
- **Label every number you give to an AI.** An unlabeled "+23%" will be used however the model sees fit. Explicitly marking "total" vs "this week" and adding a strict rule prevents the AI from presenting cost-basis returns as weekly performance.
- **macOS .app icon: use `NSWorkspace.shared.setIcon()`, not file replacement.** Replacing `applet.icns` inside a `.app` bundle does NOT update Finder. Must use Swift `NSWorkspace` API which writes the resource fork and sets `com.apple.FinderInfo`.
- **macOS AppleScript: use `do shell script "open URL"` instead of `tell application "Safari"`.** The `tell` form requires per-app Automation permissions in TCC. The `open` command uses Launch Services — zero permissions needed.
- **`start.sh` must kill stale port processes before starting.** If a previous server crashed, the port stays occupied. Always `lsof -ti:PORT | xargs kill` before `npx next dev`. Without this, the auto-restart loop hits EADDRINUSE infinitely.
- **`@stoqey/ib` uses `primaryExch`, not `primaryExchange`.** IBKR docs say `primaryExchange` but the TypeScript `Contract` interface abbreviates it. Non-US tickers (e.g., `.TO` for TSX) need `primaryExch` + correct currency (CAD).
- **Gmail App Passwords work for both SMTP and IMAP.** One password grants access to sending (nodemailer) and reading (imapflow). No additional Gmail settings needed.
- **`imapflow` search() returns `number[] | false`, not empty array.** Always guard with `!uids || uids.length === 0`. The `false` return is a footgun if you assume array.
- **Vitest mocks: arrow functions aren't constructors.** `vi.fn().mockImplementation(() => ...)` fails with `new`. Use a class in the mock factory instead.
- **Optional trailing params preserve backward compatibility.** Adding `marketContext?: string` as the last parameter means all existing callers work unchanged — zero modifications at call sites that don't use the new feature.
- **`getPriceAtDate` silently falls back to stale prices.** If priceHistory has gaps (e.g., no data for 2 weeks), week-over-week calculations silently use old prices. Always backfill before computing deltas.
- **IBKR `reqHistoricalData` supports multi-day durations.** Change `"1 D"` to `"60 D"` to get full daily bar history. The `historicalData` event fires once per bar, then `"finished-..."` when done. Collect all bars, not just the last one.
- **Critical data needs atomic persistence, not debounced batch saves.** Debounced PUTs are fine for settings/prices (idempotent, re-fetchable) but trades are irreplaceable. Use dedicated POST/DELETE endpoints that write to the DB before updating client state.
- **Server-first for irreversible operations.** `addTrade` POSTs to the server and only calls `setTrades` after the server confirms. If the POST fails, the UI stays consistent with the DB. The slight delay is worth the data safety.
- **Double-layer defense for data boundaries.** Client doesn't send trades in the debounced PUT + server strips them if received. Either layer alone prevents the bug; both together make it impossible.
- **Auto-migration via idempotent checks.** `migrateTradesFromBlob()` checks if the new table is empty AND the old blob exists, migrates in a transaction, then deletes the blob key. Safe to run multiple times, no manual steps.
- **`Date.now()` is not a safe ID generator.** Millisecond-granularity IDs collide under rapid input. Use `crypto.randomUUID()` (available in Node 19+/all modern browsers) for server-generated IDs.
- **After adding packages in a worktree, `npm install` must be run in main.** Worktree `node_modules` are separate. Merging `package.json` changes doesn't install the modules.
- **Clean up stale worktrees.** Old worktrees with outdated test files cause Vitest false failures when running from main (`npm test` globs into `.claude/worktrees/*/`).
- **`!value` rejects zero, not just null/undefined.** `!t.price` catches `price: 0` as "missing". Use `t.price == null` for nullable checks (catches `null` and `undefined` but not `0`).
- **DB tests: use in-memory SQLite, not mocks.** `new Database(":memory:")` + `_initSchema()` gives real SQL execution with zero I/O. Catches CHECK constraint bugs that mocks would miss.
- **API route tests: mock the DB layer, not HTTP.** Import the handler function directly, construct `new Request(...)`, call `POST(request)`. Mock `@/lib/db` with `vi.mock`. Tests run in <20ms each.
- **Type-guard external API responses before storing.** `typeof price === 'number' && isFinite(price) && price > 0` prevents NaN/Infinity/null from Polygon corrupting the database.
- **Always remove worktrees AND branches after merge.** `git worktree remove` + `git branch -d` — leftover branches prevent future worktree creation with the same name.
- **IBKR error codes >= 2000 are warnings, not errors.** Code 2174 (timezone format) still returns data after the warning. The `onError` handler must skip codes >= 2000 or it will reject the promise before data arrives.
- **IBKR `reqHistoricalData` endDateTime: use `""` (now) with calculated duration.** Passing a specific `endDateTime` like `"20260309 23:59:59"` triggers warning 2174 (timezone required). Using `""` with a duration that covers the target period avoids the issue entirely — this is the pattern used in `lib/prices.ts` and `app/api/prices/ibkr/route.ts`.
- **Staleness/scope mismatch: always check the same set you update.** `getPriceStaleness` checked all tickers in `currentPrices` (append-only, includes closed positions), but refresh only updates open positions. The staleness indicator was permanently anchored to closed-position dates. Fix: pass the relevant ticker subset.
- **`git worktree prune` does NOT delete directories.** It only cleans git's internal metadata for worktrees with missing/broken `.git` files. The actual directory and all its files remain on disk. Use `git worktree remove <path>` for full cleanup, or `rm -rf` followed by `prune`.
- **Git merges from worktrees may not trigger Next.js hot-reload.** File timestamps from `git merge` don't always wake Turbopack's file watcher. Kill and restart the dev server after merging worktree changes: `lsof -ti:3001 | xargs kill`.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary.
- **Demand Elegance**: For non-trivial changes, pause and ask "is there a more elegant way?" Skip for simple, obvious fixes.
