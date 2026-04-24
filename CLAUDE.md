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
- **Testing**: Vitest (275 tests)

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
- `POST /api/prices/benchmark` — S&P 500 (SPY) historical prices (IBKR primary, Polygon fallback)
- `POST /api/email/preview` — Generate email preview (AI commentary + rendered HTML, no send)
- `POST /api/email/weekly` — Weekly email report with AI commentary (accepts optional pre-generated commentary)

### Key Files
- `app/dashboard/StockContestTracker.tsx` — State shell (~410 lines), all state + handlers
- `app/dashboard/components/` — DashboardTab, TradesTab, PlayersTab, SettingsTab, PeriodSelector, PerformanceChart, PlayerDetailCard
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

**Mar 10**: Email edit bug fix + dashboard UX. Fixed email preview edits lost on send — `sendEmail()` now reads commentary from iframe DOM (cloned node) instead of relying on React state closure. Reorganized price refresh buttons: IBKR first (blue/primary), Polygon second (green), Yahoo third (outline). Added quick actions to Leaderboard header: "+ Add Trade" (switches to Trades tab + opens modal) and "Weekly Email" (opens `/email/preview` in new tab). Filtered performance chart to `contestStartDate`, removing ~6 weeks of flat 0% pre-contest data. 232 tests.

**Mar 13**: Fixed weekly email quality: AI was claiming LFMD held "across all three portfolios" (only 2 of 3 own it) — added prompt guardrail against false position attribution. VK market context wasn't being used by the AI because `text/plain` MIME part of newsletter emails is full of image URLs and junk headers; switched to prefer `text/html` (stripped) which gives clean market data. Added VK fetch logging to email routes for diagnostics. 232 tests.

**Mar 27**: Fixed Vital Knowledge silent failure — `imapflow` wasn't in `serverExternalPackages`, so Turbopack couldn't bundle it and VK fetch returned "" silently. Full project audit found IBKR error code >= 2000 bug in `lib/prices.ts` and `app/api/prices/ibkr/route.ts` (warnings treated as fatal errors, causing backfill to reject valid data). Added division-by-zero guards on `gainPct` (3 locations), expanded `serverExternalPackages` to include `better-sqlite3`, `@stoqey/ib`, `nodemailer`. Added 90s timeout on `backfillPrices()` in email routes. Memoized leaderboard/chartData with `useMemo`. New tests for `lib/prices.ts` (7) and `lib/commentary.ts` (13). 252 tests.

**Apr 13**: Professionalized dashboard with brokerage-style features. Added period selector (1D/1W/1M/YTD/All) controlling leaderboard returns and chart date range. S&P 500 benchmark line on performance chart via `POST /api/prices/benchmark` (IBKR primary, Polygon fallback, stored as `__BENCHMARK_SPY` in `priceHistory`). Enhanced player detail cards with stats grid (cash, unrealized/realized P&L, win rate with W-L record) and compact two-line position cards (market value, portfolio weight %, daily change, days held). Extracted DashboardTab into PeriodSelector, PerformanceChart, and PlayerDetailCard sub-components. Polished chart: lighter grid, 0% reference line, smaller dots, indigo dashed S&P line, rounded tooltip with weekday. New pure functions in `lib/contest.ts`: `getPeriodReturn`, `getPositionDailyChange`, `getPositionDaysHeld`, `getBenchmarkReturnAtDate`. 275 tests (23 new).

**Apr 19**: Weekly email quality overhaul, triggered by Daddy asking whether his SEDG trade was reflected in his portfolio value (it was — realized gain flowed through cash) and separately by noticing that the Apr 17 AI commentary named the wrong "best performer", missed trades, and referenced trades closed the week before. Fixed three root causes: (1) email breakdown — added per-player "Closed Trades to Date" table and relabeled summary as "Net Realized P&L (N wins / N losses)" so individual wins like SEDG are visible instead of being hidden inside a net-negative total; (2) fencepost bug — `getWeeklyTrades` used inclusive date bounds on both ends, so Friday trades appeared in two consecutive weekly emails. Anchored the window to NYSE close: `(last Fri 4:00 PM ET, this Fri 4:00 PM ET]`, new `getMarketCloseTimestamp` helper handles EST/EDT via Intl; (3) AI prompt quality — pre-ranked "Biggest weekly moves per player" block so the model doesn't guess, trade annotations now show `PARTIAL TRIM (position: N -> M shares)` + realized P&L per sell, added STRICT RULES for activity coverage, scope (no out-of-window trades), position-count integrity, and stricter "across all portfolios" check. 278 tests (3 new boundary tests).

**Apr 24**: Fixed wrong "% today" on position cards. Spot-check: HOOD showed -4.1% today when the real 1-day change was +1.6%; TER showed +9.4% when the real move was +4.5%. Root cause: `priceHistory` was missing any trading day the user didn't manually refresh (e.g., 2026-04-23 was absent across every open-position ticker), and `getPositionDailyChange` silently compared today's price to the last stored date — turning a 2-day move into "% today". Only one scheduled job existed (Friday 4:45 PM weekly email), so weekdays had no automation. Two layers of fix: (1) **new daily launchd job** `com.stockcontest.daily-refresh` runs Mon-Fri at 9:31 AM and 4:20 PM — IBKR primary, Polygon `/prev` fallback, always calls `/api/prices/backfill` so prior-day gaps self-heal via Polygon range API. 4:20 PM chosen (not 4:00) because Polygon `/prev` needs ~15 min post-close. `scripts/daily-refresh.sh` + 10-entry `StartCalendarInterval` array plist + `refresh:{send,install,uninstall,status}` npm scripts mirroring the email job. (2) **staleness guard** in `getPositionDailyChange`: returns `null` when the most recent prior close is more than 4 calendar days old (covers Fri→Mon weekend and Fri→Tue long-weekend holiday). Also flipped `weekly-email.sh` to IBKR-first with Polygon staleness retry as fallback, matching the established IBKR-primary pattern (CLAUDE.md Mar 10). 298 tests (2 new).

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
- **contentEditable + React state = stale closures.** DOM input events from iframes call `setState()` asynchronously. If a send/submit handler captures state from its closure, it may read the pre-edit value. Fix: read directly from the DOM at action time (clone the node to avoid mutating live content), fall back to React state. Belt-and-suspenders pattern.
- **Newsletter text/plain MIME parts are often junk.** Many email services generate a `text/plain` fallback full of image URLs and "email doesn't support HTML" headers. For machine consumption (feeding to an LLM), stripped `text/html` produces far better text. Prefer HTML for newsletters.
- **AI prompt data quality matters as much as instructions.** When VK context was 8000 chars of noisy plain text, the AI ignored the "use market context" instruction entirely. Same 8000 chars as clean stripped HTML → the AI wove in specific market references. Clean input → model follows instructions.
- **AI will generalize beyond its data unless explicitly told not to.** Even with per-player position lists, the model claimed a ticker was held "across all portfolios." Adding a strict rule ("check before generalizing") fixed it. Never assume the model will cross-reference data sections on its own.
- **Packages using Node.js native modules (`net`, `tls`, native addons) need `serverExternalPackages`.** Turbopack can't bundle them. If the import is inside a try/catch (like `fetchVitalKnowledge`), the bundling failure is silent — the function just returns a default value. Always declare `imapflow`, `better-sqlite3`, `@stoqey/ib`, `nodemailer` as external.
- **Apply the same fix everywhere, not just the first place you find it.** The IBKR `code >= 2000` warning skip existed in `app/api/prices/route.ts` but was missing from `lib/prices.ts` and `app/api/prices/ibkr/route.ts`. Grep for the pattern across the whole project.
- **Wrap long-running calls with timeouts in API routes.** `backfillPrices()` could hang if IBKR is slow and Polygon batches take 61s each. Use `Promise.race` with a timeout, catch and warn, proceed with available data.

- **9-column tables don't fit in 1/3-width cards.** The position table was unreadable with values crammed together. Two-line compact cards (row 1: key metrics, row 2: details) work at any width. Group related data on the same line instead of giving each datum its own column.
- **Use UTC for date arithmetic, not local time.** `new Date("2026-03-01T12:00:00")` still suffers from DST (Spring Forward makes one day 23 hours). Use `T00:00:00Z` + `Math.round` for reliable day-count calculations.
- **Reused infrastructure stores data under the original key.** `backfillViaIBKR(["SPY"])` stores under `priceHistory["SPY"]`, not `priceHistory["__BENCHMARK_SPY"]`. When reusing generic functions with a special key convention, copy the data to the expected key after the call.
- **Refresh routes only write today; always pair with backfill.** `/api/prices/ibkr` and `/api/prices/update` write `priceHistory[ticker][today] = price` and nothing else. Any trading day you don't manually refresh is a silent gap. Deltas that span such gaps (like `getPositionDailyChange`) will display multi-day moves as "% today". Solution: run `/api/prices/backfill` (Polygon range API) on every scheduled refresh; it only writes completed historical sessions and never clobbers today.
- **Polygon `/prev` is unsafe to call before ~4:20 PM ET.** At 9:31 AM or 4:00 PM ET it returns *yesterday's* close, which the update route writes under *today's* date — a silent data corruption. Either gate the fallback on current time, or prefer IBKR primary + backfill (which only touches prior days).
- **Staleness caps turn "silent wrong" into "silent gone".** `getPositionDailyChange` now returns `null` when the prior close is >4 calendar days old. 4 days covers Fri→Mon weekend (3) and Fri→Tue long-weekend holiday (4); anything older is almost always a data gap, not a real 1-day move. The UI hides the line when null returns, so stale disappears instead of misleading.
- **Test fixtures without explicit `today` silently rely on `localToday()`.** Any date-sensitive assertion that compares fixture dates against "now" will decay as calendar time passes. When adding a staleness check to a function, pass `today` explicitly in every test — otherwise yesterday's passing tests become tomorrow's false failures.
- **launchd `StartCalendarInterval` accepts an array of dicts.** One plist, N trigger times. Cleaner than N plists, and `launchctl list` still reports a single job. Used for the daily-refresh job (5 weekdays × 2 times = 10 entries).

- **Time windows should be half-open and anchored to a real event, not date strings.** `getWeeklyTrades` used `t.date >= cutoff && t.date <= end` — inclusive on both sides. Friday trades appeared in that week's email AND the next week's. Fix: half-open window `(startTs, endTs]` anchored to NYSE 4:00 PM ET market close, compared against `t.timestamp` (ms). Anchoring to a real event also settles the ambiguity around intra-day trades: a trade at 4:43 PM Friday post-close belongs to next week's email.
- **NYSE 4:00 PM ET across DST: guess EDT, check with `Intl`.** Compute `Date.UTC(y, m-1, d, 20, 0, 0)` (4 PM EDT = 20:00 UTC), then use `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` and `timeZoneName: 'short'` to check whether it renders as `EDT` or `EST`. If EST, add 1 hour. Avoids pulling in a timezone library.
- **Pre-rank any ordered data you want the AI to reference.** Telling Claude "find the best performer" by giving it a list of positions with `% this week` is unreliable — it picks what sounds narratively good. Pre-sort and label (`biggest gainer: HYDTF +22.70%, biggest laggard: MDI.TO -1.87%`) so the model copies verbatim.
- **Annotate structured events in prose, not just data fields.** Trade rows like `SELL 1194 WLTH` give the AI no way to tell a partial trim from a full exit. Adding `PARTIAL TRIM (position: 2389 -> 1195 remaining)` or `FULL CLOSE` inline eliminates that class of error. Show before → after transitions when a nearby number (1194 sold, 1195 remaining) could be confused.
- **When numbers in separate sections could be conflated, state the semantics.** The AI subtracted trade shares from standings counts (seeing "INTC: 300 shares" in standings and "sold 100" in trade, concluding "200 remaining") even though standings are post-trade. Add a rule: "standings reflect holdings AFTER all trades this week; take 'remaining' from the trade annotation, don't subtract."
- **Prompt coverage rules prevent silent drops.** "Every trade in 'Trades this week' must be addressed — either by name or a deliberate grouping" keeps the AI from skipping trades to hit the word limit. Pair with a scope guardrail ("Do NOT reference trades not in the list") to prevent pulling in stale context.
- **Break out the components when an aggregate is misleading.** One `Realized P&L: -$7,474` line hid the SEDG win entirely. A per-trade breakdown table made the win visible AND the context clear (one 21% win vs. four big losers). Relabeling the aggregate to `Net Realized P&L (1 win / 4 losses)` signals "this is a sum" before the reader even reads the number.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary.
- **Demand Elegance**: For non-trivial changes, pause and ask "is there a more elegant way?" Skip for simple, obvious fixes.
