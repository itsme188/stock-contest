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
- **Testing**: Vitest (138 tests)

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
- `app/api/prices/ibkr/route.ts` — IBKR TWS price fetcher (fallback, non-US ticker support via EXCHANGE_MAP)
- `lib/db.ts` — SQLite connection, schema, CRUD
- `scripts/start.sh` — Dev server startup with auto-restart, stale port cleanup
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

Seed data: 3 players, 17 trades, prices through Jan 30 — load via Settings > Import from `data/stock-contest-2026-01-30.json`.

## Known Limitations

- **Polygon.io free tier**: 5 API calls/min. Batch refresh takes ~1 min per 5 tickers. Trade form fetch shares the same quota.
- **IBKR TWS fallback**: Requires Trader Workstation running on localhost:7496. Fails gracefully if TWS is not running.
- **Vitest picks up worktree test files.** Running `npm test` from main globs into `.claude/worktrees/*/` and finds duplicate test files (224 results instead of 112). Not a real failure — the tests are identical copies. ESLint ignores worktrees via `.claude/**` in `eslint.config.mjs`.

## Lessons

- **When decomposing UI into components, verify all functions are passed as props.** The `void functionName` pattern to suppress unused warnings is a red flag — it means the function was disconnected.
- **Always provide a non-API fallback for user actions.** The trade form needs a manual "Calculate Shares" button that works without Polygon, since the API has strict rate limits.
- **Polygon `/prev` endpoint returns the most recently completed session's close.** It updates ~15 min after market close. Schedule automated jobs at least 20 min after close (4:20 PM+). Always pass a date parameter to get opening prices for trade logging.
- **Return machine-readable metadata from API responses.** The Polygon update route now returns `priceDates` (bar dates) so callers can detect stale data programmatically instead of guessing.
- **Layered fallbacks beat single-source dependencies.** Price fetching: Polygon (primary) → retry with delay → IBKR TWS (fallback). Each layer fails gracefully.
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

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary.
- **Demand Elegance**: For non-trivial changes, pause and ask "is there a more elegant way?" Skip for simple, obvious fixes.
