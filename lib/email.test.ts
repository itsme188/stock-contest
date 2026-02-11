import { describe, it, expect } from "vitest";
import { type Player, type Trade } from "@/lib/contest";
import {
  getWeeklyTrades,
  buildReportData,
  buildCommentaryPrompt,
  buildEmailHtml,
} from "@/lib/email";

// --- Helpers ---

let tradeId = 1;
function makeTrade(
  overrides: Partial<Trade> & { playerId: string; ticker: string }
): Trade {
  const id = (tradeId++).toString();
  return {
    id,
    type: "buy",
    shares: 100,
    price: 50,
    date: "2026-02-01",
    timestamp: new Date(overrides.date || "2026-02-01").getTime(),
    ...overrides,
  };
}

const players: Player[] = [
  { id: "p1", name: "Daddy", color: "#3B82F6" },
  { id: "p2", name: "Eli", color: "#10B981" },
  { id: "p3", name: "Yitzi", color: "#F59E0B" },
];

// --- Tests ---

describe("getWeeklyTrades", () => {
  const trades = [
    makeTrade({ playerId: "p1", ticker: "AAPL", date: "2026-01-20" }),
    makeTrade({ playerId: "p1", ticker: "GOOG", date: "2026-02-05" }),
    makeTrade({ playerId: "p2", ticker: "MSFT", date: "2026-02-07" }),
    makeTrade({ playerId: "p3", ticker: "AMZN", date: "2026-02-10" }),
  ];

  it("filters trades from the last 7 days", () => {
    const weekly = getWeeklyTrades(trades, "2026-02-10");
    expect(weekly).toHaveLength(3);
    expect(weekly.map((t) => t.ticker)).toEqual(["GOOG", "MSFT", "AMZN"]);
  });

  it("returns empty array when no trades in range", () => {
    const weekly = getWeeklyTrades(trades, "2026-01-01");
    expect(weekly).toHaveLength(0);
  });

  it("sorts by timestamp ascending", () => {
    const weekly = getWeeklyTrades(trades, "2026-02-10");
    for (let i = 1; i < weekly.length; i++) {
      expect(weekly[i].timestamp).toBeGreaterThanOrEqual(
        weekly[i - 1].timestamp
      );
    }
  });
});

describe("buildReportData", () => {
  const trades = [
    makeTrade({ playerId: "p1", ticker: "AAPL", date: "2026-02-08" }),
  ];
  const currentPrices = { AAPL: 55 };

  it("returns correct structure", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    expect(data.reportDate).toBe("2026-02-10");
    expect(data.leaderboard).toHaveLength(3);
    expect(data.weeklyTrades).toHaveLength(1);
    expect(data.players).toBe(players);
    expect(data.currentPrices).toBe(currentPrices);
  });

  it("leaderboard is sorted by return", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    // p1 has a position with a gain, should be first
    expect(data.leaderboard[0].name).toBe("Daddy");
  });
});

describe("buildCommentaryPrompt", () => {
  const trades = [
    makeTrade({ playerId: "p1", ticker: "AAPL", date: "2026-02-08" }),
    makeTrade({
      playerId: "p2",
      ticker: "GOOG",
      date: "2026-02-09",
      price: 180,
    }),
  ];
  const currentPrices = { AAPL: 55, GOOG: 190 };

  it("includes player standings and trade data", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("Daddy");
    expect(prompt).toContain("Eli");
    expect(prompt).toContain("Yitzi");
    expect(prompt).toContain("AAPL");
    expect(prompt).toContain("GOOG");
    expect(prompt).toContain("2026-02-10");
  });

  it("includes banned words list", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("delve");
    expect(prompt).toContain("landscape");
    expect(prompt).toContain("do NOT use");
  });

  it("specifies casual tone", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("casual and fun");
    expect(prompt).toContain("family");
  });
});

describe("buildEmailHtml", () => {
  const trades = [
    makeTrade({ playerId: "p1", ticker: "AAPL", date: "2026-02-08" }),
    makeTrade({
      playerId: "p2",
      ticker: "GOOG",
      date: "2026-02-09",
      price: 180,
      shares: 50,
    }),
  ];
  const currentPrices = { AAPL: 55, GOOG: 190 };

  it("returns valid HTML with all sections", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    const html = buildEmailHtml(data, "This is the weekly commentary.");

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Stock Picking Contest");
    expect(html).toContain("Weekly Report");
    expect(html).toContain("2026-02-10");
  });

  it("includes commentary text", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    const html = buildEmailHtml(data, "Daddy is crushing it this week.");

    expect(html).toContain("Daddy is crushing it this week.");
  });

  it("includes leaderboard with player names", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    expect(html).toContain("Leaderboard");
    expect(html).toContain("Daddy");
    expect(html).toContain("Eli");
    expect(html).toContain("Yitzi");
  });

  it("includes trade details", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    expect(html).toContain("AAPL");
    expect(html).toContain("GOOG");
    expect(html).toContain("BUY");
  });

  it("includes portfolio details with positions", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    expect(html).toContain("Portfolio Details");
    // AAPL position details
    expect(html).toContain("$50.00"); // avg cost
    expect(html).toContain("$55.00"); // current price
  });

  it("shows 'No trades this week' when no weekly trades", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-01-01");
    const html = buildEmailHtml(data, "Commentary.");

    expect(html).toContain("No trades this week");
  });

  it("shows green/red colors for gains/losses", () => {
    const data = buildReportData(players, trades, currentPrices, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    // AAPL has a gain (bought at 50, current 55), should show green
    expect(html).toContain("#059669"); // green for gains
  });
});
