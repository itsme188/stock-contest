// Shared end-to-end flow for sending the weekly email. Used by both
// `app/api/email/weekly/route.ts` (web preview's "Send" button) and
// `scripts/run-weekly-email.ts` (the standalone scheduled job). Single source
// of truth — preview vs. scheduled send cannot drift.
//
// On any thrown error: the route catches → returns 500; the scheduled script
// catches → sends a failure-alert email.

import { getContestData, saveContestData, recordEmailSend, updateEmailSend, findBlockingWeeklySend } from "@/lib/db";
import { type Player, type Trade, BENCHMARK_KEY } from "@/lib/contest";
import {
  type ViolationReport,
  type FactualViolationReport,
  buildReportData,
  buildWeeklyHighlights,
  generateCommentary,
  sendWeeklyEmail,
} from "@/lib/email";
import { fetchVitalKnowledge } from "@/lib/vital-knowledge";
import { backfillPrices } from "@/lib/prices";
import {
  refreshAllOpenPrices,
  NoOpenPositionsError,
  type OrchestratedRefreshResult,
} from "@/lib/prices-refresh";
import { localToday } from "@/lib/dates";

const BACKFILL_TIMEOUT_MS = 90_000;
const BACKFILL_RETRY_TIMEOUT_MS = 60_000;

// A pending audit row younger than this blocks a duplicate send; older is
// treated as a crashed attempt and does not block.
const PENDING_BLOCK_MS = 30 * 60 * 1000;

export interface RunWeeklyEmailOptions {
  /** Test recipient. When set, the send goes only to this address and the
   *  same-day idempotency flag is NOT updated. */
  testTo?: string;
  /** Bypass the same-day idempotency check. */
  force?: boolean;
  /** Pre-generated commentary from the preview page. When set, the AI is
   *  skipped and VK is not fetched (the preview already baked them in). */
  preGeneratedCommentary?: string;
}

export interface RunWeeklyEmailResult {
  ok: true;
  skipped?: boolean;
  reason?: string;
  reportDate: string;
  recipients: number;
  /** AI commentary violation counts after retries (0 if not generated). */
  violations: {
    numeric: number;
    ranking: number;
    missedTrades: number;
    unknownTickers: number;
    /** Verifier-pass (second Claude call) residual errors. */
    verifierErrors: number;
    /** Verifier error strings (truncated; for surfacing in audit log). */
    verifierErrorDetail: string[];
    attempts: number;
  };
  /** Highlights warnings (positions excluded due to missing priceHistory). */
  highlightsWarnings: string[];
  /** Vital Knowledge market-context status — lets callers detect partial
   *  data sends and alert without re-implementing the heuristic. */
  vk: {
    credsConfigured: boolean;
    chars: number;
    fetchFailed: boolean;
  };
  backfillFailed: boolean;
  /** Refresh metadata — source used, whether prices reflected today, retries. */
  refresh: {
    source: "ibkr" | "polygon" | "skipped";
    pricesAreFresh: boolean;
    staleRetries: number;
    tickersUpdated: number;
  };
}

export class WeeklyEmailConfigError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "WeeklyEmailConfigError";
    this.status = status;
  }
}

export class StalePricesError extends Error {
  status = 503;
  refreshResult: OrchestratedRefreshResult;
  constructor(refreshResult: OrchestratedRefreshResult) {
    const stale = Object.entries(refreshResult.priceDates)
      .filter(([, d]) => d !== refreshResult.date)
      .map(([t, d]) => `${t}=${d}`)
      .join(", ");
    super(
      `Refusing to send: prices not refreshed to today's close after ${refreshResult.staleRetries} retries. ` +
        `Source: ${refreshResult.source}. Today: ${refreshResult.date}. Stale tickers: ${stale || "(all stale)"}`
    );
    this.name = "StalePricesError";
    this.refreshResult = refreshResult;
  }
}

async function runBackfillWithRetry(): Promise<{ ok: boolean; lastError?: string }> {
  const attempt = (timeoutMs: number) =>
    Promise.race([
      backfillPrices().then(() => ({ ok: true } as const)),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: `Backfill timed out after ${timeoutMs}ms` }), timeoutMs)
      ),
    ]).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as const);

  const first = await attempt(BACKFILL_TIMEOUT_MS);
  if (first.ok) return { ok: true };

  console.warn(`[Weekly Email] Backfill attempt 1 failed: ${first.error}. Retrying once...`);
  const second = await attempt(BACKFILL_RETRY_TIMEOUT_MS);
  if (second.ok) return { ok: true };

  console.warn(`[Weekly Email] Backfill attempt 2 also failed: ${second.error}. Proceeding with available prices.`);
  return { ok: false, lastError: second.error };
}

export async function runWeeklyEmail(
  opts: RunWeeklyEmailOptions = {}
): Promise<RunWeeklyEmailResult> {
  const { testTo, force, preGeneratedCommentary } = opts;
  const today = localToday();

  // Idempotency: refuse a second real send on the same day unless forced.
  // Test sends (testTo) bypass so dry-runs can be retried.
  if (!testTo && !force) {
    const { lastWeeklyEmailSentDate } = getContestData();
    const blocking = findBlockingWeeklySend(today, Date.now() - PENDING_BLOCK_MS);
    if (lastWeeklyEmailSentDate === today || blocking) {
      const reason = blocking?.status === "pending" ? "send_in_progress" : "already_sent_today";
      recordEmailSend({
        kind: "weekly",
        status: "skipped",
        reportDate: today,
      });
      return {
        ok: true,
        skipped: true,
        reason,
        reportDate: today,
        recipients: 0,
        violations: {
          numeric: 0,
          ranking: 0,
          missedTrades: 0,
          unknownTickers: 0,
          verifierErrors: 0,
          verifierErrorDetail: [],
          attempts: 0,
        },
        highlightsWarnings: [],
        vk: { credsConfigured: false, chars: 0, fetchFailed: false },
        backfillFailed: false,
        refresh: { source: "skipped", pricesAreFresh: true, staleRetries: 0, tickersUpdated: 0 },
      };
    }
  }

  // Phase 7 — hard freshness gate. The previous architecture trusted
  // `currentPrices` in the DB, which led to ~Thursday's-close-labeled-as-
  // Friday's-close getting shipped (Polygon /prev semantics + missed daily
  // refresh). We now refresh on every send and refuse to ship if today's
  // close still isn't available after retries. The orchestrator handles
  // IBKR primary, Polygon fallback w/ retry; we only need to interpret the
  // result.
  let refreshSource: "ibkr" | "polygon" | "skipped" = "skipped";
  let pricesAreFresh = true;
  let refreshStaleRetries = 0;
  let refreshTickersUpdated = 0;
  try {
    const refreshResult = await refreshAllOpenPrices();
    refreshSource = refreshResult.source;
    pricesAreFresh = refreshResult.pricesAreFresh;
    refreshStaleRetries = refreshResult.staleRetries;
    refreshTickersUpdated = Object.keys(refreshResult.updated).length;
    if (!pricesAreFresh) {
      throw new StalePricesError(refreshResult);
    }
  } catch (err) {
    if (err instanceof NoOpenPositionsError) {
      // No open positions means no prices to refresh; proceed.
      pricesAreFresh = true;
    } else {
      throw err; // Stale or refresh failure propagates to the caller, which
                 // alerts via sendFailureAlert and returns 503.
    }
  }

  // Backfill prices so week-over-week calculations are accurate. One retry
  // before swallowing — the email proceeds either way, but the result flags
  // a failed backfill so the caller can alert.
  const backfillStatus = await runBackfillWithRetry();

  const contestData = getContestData();
  const players = contestData.players as Player[];
  const trades = contestData.trades as Trade[];
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

  if (!gmailAddress || !gmailAppPassword) {
    throw new WeeklyEmailConfigError("Gmail credentials not configured. Set them in Settings.");
  }
  if (!anthropicApiKey) {
    throw new WeeklyEmailConfigError("Anthropic API key not configured. Set it in Settings.");
  }

  const effectiveEmails = testTo ? { _test: testTo } : playerEmails;
  const recipients = Object.values(effectiveEmails).filter(Boolean);
  if (recipients.length === 0) {
    throw new WeeklyEmailConfigError("No recipient email addresses configured.");
  }

  const reportData = buildReportData(players, trades, currentPrices, priceHistory, undefined, contestStartDate);
  const highlights = buildWeeklyHighlights(reportData);

  // VK fetch: skipped when caller pre-generated (the preview already baked
  // VK context into its commentary). credsConfigured/fetchFailed surfaced
  // for the alert heuristic in the standalone script.
  const credsConfigured = Boolean(gmailAddress && gmailAppPassword);
  let marketContext = "";
  let vkFetchFailed = false;
  if (!preGeneratedCommentary) {
    try {
      marketContext = await fetchVitalKnowledge(gmailAddress, gmailAppPassword);
    } catch (err) {
      console.warn(`[Weekly Email] VK fetch threw: ${err instanceof Error ? err.message : err}`);
      marketContext = "";
    }
    if (credsConfigured && marketContext.length === 0) {
      // Gmail creds present but VK returned 0 chars — could be no recent VK
      // emails (informational) or an IMAP error (alertable). The current VK
      // implementation collapses both into "" so we conservatively flag it
      // for the caller to inspect. (A discriminated VK return type is the
      // proper fix but out of scope for Phase 1.)
      vkFetchFailed = true;
    }
    console.log(`[Weekly Email] VK: ${marketContext.length} chars, credsConfigured=${credsConfigured}`);
  }

  // Generate AI commentary (with up to 2 retries on style + factual
  // violations) or use the pre-generated copy from the preview page.
  let commentary: string;
  let violations: ViolationReport = {
    numericViolations: 0,
    rankingViolations: 0,
    numericSnippets: [],
    rankingSnippets: [],
  };
  let factual: FactualViolationReport = { missedTrades: [], unknownTickers: [] };
  let verifierErrors: string[] = [];
  let attempts = 0;
  if (preGeneratedCommentary) {
    commentary = preGeneratedCommentary;
  } else {
    const result = await generateCommentary(reportData, anthropicApiKey, aiModel, marketContext);
    commentary = result.text;
    violations = result.violations;
    factual = result.factual;
    verifierErrors = result.verifierErrors;
    attempts = result.attempts;
  }

  // Data-quality notes rendered in the email footer — the reader sees known
  // gaps in the email itself instead of needing the audit table.
  const dataNotes: string[] = [];
  if (!backfillStatus.ok) {
    dataNotes.push(
      "Some prior-day prices could not be updated this week — week-over-week figures may rely on the most recent available close."
    );
  }
  if (!preGeneratedCommentary && credsConfigured && vkFetchFailed) {
    dataNotes.push("Market-context newsletter was unavailable this week.");
  }
  for (const w of highlights.warnings) dataNotes.push(`Left out of the 7-day price moves section — ${w}`);
  const benchmarkSeries = priceHistory[BENCHMARK_KEY];
  if (!benchmarkSeries || Object.keys(benchmarkSeries).length === 0) {
    dataNotes.push("S&P 500 benchmark data is unavailable — index comparisons show —.");
  }

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
      commentary,
      dataNotes
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
    try {
      updateEmailSend(pendingId, { status: "ok", ...auditFields });
    } catch (e) {
      // Do NOT rethrow: the email was delivered and lastWeeklyEmailSentDate is
      // written; a finalization anomaly must not masquerade as a send failure.
      console.error(
        "[Weekly Email] updateEmailSend failed after successful send; email was delivered.",
        e
      );
    }
  } else {
    // "test" not "ok": findBlockingWeeklySend must never let a dry-run block the real Friday send.
    recordEmailSend({
      kind: "weekly",
      status: "test",
      recipients: recipients.length,
      reportDate: reportData.reportDate,
      ...auditFields,
    });
  }

  return {
    ok: true,
    reportDate: reportData.reportDate,
    recipients: recipients.length,
    violations: {
      numeric: violations.numericViolations,
      ranking: violations.rankingViolations,
      missedTrades: factual.missedTrades.length,
      unknownTickers: factual.unknownTickers.length,
      verifierErrors: verifierErrors.length,
      verifierErrorDetail: verifierErrors.slice(0, 10),
      attempts,
    },
    highlightsWarnings: highlights.warnings,
    vk: {
      credsConfigured,
      chars: marketContext.length,
      fetchFailed: vkFetchFailed,
    },
    backfillFailed: !backfillStatus.ok,
    refresh: {
      source: refreshSource,
      pricesAreFresh,
      staleRetries: refreshStaleRetries,
      tickersUpdated: refreshTickersUpdated,
    },
  };
}
