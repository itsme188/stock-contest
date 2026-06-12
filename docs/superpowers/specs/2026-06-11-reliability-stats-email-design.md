# Reliability + Statistics + Email Upgrade — Design

**Date:** 2026-06-11
**Approach:** One sequenced plan, three phases, one commit per phase. Order matters: reliability fixes make the data trustworthy, statistics build on that data, email upgrades consume the statistics.

## Goals

1. Convert remaining "silent wrong" data-quality failures into loud, visible ones.
2. Add professional-grade portfolio statistics (audience: a hedge-fund analyst and a 40-year money manager).
3. Upgrade the weekly email with benchmark context, milestone callouts, the new stats, and data-quality transparency.

Non-goals (explicitly out of scope this pass): AI trade entry, monthly deep-dive email edition, UI redesign, schema migrations beyond `email_sends` status values.

---

## Phase 1 — Reliability

### 1.1 Write prices under their bar date, not today's date

**Problem.** `persistPrices(updated, today)` in `lib/prices-refresh.ts:105` writes every fetched close under `priceHistory[ticker][today]`. When Polygon `/prev` (or IBKR off-hours) returns the *prior* session's close, yesterday's price is stored under today's key — the silent corruption that has bitten this project repeatedly.

**Fix.** Change `persistPrices` to accept `priceDates` and write each price to `priceHistory[ticker][priceDates[ticker]]` (the bar's real date). Fall back to `today` only when no bar date is available. `currentPrices[ticker]` is still updated either way — "most recent known close" is correct regardless of which session it came from.

This is strictly better than refusing to write: stale data lands under its *correct* historical key (same thing backfill does), so no information is lost and no corruption occurs. The existing freshness machinery (`pricesAreFresh`, `StalePricesError`, dashboard staleness indicator) is unchanged and still reports staleness to callers.

**Also fix** the Polygon bar-date conversion at `lib/prices-refresh.ts:300-302`: `new Date(ms).toISOString().split("T")[0]` derives the UTC calendar date. Replace with an `America/New_York` conversion (new helper `etDateFromMs(ms)` in `lib/dates.ts` using `Intl.DateTimeFormat` with `timeZone: "America/New_York"`), since Polygon daily bars are ET sessions.

**Surface in UI.** `/api/prices/update` already returns `priceDates` + `date`. The dashboard's Polygon refresh handler shows a warning toast/banner when `pricesAreFresh` is false: "Polygon returned [date]'s close (stored under that date). For today's close, use IBKR or retry after ~4:20 PM ET." No override flag — nothing is blocked anymore, just labeled correctly.

### 1.2 Close the double-send window

**Problem.** `runWeeklyEmail` marks `lastWeeklyEmailSentDate` *after* `sendWeeklyEmail` resolves (`lib/email-flow.ts:281-283`). If the process dies or the HTTP response is lost between SMTP-accept and the DB write, a retry sends a duplicate email.

**Fix.**
- Add `updateEmailSend(id, fields)` to `lib/db.ts`; `recordEmailSend` returns the inserted row id.
- In `runWeeklyEmail` (real sends only, not `testTo`): insert an `email_sends` row with `status: "pending"` immediately **before** calling `sendWeeklyEmail`; update it to `ok`/`error` after.
- Extend the idempotency check: skip (without `force`) if `lastWeeklyEmailSentDate === today` **or** a `pending`/`ok` row for `kind: "weekly", report_date: today` exists that is less than 30 minutes old. A stale `pending` row (>30 min) is treated as a crashed attempt and does not block — `force` semantics unchanged.

### 1.3 UTC date arithmetic sweep

**Problem.** `getPeriodStartDate` (`lib/contest.ts:609`) does `d.setDate(d.getDate() - N)` on a local-time Date — the DST off-by-one pattern called out in the project lessons.

**Fix.** Add `addDays(ymd: string, n: number): string` to `lib/dates.ts` implemented in UTC (`Date.UTC` from the Y/M/D parts, add `n * 86_400_000` ms, format back). Rewrite `getPeriodStartDate` cases 1D/1W/1M with it. Grep `lib/` and `app/` for other `setDate(getDate() ± n)` occurrences and migrate any that operate on YMD strings. Tests pin dates spanning the 2026 DST transitions (Mar 8, Nov 1).

### 1.4 Surface silent degradation

**Problem.** `runWeeklyEmail` already collects `backfillFailed`, `vk.fetchFailed`, and `highlightsWarnings`, but they only land in the audit table and script logs. The email reader never sees them.

**Fix.**
- **Data-notes footer in the email** (HTML + plain text): a small muted section listing material data issues — backfill failure ("week-over-week figures may use the most recent available close"), VK unavailability ("market context unavailable this week"), and excluded-from-highlights tickers. Rendered only when at least one issue exists; invisible otherwise.
- **Failure-alert escalation:** `scripts/run-weekly-email.ts` already calls `sendFailureAlert` on thrown errors. Extend the success path: if the result has `backfillFailed` or (`vk.credsConfigured && vk.fetchFailed`), send a non-fatal "sent with degraded data" alert to isaac@ summarizing the issue. The weekly email itself still goes out — degraded data is noted, not blocking.

---

## Phase 2 — Statistics

### 2.1 Shared daily-value series builder

Extract the series logic currently inlined in `getPlayerSharpeRatio` (`lib/contest.ts:427-473`) into:

```ts
export function buildDailyValueSeries(
  playerId: string,
  trades: Trade[],
  priceHistory: Record<string, Record<string, number>>,
  contestStartDate: string,
  today?: string
): { date: string; value: number }[]
```

Dates = union of the player's trade dates and all priceHistory dates, filtered to `[contestStartDate, today]`, sorted; values via `getPlayerValueAtDate`. `getPlayerSharpeRatio` is refactored to consume it (behavior-identical — existing Sharpe tests must pass unmodified).

### 2.2 `getAdvancedStats`

```ts
export interface AdvancedStats {
  maxDrawdownPct: number | null;       // peak-to-trough, as negative %
  maxDrawdownPeakDate: string | null;
  maxDrawdownTroughDate: string | null;
  annualizedVolatilityPct: number | null; // stdev(daily returns) * sqrt(252)
  sortino: number | null;              // mean excess / downside deviation, annualized
  beta: number | null;                 // vs __BENCHMARK_SPY daily returns
  alphaAnnualizedPct: number | null;   // annualized intercept vs SPY
  payoffRatio: number | null;          // avg winning trade $ / |avg losing trade $|
  avgWinPct: number | null;            // avg gainPct of winning closed trades
  avgLossPct: number | null;           // avg gainPct of losing closed trades
}

export function getAdvancedStats(
  playerId: string,
  trades: Trade[],
  priceHistory: Record<string, Record<string, number>>,
  contestStartDate: string,
  options?: { today?: string; annualRiskFreeRate?: number }
): AdvancedStats
```

Rules:
- All series stats derive from one `buildDailyValueSeries` call.
- **Alpha/beta:** daily returns matched against `priceHistory["__BENCHMARK_SPY"]` on **common dates only** — never interpolate across gaps. OLS regression: `beta = cov(p, b) / var(b)`, `alpha = (meanP - beta * meanB) * 252` (expressed as annualized %). Require ≥ 20 matched return observations, else `null`.
- **Sortino:** downside deviation over the same daily returns (target = daily risk-free, default 0). Require ≥ 2 negative-excess observations for a meaningful denominator, else `null`.
- **Max drawdown:** running-peak scan of the value series. A monotonically rising series yields `0` (not null). Fewer than 2 points yields `null`.
- **Payoff ratio / avg win / avg loss:** from FIFO closed trades (same source as the existing win-rate calculation). `null` when there are no wins or no losses (payoff needs both).
- Every stat returns `null` on insufficient data; UI and email render `null` as "—". No fabricated numbers, no interpolation.

### 2.3 Surfaces

- **Dashboard:** extend the existing stats grid in `PlayerDetailCard` with max drawdown, volatility, Sortino, beta (alpha shown in the tooltip/secondary text), payoff ratio. Computed in `StockContestTracker` via `useMemo` alongside the existing leaderboard memo.
- **Email:** see Phase 3.3.
- **AI prompt:** unchanged. Stats are deterministic content rendered in the template only — the narrative/facts separation stays intact.

---

## Phase 3 — Email content

### 3.1 Per-player benchmark comparison

In each player's section of the weekly email: "Since contest start: {player} {±X.X%} · S&P 500 {±Y.Y%}" using existing `returnPct` and `getBenchmarkReturnAtDate(reportDate, priceHistory["__BENCHMARK_SPY"], contestStartDate)`. Omit the SPY half (render "—") if benchmark history is missing for the window; note it in the data-notes footer.

### 3.2 Milestone callouts

New pure function `detectMilestones(reportData, priorWeekLeaderboard): Milestone[]` in `lib/email.ts`, all deterministic:
- **Leader change:** #1 this week ≠ #1 last week (last week's standings are already computed for the week-over-week deltas).
- **New contest high:** a player's `totalValue` exceeds their previous all-time peak (from the daily value series).
- **Drawdown recovered:** player makes a new high after a drawdown ≥ 5%.

Rendered as a short banner row above the leaderboard when non-empty. The milestone list is appended to the AI prompt as pre-computed facts (same strict copy-don't-derive rules as the existing "biggest movers" block) so the commentary *may* reference them; the banner renders regardless of what the AI does.

### 3.3 Stats table

Compact per-player table in the email (below the existing closed-trades section): Return %, vs SPY, Max DD, Volatility, Sharpe, Sortino, Beta, Payoff. One row per player, `null` → "—". HTML + plain-text variants.

### 3.4 Data-notes footer

From Phase 1.4 — listed here because it ships in the same template edit.

---

## Error handling summary

| Failure | Before | After |
|---|---|---|
| Polygon returns prior session pre-4:20 PM | Written under today's key (corruption) | Written under bar's own date; UI warning |
| Backfill fails at email time | Audit-log only | Email footer note + degraded-data alert |
| VK fetch fails | Audit-log only | Email footer note + degraded-data alert |
| Ticker missing week-ago price | Silently dropped from highlights | Listed in email footer |
| Crash between SMTP-accept and DB write | Possible duplicate send on retry | `pending` audit row blocks re-send for 30 min |
| Insufficient data for a statistic | n/a (stat didn't exist) | `null` → rendered "—", never fabricated |

## Testing

- Vitest unit tests for every new/changed pure function: `persistPrices` date keying, `etDateFromMs` (UTC-midnight and late-evening ET edge cases), `addDays` across both 2026 DST transitions, idempotency with fresh/stale pending rows, `buildDailyValueSeries` (Sharpe regression tests unchanged), each `AdvancedStats` field including gap/insufficient-data cases, `detectMilestones`, template rendering with and without data notes.
- All date-sensitive tests pass explicit `today` (project lesson: never rely on `localToday()` in fixtures).
- Route tests: `/api/prices/update` response shape with stale bar dates.
- End-to-end before declaring done: dev server up, dashboard clicked through (stats render, Polygon warning path), email preview generated against the real DB and visually inspected.

## Sequencing / commits

1. **Phase 1 commit** — reliability fixes + tests.
2. **Phase 2 commit** — stats engine + dashboard surface + tests.
3. **Phase 3 commit** — email template upgrades + tests + live preview verification.

Each phase leaves the repo green (`npm test`, `npm run lint`). Stop-points at every phase boundary.
