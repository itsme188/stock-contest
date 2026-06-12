import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  getContestData: vi.fn(),
  saveContestData: vi.fn(),
  recordEmailSend: vi.fn().mockReturnValue(101),
  updateEmailSend: vi.fn(),
  findBlockingWeeklySend: vi.fn().mockReturnValue(undefined),
}));
vi.mock("@/lib/db", () => db);

const email = vi.hoisted(() => ({
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
}));
vi.mock("@/lib/email", () => email);

vi.mock("@/lib/vital-knowledge", () => ({
  fetchVitalKnowledge: vi.fn().mockResolvedValue("market context"),
}));
const prices = vi.hoisted(() => ({
  backfillPrices: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/prices", () => prices);
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
  prices.backfillPrices.mockResolvedValue(undefined);
});

describe("runWeeklyEmail pending-row idempotency", () => {
  it("inserts a pending row BEFORE sending and finalizes it to ok", async () => {
    await runWeeklyEmail();
    const pendingCalls = db.recordEmailSend.mock.calls.filter((c) => c[0].status === "pending");
    expect(pendingCalls).toHaveLength(1);
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

  it("skips with already_sent_today when a completed row blocks", async () => {
    db.findBlockingWeeklySend.mockReturnValue({ id: 7, status: "ok" });
    const result = await runWeeklyEmail();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("already_sent_today");
    expect(email.sendWeeklyEmail).not.toHaveBeenCalled();
  });

  it("test sends bypass the pending machinery", async () => {
    await runWeeklyEmail({ testTo: "x@y.com" });
    const pendingCall = db.recordEmailSend.mock.calls.find(
      (c) => c[0].status === "pending"
    );
    expect(pendingCall).toBeUndefined();
    expect(db.updateEmailSend).not.toHaveBeenCalled();
    // Audit row must use status "test" — not "ok" — so dry-runs can never block the real Friday send.
    expect(db.recordEmailSend).toHaveBeenCalledWith(
      expect.objectContaining({ status: "test" })
    );
    const okCalls = db.recordEmailSend.mock.calls.filter((c) => c[0].status === "ok");
    expect(okCalls).toHaveLength(0);
  });

  it("force=true bypasses the skip guard but still uses the pending machinery", async () => {
    db.findBlockingWeeklySend.mockReturnValue({ id: 7, status: "ok" });
    const result = await runWeeklyEmail({ force: true });
    expect(result.skipped).toBeUndefined();
    expect(email.sendWeeklyEmail).toHaveBeenCalled();
    const pendingCalls = db.recordEmailSend.mock.calls.filter((c) => c[0].status === "pending");
    expect(pendingCalls).toHaveLength(1);
    expect(db.updateEmailSend).toHaveBeenCalledWith(101, expect.objectContaining({ status: "ok" }));
  });

  it("passes data notes to sendWeeklyEmail when backfill failed", async () => {
    prices.backfillPrices.mockRejectedValue(new Error("ibkr down"));
    await runWeeklyEmail();
    expect(email.sendWeeklyEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.arrayContaining([expect.stringContaining("prior-day prices")])
    );
  });

  it("includes a benchmark-absent note when priceHistory has no SPY series", async () => {
    // The default fixture has priceHistory: {} — no BENCHMARK_KEY entry — so the note fires.
    await runWeeklyEmail();
    expect(email.sendWeeklyEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.arrayContaining([expect.stringContaining("S&P 500 benchmark data is unavailable")])
    );
  });
});
