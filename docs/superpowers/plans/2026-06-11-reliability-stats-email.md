# Reliability + Statistics + Email Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining silent data-corruption paths, add professional portfolio statistics (max drawdown, volatility, Sortino, alpha/beta, payoff ratio), and upgrade the weekly email with benchmark comparison, milestone callouts, a stats table, and data-quality transparency.

**Architecture:** Three sequential phases, each ending with a green test suite and a user-confirmed commit. Phase 1 fixes price-date keying at BOTH the server (`persistPrices`) and client (`applyPriceUpdate`) layers, adds a `pending` audit-row idempotency guard, and migrates local-time date math to UTC helpers. Phase 2 extracts a shared daily-value series builder and derives all new statistics from it in `lib/contest.ts`. Phase 3 threads `contestStartDate` into `WeeklyReportData` and renders the new content in both HTML and plain-text email templates.

**Tech Stack:** Next.js 16 / TypeScript 5 / better-sqlite3 / Vitest / nodemailer. Spec: `docs/superpowers/specs/2026-06-11-reliability-stats-email-design.md`.

**Project root:** `/Users/Yitzi/Desktop/stock-contest` (NOT `~/code/stock-contest`). All paths below are relative to this root. Run all commands from this root.

**House rules that override skill defaults:**
- Commits require Yitzi's confirmation. At each phase checkpoint, STOP, summarize, and ask before `git commit`. Never push without confirmation.
- If a fix fails twice, STOP and report rather than attempting a third fix.
- Every date-sensitive test passes explicit `today` — never rely on `localToday()` in fixtures.

---

## Phase 1 — Reliability

### Task 1: UTC date helpers `etDateFromMs` + `addDays`

**Files:**
- Modify: `lib/dates.ts`
- Test: `lib/dates.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/dates.test.ts` (follow the file's existing describe/it style):

```ts
describe("etDateFromMs", () => {
  it("returns the ET calendar date for a UTC-midnight-ET timestamp", () => {
    // 2026-06-10 00:00 ET (EDT, UTC-4) = 2026-06-10T04:00:00Z
    expect(etDateFromMs(Date.UTC(2026, 5, 10, 4, 0, 0))).toBe("2026-06-10");
  });

  it("does not roll to the next day when UTC date differs from ET date", () => {
    // 2026-06-10 23:30 ET = 2026-06-11T03:30:00Z — UTC says June 11, ET says June 10
    expect(etDateFromMs(Date.UTC(2026, 5, 11, 3, 30, 0))).toBe("2026-06-10");
  });

  it("handles EST (winter, UTC-5)", () => {
    // 2026-01-15 22:00 ET = 2026-01-16T03:00:00Z
    expect(etDateFromMs(Date.UTC(2026, 0, 16, 3, 0, 0))).toBe("2026-01-15");
  });
});

describe("addDays", () => {
  it("adds and subtracts days across month and year boundaries", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("is DST-safe across spring forward (2026-03-08)", () => {
    expect(addDays("2026-03-07", 7)).toBe("2026-03-14");
    expect(addDays("2026-03-09", -1)).toBe("2026-03-08");
  });

  it("is DST-safe across fall back (2026-11-01)", () => {
    expect(addDays("2026-11-02", -7)).toBe("2026-10-26");
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
  });
});
```

Add `etDateFromMs, addDays` to the import from `./dates` at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/dates.test.ts`
Expected: FAIL — `etDateFromMs is not a function` (or import error).

- [ ] **Step 3: Implement**

Append to `lib/dates.ts`:

```ts
// ET calendar date for a Unix-ms timestamp. Polygon daily bars are ET
// sessions; deriving the date via toISOString() (UTC) can roll past
// midnight and label the bar with the wrong day. en-CA renders YYYY-MM-DD.
export function etDateFromMs(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

// DST-safe day arithmetic on YYYY-MM-DD strings: compute in UTC where every
// day is exactly 86,400,000 ms. Local-time setDate() breaks on DST flips.
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/dates.test.ts`
Expected: PASS (all, including pre-existing).

### Task 2: `persistPrices` writes under the bar's real date

**Files:**
- Modify: `lib/prices-refresh.ts` (lines ~105–114 `persistPrices`, line ~245 IBKR call site, lines ~300–302 Polygon barDate, line ~322 Polygon call site)
- Create: `lib/prices-refresh.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/prices-refresh.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetContestData = vi.fn();
const mockSaveContestData = vi.fn();

vi.mock("@/lib/db", () => ({
  getContestData: (...args: unknown[]) => mockGetContestData(...args),
  saveContestData: (...args: unknown[]) => mockSaveContestData(...args),
}));

// @stoqey/ib loads native-ish deps; not needed for persistPrices tests.
vi.mock("@stoqey/ib", () => ({
  IBApi: class {},
  EventName: {},
  Contract: {},
  SecType: {},
  BarSizeSetting: {},
  WhatToShow: {},
}));

import { persistPrices } from "@/lib/prices-refresh";

describe("persistPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetContestData.mockReturnValue({
      currentPrices: { AAPL: 100 },
      priceHistory: { AAPL: { "2026-06-10": 100 } },
    });
  });

  it("writes each price under its own bar date, not today", () => {
    persistPrices(
      { AAPL: 105 },
      { AAPL: "2026-06-11" }, // prior session's bar (stale /prev response)
      "2026-06-12"
    );
    const saved = mockSaveContestData.mock.calls[0][0];
    expect(saved.priceHistory.AAPL["2026-06-11"]).toBe(105);
    expect(saved.priceHistory.AAPL["2026-06-12"]).toBeUndefined();
  });

  it("still updates currentPrices regardless of bar date", () => {
    persistPrices({ AAPL: 105 }, { AAPL: "2026-06-11" }, "2026-06-12");
    const saved = mockSaveContestData.mock.calls[0][0];
    expect(saved.currentPrices.AAPL).toBe(105);
  });

  it("falls back to today when no bar date is known", () => {
    persistPrices({ AAPL: 105 }, {}, "2026-06-12");
    const saved = mockSaveContestData.mock.calls[0][0];
    expect(saved.priceHistory.AAPL["2026-06-12"]).toBe(105);
  });

  it("preserves existing history entries", () => {
    persistPrices({ AAPL: 105 }, { AAPL: "2026-06-12" }, "2026-06-12");
    const saved = mockSaveContestData.mock.calls[0][0];
    expect(saved.priceHistory.AAPL["2026-06-10"]).toBe(100);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/prices-refresh.test.ts`
Expected: FAIL — `persistPrices` is not exported.

- [ ] **Step 3: Implement**

In `lib/prices-refresh.ts`, replace `persistPrices` (currently lines 105–114):

```ts
// Persist refreshed prices. priceHistory entries are keyed by the bar's REAL
// date (priceDates), not "today": Polygon /prev called pre-publication and
// IBKR off-hours both return the PRIOR session's close. Writing it under
// today's key was the root cause of the recurring stale-Friday-email bug —
// under its own date it's just legitimate history (same as backfill).
// currentPrices still updates either way: the most recent known close is the
// best available current estimate regardless of which session produced it.
export function persistPrices(
  updated: Record<string, number>,
  priceDates: Record<string, string>,
  today: string
) {
  const contestData = getContestData();
  const currentPrices = { ...contestData.currentPrices, ...updated };
  const priceHistory = { ...contestData.priceHistory };
  for (const [ticker, price] of Object.entries(updated)) {
    if (!priceHistory[ticker]) priceHistory[ticker] = {};
    priceHistory[ticker] = {
      ...priceHistory[ticker],
      [priceDates[ticker] ?? today]: price,
    };
  }
  saveContestData({ currentPrices, priceHistory });
}
```

Update both call sites:
- IBKR (line ~245): `persistPrices(updated, priceDates, today);`
- Polygon (line ~322): `persistPrices(updated, priceDates, today);`

Fix the Polygon bar-date derivation (lines ~300–302). Replace:

```ts
const barDate = data.results[0].t
  ? new Date(data.results[0].t).toISOString().split("T")[0]
  : undefined;
```

with:

```ts
const barDate = data.results[0].t ? etDateFromMs(data.results[0].t) : undefined;
```

and change the dates import (line 15) to:

```ts
import { localToday, etDateFromMs } from "@/lib/dates";
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/prices-refresh.test.ts && npx vitest run app/api/prices/route.test.ts`
Expected: PASS. If `app/api/prices/route.test.ts` asserts on history-keying behavior, update those assertions to the new bar-date semantics (the test change must reflect the spec, not be reverse-engineered to pass).

### Task 3: Client mirrors bar-date keying + shows stale-bar note

**Files:**
- Modify: `app/dashboard/components/DashboardTab.tsx` (`applyPriceUpdate` lines 58–78, `refreshPrices` lines 141–160)

No unit test (UI wiring; covered by the Phase 1 e2e check in Task 8). The server fix alone is insufficient: `applyPriceUpdate` writes `priceHistory[ticker][data.date]` into client state, and the debounced `PUT /api/contest` persists client `priceHistory` wholesale — re-corrupting the DB from the browser.

- [ ] **Step 1: Update `applyPriceUpdate` to key by bar date**

Replace the function (lines 58–78) with:

```tsx
const applyPriceUpdate = (
  data: {
    updated: Record<string, number>;
    date: string;
    priceDates?: Record<string, string>;
    errors?: string[];
  },
  source: string
) => {
  setCurrentPrices((prev) => ({ ...prev, ...data.updated }));
  setPriceHistory((prev) => {
    const next = { ...prev };
    for (const [ticker, price] of Object.entries(data.updated)) {
      // Mirror the server: key by the bar's real date so a prior-session
      // close never lands under today's key (debounced PUT persists this).
      const barDate = data.priceDates?.[ticker] ?? data.date;
      if (!next[ticker]) next[ticker] = {};
      next[ticker] = { ...next[ticker], [barDate]: price };
    }
    return next;
  });
  const count = Object.keys(data.updated).length;
  const msg = `Updated ${count} price${count !== 1 ? "s" : ""} via ${source}`;
  if (data.errors?.length) {
    const failedTickers = data.errors.map(e => e.split(':')[0].trim());
    setRefreshStatus(`${msg} (failed: ${failedTickers.join(', ')})`);
  } else {
    setRefreshStatus(msg);
  }
  setLastRefreshed(new Date().toLocaleString());
};
```

- [ ] **Step 2: Surface a stale-bar note after refresh**

In `refreshPrices`, immediately after `applyPriceUpdate(data, source === "ibkr" ? "IBKR TWS" : "Polygon");` (line ~145), insert:

```tsx
const staleBars = Object.entries(
  (data.priceDates ?? {}) as Record<string, string>
).filter(([, d]) => d !== data.date);
if (staleBars.length > 0) {
  setRefreshStatus(
    (prev) =>
      `${prev} — note: prior-session closes for ${staleBars
        .map(([t, d]) => `${t} (${d})`)
        .join(", ")}, stored under their own dates. For today's close retry after ~4:20 PM ET.`
  );
}
```

- [ ] **Step 3: Verify compile**

Run: `npx tsc --noEmit`
Expected: no errors.

### Task 4: DB support for `pending` send rows

**Files:**
- Modify: `lib/db.ts` (lines 230–282, email-sends section)
- Test: `lib/db.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/db.test.ts` (it already uses `new Database(":memory:")` + `_initSchema` + `_resetDbForTesting` — follow the established pattern in that file):

```ts
describe("pending email sends", () => {
  it("recordEmailSend returns the inserted row id", () => {
    const id = recordEmailSend({ kind: "weekly", status: "pending", reportDate: "2026-06-12" });
    expect(id).toBeGreaterThan(0);
  });

  it("updateEmailSend updates status and preserves unset fields", () => {
    const id = recordEmailSend({
      kind: "weekly", status: "pending", reportDate: "2026-06-12", recipients: 3,
    });
    updateEmailSend(id, { status: "ok", numericViolations: 0, rankingViolations: 1 });
    const rows = listRecentEmailSends(5);
    const row = rows.find((r) => r.id === id)!;
    expect(row.status).toBe("ok");
    expect(row.recipients_count).toBe(3); // preserved
    expect(row.ranking_violations).toBe(1);
  });

  it("findBlockingWeeklySend returns ok rows for the date regardless of age", () => {
    recordEmailSend({ kind: "weekly", status: "ok", reportDate: "2026-06-12" });
    const row = findBlockingWeeklySend("2026-06-12", Date.now() + 1000);
    expect(row?.status).toBe("ok");
  });

  it("findBlockingWeeklySend returns recent pending rows but not stale ones", () => {
    const id = recordEmailSend({ kind: "weekly", status: "pending", reportDate: "2026-06-12" });
    expect(findBlockingWeeklySend("2026-06-12", Date.now() - 60_000)?.id).toBe(id);
    // pendingSince in the future = row is older than the window
    expect(findBlockingWeeklySend("2026-06-12", Date.now() + 60_000)).toBeUndefined();
  });

  it("findBlockingWeeklySend ignores error/skipped rows and other dates", () => {
    recordEmailSend({ kind: "weekly", status: "error", reportDate: "2026-06-12" });
    recordEmailSend({ kind: "weekly", status: "skipped", reportDate: "2026-06-12" });
    recordEmailSend({ kind: "weekly", status: "ok", reportDate: "2026-06-05" });
    expect(findBlockingWeeklySend("2026-06-12", 0)).toBeUndefined();
  });
});
```

Add `updateEmailSend, findBlockingWeeklySend` to the `@/lib/db` import in the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/db.test.ts`
Expected: FAIL — `updateEmailSend` not exported; `recordEmailSend` returns void.

- [ ] **Step 3: Implement**

In `lib/db.ts`:

Change the status type (line 231):

```ts
export type EmailSendStatus = "ok" | "skipped" | "error" | "pending";
```

Change `recordEmailSend` to return the row id (replace the function, lines 256–275):

```ts
export function recordEmailSend(input: RecordEmailSendInput): number {
  const conn = getDb();
  const info = conn
    .prepare(
      `INSERT INTO email_sends
         (timestamp, kind, status, recipients_count, report_date,
          numeric_violations, ranking_violations, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Date.now(),
      input.kind,
      input.status,
      input.recipients ?? null,
      input.reportDate ?? null,
      input.numericViolations ?? null,
      input.rankingViolations ?? null,
      input.errorMessage ?? null
    );
  return Number(info.lastInsertRowid);
}
```

Append after `recordEmailSend`:

```ts
export interface UpdateEmailSendFields {
  status: EmailSendStatus;
  recipients?: number;
  numericViolations?: number;
  rankingViolations?: number;
  errorMessage?: string;
}

// Transition a pending row to its final state. COALESCE preserves any field
// the caller doesn't supply (e.g. recipients recorded at pending time).
export function updateEmailSend(id: number, fields: UpdateEmailSendFields): void {
  const conn = getDb();
  conn
    .prepare(
      `UPDATE email_sends SET
         status = ?,
         recipients_count = COALESCE(?, recipients_count),
         numeric_violations = COALESCE(?, numeric_violations),
         ranking_violations = COALESCE(?, ranking_violations),
         error_message = COALESCE(?, error_message)
       WHERE id = ?`
    )
    .run(
      fields.status,
      fields.recipients ?? null,
      fields.numericViolations ?? null,
      fields.rankingViolations ?? null,
      fields.errorMessage ?? null,
      id
    );
}

// Idempotency lookup: a weekly send for this report date is "blocking" if it
// completed (ok, any age) or is in-flight (pending, newer than pendingSince).
// A pending row older than the window is a crashed attempt and does NOT block.
export function findBlockingWeeklySend(
  reportDate: string,
  pendingSince: number
): EmailSendRow | undefined {
  const conn = getDb();
  return conn
    .prepare(
      `SELECT * FROM email_sends
       WHERE kind = 'weekly' AND report_date = ?
         AND (status = 'ok' OR (status = 'pending' AND timestamp >= ?))
       ORDER BY id DESC LIMIT 1`
    )
    .get(reportDate, pendingSince) as EmailSendRow | undefined;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/db.test.ts`
Expected: PASS.

### Task 5: `runWeeklyEmail` pending-row idempotency

**Files:**
- Modify: `lib/email-flow.ts`
- Create: `lib/email-flow.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/email-flow.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  getContestData: vi.fn(),
  saveContestData: vi.fn(),
  recordEmailSend: vi.fn().mockReturnValue(101),
  updateEmailSend: vi.fn(),
  findBlockingWeeklySend: vi.fn().mockReturnValue(undefined),
};
vi.mock("@/lib/db", () => db);

const email = {
  buildReportData: vi.fn(),
  buildWeeklyHighlights: vi.fn().mockReturnValue({ warnings: [] }),
  generateCommentary: vi.fn().mockResolvedValue({
    text: "commentary",
    violations: { numericViolations: 0, rankingViolations: 0, numericSnippets: [], rankingSnippets: [] },
    factual: { missedTrades: [], unknownTickers: [] },
    verifierErrors: [],
    attempts: 1,
  }),
  sendWeeklyEmail: vi.fn().mockResolvedValue(undefined),
};
vi.mock("@/lib/email", () => email);

vi.mock("@/lib/vital-knowledge", () => ({
  fetchVitalKnowledge: vi.fn().mockResolvedValue("market context"),
}));
vi.mock("@/lib/prices", () => ({
  backfillPrices: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/prices-refresh", () => ({
  refreshAllOpenPrices: vi.fn().mockResolvedValue({
    source: "ibkr", updated: { AAPL: 100 }, priceDates: { AAPL: "2026-06-12" },
    errors: [], date: "2026-06-12", pricesAreFresh: true, staleRetries: 0,
  }),
  NoOpenPositionsError: class NoOpenPositionsError extends Error {},
}));

import { runWeeklyEmail } from "@/lib/email-flow";

const REPORT_DATE = "2026-06-12";

function contestDataFixture() {
  return {
    players: [{ id: "p1", name: "Yitzi", color: "#000" }],
    trades: [],
    currentPrices: {},
    priceHistory: {},
    contestStartDate: "2026-01-14",
    gmailAddress: "a@b.com",
    gmailAppPassword: "pw",
    anthropicApiKey: "key",
    aiModel: "claude-sonnet-4-5-20250929",
    playerEmails: { p1: "yitzi@example.com" },
    lastWeeklyEmailSentDate: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.recordEmailSend.mockReturnValue(101);
  db.findBlockingWeeklySend.mockReturnValue(undefined);
  db.getContestData.mockReturnValue(contestDataFixture());
  email.buildReportData.mockReturnValue({
    leaderboard: [], weeklyTrades: [], weekDeltas: [], players: [], trades: [],
    currentPrices: {}, priceHistory: {}, reportDate: REPORT_DATE,
  });
  email.sendWeeklyEmail.mockResolvedValue(undefined);
});

describe("runWeeklyEmail pending-row idempotency", () => {
  it("inserts a pending row BEFORE sending and finalizes it to ok", async () => {
    await runWeeklyEmail();
    const pendingCall = db.recordEmailSend.mock.calls.find(
      (c) => c[0].status === "pending"
    );
    expect(pendingCall).toBeDefined();
    expect(db.recordEmailSend.mock.invocationCallOrder[0]).toBeLessThan(
      email.sendWeeklyEmail.mock.invocationCallOrder[0]
    );
    expect(db.updateEmailSend).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ status: "ok" })
    );
  });

  it("marks the pending row error and rethrows when SMTP fails", async () => {
    email.sendWeeklyEmail.mockRejectedValueOnce(new Error("smtp down"));
    await expect(runWeeklyEmail()).rejects.toThrow("smtp down");
    expect(db.updateEmailSend).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ status: "error" })
    );
    expect(db.saveContestData).not.toHaveBeenCalledWith(
      expect.objectContaining({ lastWeeklyEmailSentDate: expect.anything() })
    );
  });

  it("skips when a blocking row exists (in-flight pending)", async () => {
    db.findBlockingWeeklySend.mockReturnValue({ id: 7, status: "pending" });
    const result = await runWeeklyEmail();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("send_in_progress");
    expect(email.sendWeeklyEmail).not.toHaveBeenCalled();
  });

  it("still skips on same-day lastWeeklyEmailSentDate", async () => {
    db.getContestData.mockReturnValue({
      ...contestDataFixture(),
      lastWeeklyEmailSentDate: new Date().getFullYear() + "-",
    });
    // (kept loose — the real check compares to localToday(); covered below)
  });

  it("test sends bypass the pending machinery", async () => {
    await runWeeklyEmail({ testTo: "x@y.com" });
    const pendingCall = db.recordEmailSend.mock.calls.find(
      (c) => c[0].status === "pending"
    );
    expect(pendingCall).toBeUndefined();
    expect(db.updateEmailSend).not.toHaveBeenCalled();
    // final audit row still written
    expect(db.recordEmailSend).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok" })
    );
  });
});
```

Delete the placeholder `"still skips on same-day lastWeeklyEmailSentDate"` test before committing if it stays unimplementable without clock control — the existing same-day path is already covered by the route tests; do not fake it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/email-flow.test.ts`
Expected: FAIL — `send_in_progress` reason doesn't exist; no pending row inserted.

- [ ] **Step 3: Implement in `lib/email-flow.ts`**

Update the db import (line 9):

```ts
import {
  getContestData,
  saveContestData,
  recordEmailSend,
  updateEmailSend,
  findBlockingWeeklySend,
} from "@/lib/db";
```

Add a constant near the top (after `BACKFILL_RETRY_TIMEOUT_MS`):

```ts
// A pending audit row younger than this blocks a duplicate send; older is
// treated as a crashed attempt and does not block.
const PENDING_BLOCK_MS = 30 * 60 * 1000;
```

Replace the idempotency block (lines 133–162). Keep the early-return object identical except `reason` becomes dynamic:

```ts
if (!testTo && !force) {
  const { lastWeeklyEmailSentDate } = getContestData();
  const blocking = findBlockingWeeklySend(today, Date.now() - PENDING_BLOCK_MS);
  if (lastWeeklyEmailSentDate === today || blocking) {
    recordEmailSend({ kind: "weekly", status: "skipped", reportDate: today });
    return {
      ok: true,
      skipped: true,
      reason: blocking?.status === "pending" ? "send_in_progress" : "already_sent_today",
      // ... rest of the existing skip-result literal unchanged ...
    };
  }
}
```

Replace the send/record tail (lines 275–306) with:

```ts
// Insert the pending row BEFORE the SMTP call: if the process dies between
// SMTP-accept and bookkeeping, the pending row blocks a duplicate send for
// PENDING_BLOCK_MS. Test sends bypass (retryable dry-runs by design).
let pendingId: number | null = null;
if (!testTo) {
  pendingId = recordEmailSend({
    kind: "weekly",
    status: "pending",
    recipients: recipients.length,
    reportDate: reportData.reportDate,
  });
}

try {
  await sendWeeklyEmail(
    { gmailAddress, gmailAppPassword, anthropicApiKey, playerEmails: effectiveEmails },
    reportData,
    commentary
  );
} catch (err) {
  if (pendingId != null) {
    updateEmailSend(pendingId, {
      status: "error",
      errorMessage: `SMTP send failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000),
    });
  }
  throw err;
}

if (!testTo) {
  saveContestData({ lastWeeklyEmailSentDate: reportData.reportDate });
}

const auditFields = {
  numericViolations: violations.numericViolations,
  // Aggregate all factual residuals (regex-detected + verifier-pass) into
  // the ranking_violations DB column. The audit row's error_message
  // captures the detail when residuals are non-zero.
  rankingViolations:
    violations.rankingViolations +
    factual.missedTrades.length +
    factual.unknownTickers.length +
    verifierErrors.length,
  errorMessage:
    factual.missedTrades.length || factual.unknownTickers.length || verifierErrors.length
      ? `Residual violations after ${attempts} attempts: ` +
        `missed=${JSON.stringify(factual.missedTrades.slice(0, 5))} ` +
        `unknownTickers=${JSON.stringify(factual.unknownTickers.slice(0, 5).map((u) => u.ticker))} ` +
        `verifier=${JSON.stringify(verifierErrors.slice(0, 5))}`
      : undefined,
};
if (pendingId != null) {
  updateEmailSend(pendingId, { status: "ok", ...auditFields });
} else {
  recordEmailSend({
    kind: "weekly",
    status: "ok",
    recipients: recipients.length,
    reportDate: reportData.reportDate,
    ...auditFields,
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/email-flow.test.ts && npx vitest run app/api/email/weekly/route.test.ts`
Expected: PASS. If the weekly route test mocks `@/lib/db` without `updateEmailSend`/`findBlockingWeeklySend`, add those two stubs to its mock factory (`updateEmailSend: vi.fn(), findBlockingWeeklySend: vi.fn().mockReturnValue(undefined)`).

### Task 6: UTC date-arithmetic sweep

**Files:**
- Modify: `lib/contest.ts` (`getPeriodStartDate`, lines 609–637)
- Modify: `lib/email.ts` (cutoff computation in `buildReportData` lines 94–96 and `buildWeeklyHighlights` lines 195–198)
- Test: `lib/contest.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/contest.test.ts`:

```ts
describe("getPeriodStartDate DST safety", () => {
  it("1W across spring forward lands exactly 7 calendar days back", () => {
    expect(getPeriodStartDate("1W", "2026-01-14", "2026-03-12")).toBe("2026-03-05");
  });
  it("1D across fall back", () => {
    expect(getPeriodStartDate("1D", "2026-01-14", "2026-11-02")).toBe("2026-11-01");
  });
  it("1M across spring forward", () => {
    expect(getPeriodStartDate("1M", "2026-01-14", "2026-03-20")).toBe("2026-02-18");
  });
  it("YTD and ALL unchanged", () => {
    expect(getPeriodStartDate("YTD", "2026-01-14", "2026-06-12")).toBe("2026-01-01");
    expect(getPeriodStartDate("ALL", "2026-01-14", "2026-06-12")).toBe("2026-01-14");
  });
});
```

- [ ] **Step 2: Run to verify status**

Run: `npx vitest run lib/contest.test.ts`
Expected: these may PASS already in TZs where local math happens to work — that's fine; they pin the contract. Continue regardless.

- [ ] **Step 3: Implement**

Replace `getPeriodStartDate` in `lib/contest.ts`:

```ts
export function getPeriodStartDate(
  period: Period,
  contestStartDate: string,
  today?: string
): string {
  const t = today || localToday();
  switch (period) {
    case "1D":
      return addDays(t, -1);
    case "1W":
      return addDays(t, -7);
    case "1M":
      return addDays(t, -30);
    case "YTD":
      return `${t.slice(0, 4)}-01-01`;
    case "ALL":
      return contestStartDate;
  }
}
```

Update the import at the top of `lib/contest.ts`:

```ts
import { formatLocalYMD, localToday, parseLocalDate, addDays } from "./dates";
```

In `lib/email.ts` `buildReportData` (lines 94–96), replace:

```ts
const oneWeekAgo = parseLocalDate(reportDate);
oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
const cutoffDate = formatLocalYMD(oneWeekAgo);
```

with:

```ts
const cutoffDate = addDays(reportDate, -7);
```

In `buildWeeklyHighlights` (lines 195–198), replace:

```ts
const now = parseLocalDate(reportDate);
const oneWeekAgo = new Date(now);
oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
const cutoffDate = formatLocalYMD(oneWeekAgo);
```

with:

```ts
const cutoffDate = addDays(reportDate, -7);
```

Add `addDays` to the `@/lib/dates` import in `lib/email.ts`. Remove `parseLocalDate`/`formatLocalYMD` from that import ONLY if no other usage remains (grep the file first: `grep -n "parseLocalDate\|formatLocalYMD" lib/email.ts`).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — these are behavior-identical rewrites except on DST-transition dates.

### Task 7: Degraded-data alert on the success path

**Files:**
- Modify: `scripts/run-weekly-email.ts` (after the warning log lines, ~111–119)

- [ ] **Step 1: Implement** (no unit test — standalone script; verified in Task 8 e2e)

In `scripts/run-weekly-email.ts`, replace the three warning `if` blocks (lines 111–119) with:

```ts
const degraded: string[] = [];
if (result.highlightsWarnings.length > 0) {
  logStep("email", `highlights warnings: ${result.highlightsWarnings.join("; ")}`);
  degraded.push(`Highlights excluded tickers:\n  ${result.highlightsWarnings.join("\n  ")}`);
}
if (result.backfillFailed) {
  logStep("email", "WARNING: backfill failed earlier; week deltas may use stale prices");
  degraded.push("Backfill failed — week-over-week deltas may use the most recent available close.");
}
if (result.vk.fetchFailed) {
  logStep("email", "WARNING: VK creds configured but fetch returned 0 chars");
  degraded.push("Vital Knowledge market context was unavailable (creds configured, 0 chars returned).");
}
if (degraded.length > 0) {
  // Non-fatal: the weekly email DID go out; this tells the operator that it
  // shipped with known data gaps, without requiring an audit-table check.
  await sendFailureAlert({
    source: "weekly-email",
    reason: "sent OK but with degraded data",
    details: degraded.join("\n\n") + `\n\nreportDate=${result.reportDate}`,
  });
  logStep("email", "degraded-data alert sent to operator");
}
```

- [ ] **Step 2: Verify compile**

Run: `npx tsc --noEmit`
Expected: no errors.

### Task 8: Phase 1 checkpoint

- [ ] **Step 1: Full verification**

Run: `npm test && npm run lint`
Expected: all tests pass (326 pre-existing + new), lint clean.

- [ ] **Step 2: E2E spot-check**

Start the dev server (`npm run dev`, port 3001). On the Dashboard, click **Refresh Prices (Polygon)** during off-hours if possible; confirm the status line shows the prior-session note and `data/contest.db` gets the price under the bar's date, not today (inspect: `sqlite3 data/contest.db "SELECT value FROM contest_data WHERE key='priceHistory'" | head -c 2000`). Confirm normal IBKR refresh still works.

- [ ] **Step 3: STOP — ask Yitzi to confirm the Phase 1 commit**

Proposed message: `Reliability: bar-date price keying, pending-row send idempotency, UTC date math, degraded-data alerts`

---

## Phase 2 — Statistics

### Task 9: Extract `buildDailyValueSeries`; refactor Sharpe onto it

**Files:**
- Modify: `lib/contest.ts` (insert before `getPlayerSharpeRatio`, line ~422)
- Test: `lib/contest.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/contest.test.ts`:

```ts
describe("buildDailyValueSeries", () => {
  const trades: Trade[] = [
    { id: "1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 10, price: 100, date: "2026-02-02", timestamp: 1 },
  ];
  const priceHistory = {
    AAPL: { "2026-02-02": 100, "2026-02-03": 110, "2026-02-04": 105 },
  };

  it("returns one sorted point per known date within [start, today]", () => {
    const series = buildDailyValueSeries("p1", trades, priceHistory, "2026-02-02", "2026-02-04");
    expect(series.map((p) => p.date)).toEqual(["2026-02-02", "2026-02-03", "2026-02-04"]);
    // 10 shares: 100k flat, then +100, then -50 from cost
    expect(series.map((p) => p.value)).toEqual([100000, 100100, 100050]);
  });

  it("excludes dates outside the window", () => {
    const series = buildDailyValueSeries("p1", trades, priceHistory, "2026-02-03", "2026-02-03");
    expect(series.map((p) => p.date)).toEqual(["2026-02-03"]);
  });
});
```

(Use the test file's existing `Trade` fixture style; if it has a helper for building trades, use it.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/contest.test.ts`
Expected: FAIL — `buildDailyValueSeries` not exported.

- [ ] **Step 3: Implement + refactor Sharpe**

Insert before `getPlayerSharpeRatio` in `lib/contest.ts`:

```ts
// Daily time series of a player's total portfolio value (cash + positions
// at historical prices). One point per date that appears in the player's
// trades or anywhere in priceHistory, restricted to [contestStartDate,
// today]. This is the single source for every series-derived statistic
// (Sharpe, drawdown, volatility, Sortino, alpha/beta).
export function buildDailyValueSeries(
  playerId: string,
  trades: Trade[],
  priceHistory: Record<string, Record<string, number>>,
  contestStartDate: string,
  today?: string
): { date: string; value: number }[] {
  const resolvedToday = today || localToday();
  const dateSet = new Set<string>();
  trades
    .filter((t) => t.playerId === playerId)
    .forEach((t) => dateSet.add(t.date));
  Object.values(priceHistory).forEach((history) => {
    Object.keys(history).forEach((d) => dateSet.add(d));
  });
  return [...dateSet]
    .filter((d) => d >= contestStartDate && d <= resolvedToday)
    .sort()
    .map((date) => ({
      date,
      value: getPlayerValueAtDate(playerId, date, trades, priceHistory),
    }));
}
```

Refactor `getPlayerSharpeRatio` to consume it — replace the body's date/value assembly (lines 438–453) with:

```ts
const series = buildDailyValueSeries(
  playerId, trades, priceHistory, contestStartDate, options?.today
);
if (series.length < 2) return null;

const excessReturns: number[] = [];
for (let i = 1; i < series.length; i++) {
  const prev = series[i - 1].value;
  if (prev <= 0) continue;
  const r = (series[i].value - prev) / prev;
  excessReturns.push(r - dailyRF);
}
```

(The rest of the function — mean/variance/stdev/annualization — is unchanged.)

- [ ] **Step 4: Run tests — existing Sharpe tests MUST pass unmodified**

Run: `npx vitest run lib/contest.test.ts`
Expected: PASS, including every pre-existing Sharpe test with zero edits. If a Sharpe test fails, the refactor changed behavior — fix the refactor, never the test.

### Task 10: `getAdvancedStats`

**Files:**
- Modify: `lib/contest.ts` (insert after `getPlayerSharpeRatio`)
- Test: `lib/contest.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/contest.test.ts`:

```ts
describe("getAdvancedStats", () => {
  const buy = (ticker: string, shares: number, price: number, date: string, ts: number): Trade =>
    ({ id: `b${ts}`, playerId: "p1", type: "buy", ticker, shares, price, date, timestamp: ts });
  const sell = (ticker: string, shares: number, price: number, date: string, ts: number): Trade =>
    ({ id: `s${ts}`, playerId: "p1", type: "sell", ticker, shares, price, date, timestamp: ts });

  it("computes max drawdown with peak and trough dates", () => {
    const trades = [buy("AAPL", 1000, 100, "2026-02-02", 1)];
    const priceHistory = {
      AAPL: {
        "2026-02-02": 100, "2026-02-03": 110, "2026-02-04": 99,
        "2026-02-05": 104,
      },
    };
    const s = getAdvancedStats("p1", trades, priceHistory, "2026-02-02", { today: "2026-02-05" });
    // peak value 110k (02-03), trough 99k (02-04): dd = -11/110 = -10%
    expect(s.maxDrawdownPct).toBeCloseTo(-10, 5);
    expect(s.maxDrawdownPeakDate).toBe("2026-02-03");
    expect(s.maxDrawdownTroughDate).toBe("2026-02-04");
  });

  it("returns 0 drawdown (null dates) for a monotonic rise", () => {
    const trades = [buy("AAPL", 1000, 100, "2026-02-02", 1)];
    const priceHistory = { AAPL: { "2026-02-02": 100, "2026-02-03": 101, "2026-02-04": 102 } };
    const s = getAdvancedStats("p1", trades, priceHistory, "2026-02-02", { today: "2026-02-04" });
    expect(s.maxDrawdownPct).toBe(0);
    expect(s.maxDrawdownPeakDate).toBeNull();
    expect(s.maxDrawdownTroughDate).toBeNull();
  });

  it("returns nulls on insufficient data", () => {
    const s = getAdvancedStats("p1", [], {}, "2026-02-02", { today: "2026-02-02" });
    expect(s.maxDrawdownPct).toBeNull();
    expect(s.annualizedVolatilityPct).toBeNull();
    expect(s.sortino).toBeNull();
    expect(s.beta).toBeNull();
    expect(s.payoffRatio).toBeNull();
  });

  it("computes annualized volatility from daily returns", () => {
    const trades = [buy("AAPL", 1000, 100, "2026-02-02", 1)];
    const priceHistory = { AAPL: { "2026-02-02": 100, "2026-02-03": 110, "2026-02-04": 99 } };
    const s = getAdvancedStats("p1", trades, priceHistory, "2026-02-02", { today: "2026-02-04" });
    // returns: +10%, -10% on 100k base → +0.1, -0.1 portfolio? No: portfolio
    // includes no cash here (all-in), values 100k/110k/99k → 0.10, -0.10
    expect(s.annualizedVolatilityPct).not.toBeNull();
    expect(s.annualizedVolatilityPct!).toBeGreaterThan(0);
  });

  it("requires 20 matched observations for beta, else null", () => {
    const trades = [buy("AAPL", 100, 100, "2026-02-02", 1)];
    const priceHistory = {
      AAPL: { "2026-02-02": 100, "2026-02-03": 101 },
      [BENCHMARK_KEY]: { "2026-02-02": 500, "2026-02-03": 505 },
    };
    const s = getAdvancedStats("p1", trades, priceHistory, "2026-02-02", { today: "2026-02-03" });
    expect(s.beta).toBeNull();
    expect(s.alphaAnnualizedPct).toBeNull();
  });

  it("computes beta ≈ 1 for a portfolio tracking the benchmark exactly", () => {
    // 30 days where the player's single holding moves in lockstep with SPY.
    const aapl: Record<string, number> = {};
    const spy: Record<string, number> = {};
    let price = 100;
    for (let i = 0; i < 30; i++) {
      const date = `2026-03-${String(i + 1).padStart(2, "0")}`;
      price = price * (1 + (i % 2 === 0 ? 0.01 : -0.005));
      aapl[date] = price;
      spy[date] = price * 5;
    }
    // All-in: 1000 shares, no cash drag distortion beyond constant offset
    const trades = [buy("AAPL", 1000, 100, "2026-03-01", 1)];
    const s = getAdvancedStats(
      "p1", trades, { AAPL: aapl, [BENCHMARK_KEY]: spy }, "2026-03-01", { today: "2026-03-30" }
    );
    expect(s.beta).not.toBeNull();
    // Portfolio = 100k cash-less equivalent... position is 100k of 100k: beta ≈ 1
    expect(s.beta!).toBeGreaterThan(0.9);
    expect(s.beta!).toBeLessThan(1.1);
  });

  it("computes payoff ratio and avg win/loss from closed trades", () => {
    const trades = [
      buy("A", 10, 100, "2026-02-02", 1),
      sell("A", 10, 120, "2026-02-10", 2),  // +$200 win (+20%)
      buy("B", 10, 100, "2026-02-03", 3),
      sell("B", 10, 90, "2026-02-11", 4),   // -$100 loss (-10%)
    ];
    const s = getAdvancedStats("p1", trades, {}, "2026-02-02", { today: "2026-02-12" });
    expect(s.payoffRatio).toBeCloseTo(2.0, 5);   // avg win $200 / avg loss $100
    expect(s.avgWinPct).toBeCloseTo(20, 5);
    expect(s.avgLossPct).toBeCloseTo(-10, 5);
  });

  it("payoff ratio is null without both wins and losses", () => {
    const trades = [buy("A", 10, 100, "2026-02-02", 1), sell("A", 10, 120, "2026-02-10", 2)];
    const s = getAdvancedStats("p1", trades, {}, "2026-02-02", { today: "2026-02-12" });
    expect(s.payoffRatio).toBeNull();
    expect(s.avgWinPct).toBeCloseTo(20, 5);
    expect(s.avgLossPct).toBeNull();
  });
});
```

Add `buildDailyValueSeries, getAdvancedStats, BENCHMARK_KEY` to the test file's import from `@/lib/contest` as needed.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/contest.test.ts`
Expected: FAIL — `getAdvancedStats` not exported.

- [ ] **Step 3: Implement**

Insert after `getPlayerSharpeRatio` in `lib/contest.ts`. Note `BENCHMARK_KEY` is currently declared at line ~729 — MOVE its declaration up to the constants section (after `DEFAULT_POSITION_SIZE`, line 74) so it's defined before use, keeping the same `export const BENCHMARK_KEY = "__BENCHMARK_SPY";` text (delete the old line).

```ts
export interface AdvancedStats {
  maxDrawdownPct: number | null;        // peak-to-trough, negative %
  maxDrawdownPeakDate: string | null;
  maxDrawdownTroughDate: string | null;
  annualizedVolatilityPct: number | null;
  sortino: number | null;
  beta: number | null;                  // vs __BENCHMARK_SPY daily returns
  alphaAnnualizedPct: number | null;    // annualized OLS intercept, in %
  payoffRatio: number | null;           // avg win $ / |avg loss $|
  avgWinPct: number | null;
  avgLossPct: number | null;
}

// Minimum matched player/benchmark daily-return pairs before alpha/beta are
// reported. Below this the regression is noise, so we show "—" instead.
const MIN_BENCHMARK_OBSERVATIONS = 20;

export function getAdvancedStats(
  playerId: string,
  trades: Trade[],
  priceHistory: Record<string, Record<string, number>>,
  contestStartDate: string,
  options?: { today?: string; annualRiskFreeRate?: number }
): AdvancedStats {
  const annualRF = options?.annualRiskFreeRate ?? 0;
  const dailyRF = annualRF / 252;
  const series = buildDailyValueSeries(
    playerId, trades, priceHistory, contestStartDate, options?.today
  );

  // --- Max drawdown (running-peak scan) ---
  let maxDrawdownPct: number | null = null;
  let maxDrawdownPeakDate: string | null = null;
  let maxDrawdownTroughDate: string | null = null;
  if (series.length >= 2) {
    let peak = series[0];
    let worst = 0;
    let worstPeak: typeof peak | null = null;
    let worstTrough: typeof peak | null = null;
    for (const point of series) {
      if (point.value > peak.value) peak = point;
      if (peak.value > 0) {
        const dd = ((point.value - peak.value) / peak.value) * 100;
        if (dd < worst) {
          worst = dd;
          worstPeak = peak;
          worstTrough = point;
        }
      }
    }
    maxDrawdownPct = worst;
    maxDrawdownPeakDate = worstPeak?.date ?? null;
    maxDrawdownTroughDate = worstTrough?.date ?? null;
  }

  // --- Daily returns (gaps excluded by construction: consecutive points) ---
  const dailyReturns: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].value;
    if (prev <= 0) continue;
    dailyReturns.push((series[i].value - prev) / prev);
  }

  // --- Annualized volatility ---
  let annualizedVolatilityPct: number | null = null;
  if (dailyReturns.length >= 2) {
    const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) /
      (dailyReturns.length - 1);
    annualizedVolatilityPct = Math.sqrt(variance) * Math.sqrt(252) * 100;
  }

  // --- Sortino (downside deviation, full-n denominator) ---
  let sortino: number | null = null;
  if (dailyReturns.length >= 2) {
    const excess = dailyReturns.map((r) => r - dailyRF);
    const downside = excess.filter((r) => r < 0);
    if (downside.length >= 2) {
      const meanExcess = excess.reduce((s, r) => s + r, 0) / excess.length;
      const downsideDev = Math.sqrt(
        downside.reduce((s, r) => s + r ** 2, 0) / excess.length
      );
      if (downsideDev > 0) sortino = (meanExcess / downsideDev) * Math.sqrt(252);
    }
  }

  // --- Alpha / beta vs SPY (common dates only — never interpolate) ---
  let beta: number | null = null;
  let alphaAnnualizedPct: number | null = null;
  const benchmark = priceHistory[BENCHMARK_KEY];
  if (benchmark) {
    const aligned = series.filter((p) => benchmark[p.date] != null);
    const playerR: number[] = [];
    const benchR: number[] = [];
    for (let i = 1; i < aligned.length; i++) {
      const prevP = aligned[i - 1].value;
      const prevB = benchmark[aligned[i - 1].date];
      const curB = benchmark[aligned[i].date];
      if (prevP <= 0 || prevB <= 0) continue;
      playerR.push((aligned[i].value - prevP) / prevP);
      benchR.push((curB - prevB) / prevB);
    }
    if (playerR.length >= MIN_BENCHMARK_OBSERVATIONS) {
      const meanP = playerR.reduce((s, r) => s + r, 0) / playerR.length;
      const meanB = benchR.reduce((s, r) => s + r, 0) / benchR.length;
      let cov = 0;
      let varB = 0;
      for (let i = 0; i < playerR.length; i++) {
        cov += (playerR[i] - meanP) * (benchR[i] - meanB);
        varB += (benchR[i] - meanB) ** 2;
      }
      cov /= playerR.length - 1;
      varB /= playerR.length - 1;
      if (varB > 0) {
        beta = cov / varB;
        alphaAnnualizedPct = (meanP - beta * meanB) * 252 * 100;
      }
    }
  }

  // --- Payoff ratio / avg win / avg loss (FIFO closed trades) ---
  const { closedTrades } = getPlayerStats(playerId, trades, {});
  const wins = closedTrades.filter((t) => t.gain > 0);
  const losses = closedTrades.filter((t) => t.gain < 0);
  const avgWinPct = wins.length
    ? wins.reduce((s, t) => s + t.gainPct, 0) / wins.length
    : null;
  const avgLossPct = losses.length
    ? losses.reduce((s, t) => s + t.gainPct, 0) / losses.length
    : null;
  const payoffRatio =
    wins.length && losses.length
      ? (wins.reduce((s, t) => s + t.gain, 0) / wins.length) /
        Math.abs(losses.reduce((s, t) => s + t.gain, 0) / losses.length)
      : null;

  return {
    maxDrawdownPct,
    maxDrawdownPeakDate,
    maxDrawdownTroughDate,
    annualizedVolatilityPct,
    sortino,
    beta,
    alphaAnnualizedPct,
    payoffRatio,
    avgWinPct,
    avgLossPct,
  };
}
```

Note: `getAdvancedStats` references `getPlayerStats`, which is declared earlier in the file (line ~213) — no forward-reference issue. `getPlayerStats(playerId, trades, {})` with empty `currentPrices` is correct here because only `closedTrades` (price-independent) is consumed.

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/contest.test.ts`
Expected: PASS.

### Task 11: Dashboard surface in `PlayerDetailCard`

**Files:**
- Modify: `app/dashboard/components/PlayerDetailCard.tsx`

The card already receives `trades`, `priceHistory`, `contestStartDate` — compute in-component; no prop plumbing.

- [ ] **Step 1: Implement**

In `PlayerDetailCard.tsx`, extend the `@/lib/contest` import:

```ts
import {
  type Trade,
  type LeaderboardEntry,
  type Period,
  getCurrentPrice,
  getPositionDailyChange,
  getPositionDaysHeld,
  getPeriodReturn,
  getAdvancedStats,
  formatCurrency,
  formatPercent,
} from "@/lib/contest";
```

Inside the component body, after the `periodReturn` computation (line ~38):

```tsx
const advanced = React.useMemo(
  () => getAdvancedStats(player.id, trades, priceHistory, contestStartDate),
  [player.id, trades, priceHistory, contestStartDate]
);
```

In the Stats Grid (after the Sharpe Ratio `StatItem`, line ~111), add:

```tsx
<StatItem
  label="Max Drawdown"
  value={advanced.maxDrawdownPct != null ? formatPercent(advanced.maxDrawdownPct) : "—"}
  color={advanced.maxDrawdownPct != null && advanced.maxDrawdownPct < 0 ? "red" : undefined}
/>
<StatItem
  label="Volatility (ann.)"
  value={advanced.annualizedVolatilityPct != null ? `${advanced.annualizedVolatilityPct.toFixed(1)}%` : "—"}
/>
<StatItem
  label="Sortino"
  value={advanced.sortino != null ? advanced.sortino.toFixed(2) : "—"}
  color={advanced.sortino != null ? (advanced.sortino >= 0 ? "green" : "red") : undefined}
/>
<StatItem
  label="Beta / Alpha vs SPY"
  value={
    advanced.beta != null
      ? `${advanced.beta.toFixed(2)} / ${advanced.alphaAnnualizedPct != null ? formatPercent(advanced.alphaAnnualizedPct) : "—"}`
      : "—"
  }
/>
<StatItem
  label="Payoff Ratio"
  value={advanced.payoffRatio != null ? advanced.payoffRatio.toFixed(2) : "—"}
  color={advanced.payoffRatio != null ? (advanced.payoffRatio >= 1 ? "green" : "red") : undefined}
/>
```

(11 items in a 2-col grid leaves one dangling cell — acceptable; do not redesign the grid.)

- [ ] **Step 2: Verify compile + suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean.

### Task 12: Phase 2 checkpoint

- [ ] **Step 1: Full verification**

Run: `npm test && npm run lint`
Expected: green.

- [ ] **Step 2: E2E spot-check**

With the dev server up, open the Dashboard and confirm each player card shows the five new stats with plausible values (Daddy/Eli/Yitzi all have months of history, so beta should be non-null if SPY benchmark data is loaded; "—" where data is insufficient is correct, not a bug).

- [ ] **Step 3: STOP — ask Yitzi to confirm the Phase 2 commit**

Proposed message: `Stats: shared daily-value series + max drawdown, volatility, Sortino, alpha/beta, payoff ratio on player cards`

---

## Phase 3 — Email content

### Task 13: Thread `contestStartDate` into `WeeklyReportData`

**Files:**
- Modify: `lib/email.ts` (`WeeklyReportData` interface line ~42, `buildReportData` line ~84)
- Modify: `lib/email-flow.ts` (call site line ~225)
- Modify: `app/api/email/preview/route.ts` (call site line ~53)
- Test: `lib/email.test.ts`

- [ ] **Step 1: Write failing test**

Append to `lib/email.test.ts`:

```ts
it("buildReportData carries contestStartDate (defaulting when omitted)", () => {
  const data = buildReportData([], [], {}, {}, "2026-06-12", "2026-01-14");
  expect(data.contestStartDate).toBe("2026-01-14");
  const defaulted = buildReportData([], [], {}, {}, "2026-06-12");
  expect(defaulted.contestStartDate).toBe("2026-01-01");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/email.test.ts`
Expected: FAIL — `contestStartDate` undefined on the result.

- [ ] **Step 3: Implement**

`lib/email.ts` — add to `WeeklyReportData`:

```ts
export interface WeeklyReportData {
  leaderboard: LeaderboardEntry[];
  weeklyTrades: Trade[];
  weekDeltas: PlayerWeekDelta[];
  players: Player[];
  trades: Trade[];
  currentPrices: Record<string, number>;
  priceHistory: Record<string, Record<string, number>>;
  reportDate: string;
  contestStartDate: string;
}
```

`buildReportData` — add trailing optional param and return field:

```ts
export function buildReportData(
  players: Player[],
  trades: Trade[],
  currentPrices: Record<string, number>,
  priceHistory: Record<string, Record<string, number>> = {},
  asOfDate?: string,
  contestStartDate?: string
): WeeklyReportData {
```

and in the return literal add `contestStartDate: contestStartDate ?? "2026-01-01",`.

`lib/email-flow.ts` line ~225 — `contestStartDate` is already destructurable from `contestData`; change the destructure (line ~202) to include it and pass it:

```ts
const {
  currentPrices,
  priceHistory,
  contestStartDate,
  gmailAddress,
  gmailAppPassword,
  anthropicApiKey,
  aiModel,
  playerEmails,
} = contestData;
// ...
const reportData = buildReportData(players, trades, currentPrices, priceHistory, undefined, contestStartDate);
```

`app/api/email/preview/route.ts` line ~53:

```ts
const reportData = buildReportData(
  players, trades, currentPrices, priceHistory, undefined, contestData.contestStartDate
);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/email.test.ts`
Expected: PASS (existing `buildReportData` fixtures unaffected — the param is trailing-optional).

### Task 14: `detectMilestones`

**Files:**
- Modify: `lib/email.ts` (insert after `renderHighlightsHtml`, line ~267)
- Test: `lib/email.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/email.test.ts` (reuse the file's existing player/trade fixture helpers where available):

```ts
describe("detectMilestones", () => {
  it("flags a leader change when the new #1 moved up", () => {
    const data = {
      leaderboard: [
        { id: "p1", name: "Eli", totalValue: 110000 },
        { id: "p2", name: "Yitzi", totalValue: 105000 },
      ],
      weekDeltas: [
        { playerId: "p1", rankChange: 1 },
        { playerId: "p2", rankChange: -1 },
      ],
      trades: [],
      priceHistory: {},
      reportDate: "2026-06-12",
      contestStartDate: "2026-01-14",
    } as unknown as WeeklyReportData;
    const ms = detectMilestones(data);
    expect(ms.some((m) => m.type === "leader_change" && m.text.includes("Eli"))).toBe(true);
  });

  it("flags a new contest high", () => {
    const trades = [
      { id: "1", playerId: "p1", type: "buy", ticker: "A", shares: 1000, price: 100, date: "2026-05-01", timestamp: 1 },
    ] as Trade[];
    const priceHistory = {
      A: { "2026-05-01": 100, "2026-05-15": 102, "2026-06-05": 101, "2026-06-12": 106 },
    };
    const data = {
      leaderboard: [{ id: "p1", name: "Daddy", totalValue: 106000 }],
      weekDeltas: [{ playerId: "p1", rankChange: 0 }],
      trades,
      priceHistory,
      reportDate: "2026-06-12",
      contestStartDate: "2026-05-01",
    } as unknown as WeeklyReportData;
    const ms = detectMilestones(data);
    expect(ms.some((m) => m.type === "new_high" && m.text.includes("Daddy"))).toBe(true);
  });

  it("upgrades to drawdown_recovered when a ≥5% drawdown preceded the new high", () => {
    const trades = [
      { id: "1", playerId: "p1", type: "buy", ticker: "A", shares: 1000, price: 100, date: "2026-05-01", timestamp: 1 },
    ] as Trade[];
    const priceHistory = {
      A: { "2026-05-01": 100, "2026-05-08": 104, "2026-05-22": 96, "2026-06-12": 107 },
      // peak 104k on 05-08, trough 96k on 05-22 (-7.7%), now 107k = recovery
    };
    const data = {
      leaderboard: [{ id: "p1", name: "Daddy", totalValue: 107000 }],
      weekDeltas: [{ playerId: "p1", rankChange: 0 }],
      trades,
      priceHistory,
      reportDate: "2026-06-12",
      contestStartDate: "2026-05-01",
    } as unknown as WeeklyReportData;
    const ms = detectMilestones(data);
    expect(ms.some((m) => m.type === "drawdown_recovered")).toBe(true);
    expect(ms.some((m) => m.type === "new_high")).toBe(false);
  });

  it("returns empty when nothing notable happened", () => {
    const data = {
      leaderboard: [{ id: "p1", name: "Daddy", totalValue: 99000 }],
      weekDeltas: [{ playerId: "p1", rankChange: 0 }],
      trades: [],
      priceHistory: {},
      reportDate: "2026-06-12",
      contestStartDate: "2026-05-01",
    } as unknown as WeeklyReportData;
    expect(detectMilestones(data)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/email.test.ts`
Expected: FAIL — `detectMilestones` not exported.

- [ ] **Step 3: Implement**

Insert into `lib/email.ts` after `renderHighlightsHtml`. Add `buildDailyValueSeries` and `addDays` to the existing imports (`@/lib/contest` / `@/lib/dates`).

```ts
// ---------- Deterministic Milestones ----------
//
// Same philosophy as the highlights block: milestone detection is pure
// computation, so code does it and the template renders it. The list is also
// appended to the AI prompt as optional color (copy-don't-derive rules apply)
// but the banner renders regardless of what the AI writes.

export interface Milestone {
  type: "leader_change" | "new_high" | "drawdown_recovered";
  text: string;
}

const DRAWDOWN_RECOVERY_THRESHOLD_PCT = -5;

export function detectMilestones(data: WeeklyReportData): Milestone[] {
  const { leaderboard, weekDeltas, trades, priceHistory, reportDate, contestStartDate } = data;
  const milestones: Milestone[] = [];

  // Leader change: the current #1 moved up to get there this week.
  if (leaderboard.length > 1) {
    const leader = leaderboard[0];
    const delta = weekDeltas.find((d) => d.playerId === leader.id);
    if (delta && delta.rankChange > 0) {
      milestones.push({
        type: "leader_change",
        text: `${leader.name} takes the contest lead this week.`,
      });
    }
  }

  // New contest high / drawdown recovery, per player. Compare the player's
  // current totalValue against their pre-this-week peak from the daily series.
  const weekAgo = addDays(reportDate, -7);
  for (const p of leaderboard) {
    const series = buildDailyValueSeries(p.id, trades, priceHistory, contestStartDate, reportDate);
    const priorPoints = series.filter((pt) => pt.date <= weekAgo);
    if (priorPoints.length < 2) continue;
    const priorPeak = priorPoints.reduce((best, pt) => (pt.value > best.value ? pt : best));
    if (p.totalValue <= priorPeak.value) continue;

    // Was there a ≥5% drawdown from that peak before this recovery?
    const afterPeak = priorPoints.filter((pt) => pt.date > priorPeak.date);
    const trough = afterPeak.length
      ? Math.min(...afterPeak.map((pt) => pt.value))
      : priorPeak.value;
    const ddPct = priorPeak.value > 0 ? ((trough - priorPeak.value) / priorPeak.value) * 100 : 0;
    if (ddPct <= DRAWDOWN_RECOVERY_THRESHOLD_PCT) {
      milestones.push({
        type: "drawdown_recovered",
        text: `${p.name} recovered to a new contest high after a ${Math.abs(ddPct).toFixed(0)}% drawdown.`,
      });
    } else {
      milestones.push({
        type: "new_high",
        text: `${p.name} hit a new contest-high portfolio value this week.`,
      });
    }
  }

  return milestones;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/email.test.ts`
Expected: PASS. If the new-high test fails because `totalValue` in the fixture doesn't exceed the series peak, recheck the fixture arithmetic before touching the implementation (two-attempt rule applies).

### Task 15: Email template — banner, vs-SPY, stats table, data-notes footer, prompt block

**Files:**
- Modify: `lib/email.ts` (`buildCommentaryPrompt` line ~269/return ~512, `buildEmailHtml` line ~925, `buildPlainText` line ~1164, `sendWeeklyEmail` line ~1248)
- Test: `lib/email.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/email.test.ts` (build on the file's existing `buildEmailHtml` fixtures):

```ts
describe("email template upgrades", () => {
  // Reuse/adapt the existing buildEmailHtml fixture data in this file; the
  // minimal requirement is a WeeklyReportData with one player and
  // contestStartDate + a benchmark series in priceHistory.

  it("renders the data-notes footer only when notes exist", () => {
    const html = buildEmailHtml(reportDataFixture(), "Commentary.", ["Backfill failed this run."]);
    expect(html).toContain("Data Notes");
    expect(html).toContain("Backfill failed this run.");
    const clean = buildEmailHtml(reportDataFixture(), "Commentary.");
    expect(clean).not.toContain("Data Notes");
  });

  it("renders a per-player vs-SPY line when benchmark data exists", () => {
    const html = buildEmailHtml(reportDataFixture(), "Commentary.");
    expect(html).toContain("S&amp;P 500 since contest start");
  });

  it("renders the advanced stats table", () => {
    const html = buildEmailHtml(reportDataFixture(), "Commentary.");
    expect(html).toContain("Contest Statistics");
    expect(html).toContain("Max DD");
    expect(html).toContain("Sortino");
  });

  it("renders the milestones banner when milestones exist", () => {
    // fixture where leader's weekDelta.rankChange > 0
    const html = buildEmailHtml(leaderChangeFixture(), "Commentary.");
    expect(html).toContain("takes the contest lead");
  });

  it("plain text includes stats and data notes", () => {
    const text = buildPlainText(reportDataFixture(), "Commentary.", ["Backfill failed this run."]);
    expect(text).toContain("CONTEST STATISTICS");
    expect(text).toContain("DATA NOTES");
  });

  it("prompt includes pre-computed milestones with copy-verbatim rule", () => {
    const prompt = buildCommentaryPrompt(leaderChangeFixture());
    expect(prompt).toContain("MILESTONES");
    expect(prompt).toContain("takes the contest lead");
  });
});
```

Write `reportDataFixture()` / `leaderChangeFixture()` as small local helpers next to these tests, built the same way the file's existing `buildEmailHtml` tests build their data (real `buildReportData` output over fixture trades is fine and preferred). Both must set `contestStartDate` and include `[BENCHMARK_KEY]` entries in `priceHistory` covering contest start and report date.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/email.test.ts`
Expected: FAIL on each new assertion.

- [ ] **Step 3: Implement in `lib/email.ts`**

Ensure imports from `@/lib/contest` include: `getAdvancedStats, getPlayerSharpeRatio, getBenchmarkReturnAtDate, BENCHMARK_KEY` (plus existing).

**(a) Prompt block** — in `buildCommentaryPrompt`, before the `return` statement add:

```ts
const milestones = detectMilestones(data);
const milestonesBlock = milestones.length
  ? `

MILESTONES (pre-computed; optional color — copy the wording, do not add numbers or invent others):
${milestones.map((m) => `- ${m.text}`).join("\n")}`
  : "";
```

and append `${milestonesBlock}` to the template literal immediately after the cross-holdings/market-context section (i.e., at the very end of the returned string).

**(b) `buildEmailHtml`** — change signature to:

```ts
export function buildEmailHtml(
  data: WeeklyReportData,
  commentary: string,
  dataNotes: string[] = []
): string {
```

Destructure `contestStartDate` from `data` alongside the existing fields. After the `highlightsHtml` line (~932) add:

```ts
const milestones = detectMilestones(data);
const milestonesHtml = milestones.length
  ? `<div style="padding: 14px 24px; border-bottom: 1px solid #E5E7EB; background: #FFFBEB;">
      ${milestones.map((m) => `<div style="font-size: 13px; color: #92400E; margin: 2px 0;">&#x1F3C5; ${m.text}</div>`).join("")}
    </div>`
  : "";

const spyReturn = getBenchmarkReturnAtDate(
  reportDate,
  data.priceHistory[BENCHMARK_KEY] || {},
  contestStartDate
);

const statsRows = leaderboard
  .map((p) => {
    const adv = getAdvancedStats(p.id, trades, data.priceHistory, contestStartDate, { today: reportDate });
    const sharpe = getPlayerSharpeRatio(p.id, trades, data.priceHistory, contestStartDate, { today: reportDate });
    const num = (v: number | null, digits = 2, suffix = "") =>
      v != null ? `${v.toFixed(digits)}${suffix}` : "—";
    const pct = (v: number | null) => (v != null ? formatPercent(v) : "—");
    return `<tr style="border-bottom: 1px solid #F3F4F6;">
      <td style="padding: 6px 8px; font-size: 12px; font-weight: 600; color: #111827;">${p.name}</td>
      <td style="padding: 6px 8px; font-size: 12px; text-align: right; color: ${p.returnPct >= 0 ? "#059669" : "#DC2626"};">${formatPercent(p.returnPct)}</td>
      <td style="padding: 6px 8px; font-size: 12px; text-align: right; color: #4B5563;">${pct(spyReturn)}</td>
      <td style="padding: 6px 8px; font-size: 12px; text-align: right; color: #4B5563;">${pct(adv.maxDrawdownPct)}</td>
      <td style="padding: 6px 8px; font-size: 12px; text-align: right; color: #4B5563;">${num(adv.annualizedVolatilityPct, 1, "%")}</td>
      <td style="padding: 6px 8px; font-size: 12px; text-align: right; color: #4B5563;">${num(sharpe)}</td>
      <td style="padding: 6px 8px; font-size: 12px; text-align: right; color: #4B5563;">${num(adv.sortino)}</td>
      <td style="padding: 6px 8px; font-size: 12px; text-align: right; color: #4B5563;">${num(adv.beta)}</td>
      <td style="padding: 6px 8px; font-size: 12px; text-align: right; color: #4B5563;">${num(adv.payoffRatio)}</td>
    </tr>`;
  })
  .join("");

const statsTableHtml = `<div style="padding: 24px; border-bottom: 1px solid #E5E7EB;">
  <h2 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 700; color: #111827;">&#x1F4D0; Contest Statistics</h2>
  <table style="width: 100%; border-collapse: collapse;">
    <thead>
      <tr style="background: #F9FAFB;">
        <th style="padding: 6px 8px; text-align: left; font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Player</th>
        <th style="padding: 6px 8px; text-align: right; font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Return</th>
        <th style="padding: 6px 8px; text-align: right; font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase;">SPY</th>
        <th style="padding: 6px 8px; text-align: right; font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Max DD</th>
        <th style="padding: 6px 8px; text-align: right; font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Vol</th>
        <th style="padding: 6px 8px; text-align: right; font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Sharpe</th>
        <th style="padding: 6px 8px; text-align: right; font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Sortino</th>
        <th style="padding: 6px 8px; text-align: right; font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Beta</th>
        <th style="padding: 6px 8px; text-align: right; font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Payoff</th>
      </tr>
    </thead>
    <tbody>${statsRows}</tbody>
  </table>
  <p style="margin: 8px 0 0 0; font-size: 10px; color: #9CA3AF;">Vol = annualized volatility. Beta/alpha need 20+ overlapping trading days with SPY data. "—" = insufficient data.</p>
</div>`;

const dataNotesHtml = dataNotes.length
  ? `<div style="padding: 12px 24px; background: #FFF7ED; border-top: 1px solid #FED7AA;">
      <p style="margin: 0 0 4px 0; font-size: 11px; font-weight: 700; color: #9A3412; text-transform: uppercase; letter-spacing: 0.04em;">Data Notes</p>
      ${dataNotes.map((n) => `<p style="margin: 2px 0; font-size: 11px; color: #9A3412;">${n}</p>`).join("")}
    </div>`
  : "";
```

Per-player vs-SPY line: in `playerDetailsHtml` (map over `leaderboard`, line ~989), insert after the header `<div>` (line ~1061, before the cash/portfolio row):

```ts
<div style="font-size: 12px; color: #6B7280; margin-bottom: 10px;">vs. S&amp;P 500 since contest start: <strong style="color: ${returnColor};">${formatPercent(stats.returnPct)}</strong> &middot; SPY <strong style="color: #4B5563;">${spyReturn != null ? formatPercent(spyReturn) : "—"}</strong></div>
```

Assemble in the final HTML (lines ~1096–1148):
- insert `${milestonesHtml}` immediately BEFORE the `<!-- 7-Day Price Moves -->` comment/`${highlightsHtml}`;
- insert `${statsTableHtml}` between the Leaderboard section and the Weekly Trades section;
- insert `${dataNotesHtml}` immediately after the Portfolio Details `</div>` (before the outer white container closes).

**(c) `buildPlainText`** — change signature to `(data, commentary, dataNotes: string[] = [])`, destructure `contestStartDate` and `priceHistory`, and add after the leaderboard block:

```ts
const milestones = detectMilestones(data);
if (milestones.length) {
  lines.push("", "MILESTONES", "-".repeat(60));
  milestones.forEach((m) => lines.push(`* ${m.text}`));
}

const spyReturn = getBenchmarkReturnAtDate(reportDate, priceHistory[BENCHMARK_KEY] || {}, contestStartDate);
lines.push("", "CONTEST STATISTICS", "-".repeat(60));
leaderboard.forEach((p) => {
  const adv = getAdvancedStats(p.id, trades, priceHistory, contestStartDate, { today: reportDate });
  const sharpe = getPlayerSharpeRatio(p.id, trades, priceHistory, contestStartDate, { today: reportDate });
  const num = (v: number | null, digits = 2) => (v != null ? v.toFixed(digits) : "—");
  lines.push(
    `${p.name}: return ${formatPercent(p.returnPct)} (SPY ${spyReturn != null ? formatPercent(spyReturn) : "—"}) | maxDD ${adv.maxDrawdownPct != null ? formatPercent(adv.maxDrawdownPct) : "—"} | vol ${num(adv.annualizedVolatilityPct, 1)}% | sharpe ${num(sharpe)} | sortino ${num(adv.sortino)} | beta ${num(adv.beta)} | payoff ${num(adv.payoffRatio)}`
  );
});
```

and before the final `"---"` footer:

```ts
if (dataNotes.length) {
  lines.push("", "DATA NOTES", "-".repeat(60));
  dataNotes.forEach((n) => lines.push(`! ${n}`));
}
```

**(d) `sendWeeklyEmail`** — change signature and body:

```ts
export async function sendWeeklyEmail(
  config: EmailConfig,
  data: WeeklyReportData,
  commentary: string,
  dataNotes: string[] = []
): Promise<void> {
  const html = buildEmailHtml(data, commentary, dataNotes);
  const text = buildPlainText(data, commentary, dataNotes);
  // ... rest unchanged
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/email.test.ts`
Expected: PASS, including all pre-existing template tests.

### Task 16: Wire `dataNotes` through send + preview

**Files:**
- Modify: `lib/email-flow.ts` (before the `sendWeeklyEmail` call)
- Modify: `app/api/email/preview/route.ts` (buildEmailHtml call, line ~66)
- Test: `lib/email-flow.test.ts`

- [ ] **Step 1: Write failing test**

Append to `lib/email-flow.test.ts`:

```ts
it("passes data notes to sendWeeklyEmail when backfill failed", async () => {
  const prices = await import("@/lib/prices");
  vi.mocked(prices.backfillPrices).mockRejectedValue(new Error("ibkr down"));
  await runWeeklyEmail();
  const notesArg = email.sendWeeklyEmail.mock.calls[0][3] as string[];
  expect(notesArg.some((n) => n.toLowerCase().includes("backfill"))).toBe(true);
}, 200_000);
```

NOTE: `runBackfillWithRetry` waits out two timeouts on failure — if this test is slow, instead mock `backfillPrices` to reject immediately (it does above; the catch path resolves fast, so the 200s timeout is a guard, not an expectation).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/email-flow.test.ts`
Expected: FAIL — `sendWeeklyEmail` called with 3 args.

- [ ] **Step 3: Implement**

In `lib/email-flow.ts`, before the pending-row/`sendWeeklyEmail` block, add:

```ts
// Data-quality notes rendered in the email footer — the reader sees known
// gaps in the email itself instead of needing the audit table.
const dataNotes: string[] = [];
if (!backfillStatus.ok) {
  dataNotes.push(
    "Historical price backfill failed this run — week-over-week figures may use the most recent available close."
  );
}
if (!preGeneratedCommentary && credsConfigured && vkFetchFailed) {
  dataNotes.push("Market-context newsletter was unavailable this week.");
}
for (const w of highlights.warnings) dataNotes.push(`Excluded from 7-day highlights: ${w}`);
```

and pass it: `await sendWeeklyEmail({...}, reportData, commentary, dataNotes);`

In `app/api/email/preview/route.ts`, mirror what the preview can know (so preview matches send):

```ts
const previewNotes: string[] = [];
if (priceFreshness === "stale") previewNotes.push("Prices were not refreshed to today's close for this preview.");
const html = buildEmailHtml(reportData, commentary, previewNotes);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/email-flow.test.ts && npm test`
Expected: PASS.

### Task 17: Phase 3 checkpoint + end-to-end verification

- [ ] **Step 1: Full suite + lint + build**

Run: `npm test && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 2: E2E — dashboard**

Dev server up (`npm run dev`). Click through Dashboard: player cards show the new stats; no console errors; period selector and chart unaffected.

- [ ] **Step 3: E2E — email preview against the real DB**

Open `http://localhost:3001/email/preview`, generate a preview, and visually inspect: milestones banner (if any triggered), vs-SPY lines per player, Contest Statistics table with plausible numbers, data-notes footer absent when data is clean. Do NOT send to the players; if a live-send smoke test is wanted, use the preview page's test-recipient path (`--to=isaac@wolfsonfamily.com` semantics) — never the real recipient list (per the live-send testing rule).

- [ ] **Step 4: STOP — ask Yitzi to confirm the Phase 3 commit**

Proposed message: `Email: milestone callouts, per-player SPY comparison, contest statistics table, data-notes footer`

- [ ] **Step 5: Session wrap-up**

Offer CLAUDE.md updates (new lessons learned), update `tasks/todo.md`, and produce the session retrospective per the global session-closeout rule.

---

## Self-review notes

- Spec coverage: 1.1→Tasks 1–3, 1.2→Tasks 4–5, 1.3→Task 6, 1.4→Tasks 7+15+16, 2.1→Task 9, 2.2→Task 10, 2.3→Tasks 11+15, 3.1→Task 15(b), 3.2→Tasks 14+15, 3.3→Task 15, 3.4→Tasks 15–16. No gaps.
- Type consistency: `recordEmailSend` returns `number` (Task 4) and Task 5 consumes it; `persistPrices(updated, priceDates, today)` consistent across Tasks 2–3; `buildEmailHtml(data, commentary, dataNotes)` consistent across Tasks 15–16; `WeeklyReportData.contestStartDate` added in Task 13 and consumed in Tasks 14–15.
- Known judgment calls for the executor: exact insertion offsets may drift a few lines from the noted numbers — anchor on the quoted code, not the line number.
