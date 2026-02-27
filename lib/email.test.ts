import { describe, it, expect } from "vitest";
import { type Player, type Trade } from "@/lib/contest";
import {
  getWeeklyTrades,
  buildReportData,
  buildCommentaryPrompt,
  buildEmailHtml,
  buildPlainText,
  formatCommentary,
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
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    expect(data.reportDate).toBe("2026-02-10");
    expect(data.leaderboard).toHaveLength(3);
    expect(data.weeklyTrades).toHaveLength(1);
    expect(data.weekDeltas).toHaveLength(3);
    expect(data.players).toBe(players);
    expect(data.currentPrices).toBe(currentPrices);
  });

  it("leaderboard is sorted by return", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    // p1 has a position with a gain, should be first
    expect(data.leaderboard[0].name).toBe("Daddy");
  });

  it("computes week-over-week deltas", () => {
    // Trade on Feb 8 means it's within the last week relative to Feb 10
    // so "previous week" leaderboard has no trades for p1 -> p1 was at $100k
    // current leaderboard: p1 bought 100 shares at $50, now worth $55 each
    // p1 total value = $95,000 cash + $5,500 = $100,500
    // week change = $100,500 - $100,000 = $500
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const daddyDelta = data.weekDeltas.find((d) => d.name === "Daddy");
    expect(daddyDelta).toBeDefined();
    expect(daddyDelta!.weekChange).toBe(500);
    expect(daddyDelta!.weekChangePct).toBeCloseTo(0.5, 1);
  });

  it("uses historical prices for week deltas when priceHistory provided", () => {
    // Player bought 100 shares of AAPL at $50 on Feb 1 (before cutoff)
    // Cutoff for Feb 10 report = Feb 3
    // Price on Feb 3 was $52, current price is $55
    // Previous value: $95,000 cash + 100 * $52 = $100,200
    // Current value: $95,000 cash + 100 * $55 = $100,500
    // Week change should be $300, not $500
    const earlyTrades = [
      makeTrade({ playerId: "p1", ticker: "AAPL", date: "2026-02-01" }),
    ];
    const prices = { AAPL: 55 };
    const history = { AAPL: { "2026-02-01": 50, "2026-02-03": 52 } };
    const data = buildReportData(players, earlyTrades, prices, history, "2026-02-10");
    const daddyDelta = data.weekDeltas.find((d) => d.name === "Daddy");
    expect(daddyDelta).toBeDefined();
    expect(daddyDelta!.weekChange).toBe(300);
    expect(daddyDelta!.weekChangePct).toBeCloseTo(0.2994, 1);
  });

  it("detects rank changes", () => {
    // Before this week: all players at $100k, no trades -> tied
    // After: Daddy has a gain, others don't
    // Daddy should be rank 0 now. Before, all were effectively tied.
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const daddyDelta = data.weekDeltas.find((d) => d.name === "Daddy");
    expect(daddyDelta).toBeDefined();
    // Daddy moved up or stayed (exact rank depends on sort stability for ties)
    expect(daddyDelta!.rankChange).toBeGreaterThanOrEqual(0);
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
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("Daddy");
    expect(prompt).toContain("Eli");
    expect(prompt).toContain("Yitzi");
    expect(prompt).toContain("AAPL");
    expect(prompt).toContain("GOOG");
    expect(prompt).toContain("2026-02-10");
  });

  it("includes banned words list", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("delve");
    expect(prompt).toContain("landscape");
    expect(prompt).toContain("Do NOT use");
  });

  it("specifies hedge fund letter tone", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("investor letter");
    expect(prompt).toContain("dry");
    expect(prompt).toContain("matter-of-fact");
  });

  it("includes week-over-week change data", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("Week:");
    expect(prompt).toContain("Realized P&L:");
    expect(prompt).toContain("Win rate:");
  });

  it("includes example output", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("EXAMPLE:");
  });

  it("includes weekly price change when priceHistory available", () => {
    const history = { AAPL: { "2026-02-03": 50 }, GOOG: { "2026-02-03": 180 } };
    const data = buildReportData(players, trades, currentPrices, history, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    // AAPL: was $50, now $55 = +10% this week
    expect(prompt).toContain("this week");
    expect(prompt).toContain("total");
  });

  it("includes market context when provided", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data, "S&P 500 fell 1.5% on tariff fears.");

    expect(prompt).toContain("MARKET CONTEXT");
    expect(prompt).toContain("S&P 500 fell 1.5% on tariff fears.");
    expect(prompt).toContain("Contest data is still the primary focus");
  });

  it("omits market context section when not provided", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).not.toContain("MARKET CONTEXT");
  });

  it("omits market context section when empty string", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data, "");

    expect(prompt).not.toContain("MARKET CONTEXT");
  });
});

describe("formatCommentary", () => {
  it("converts **bold** to <strong>", () => {
    const result = formatCommentary("This is **bold text** here.");
    expect(result).toContain("<strong>bold text</strong>");
    expect(result).not.toContain("**");
  });

  it("converts *italic* to <em>", () => {
    const result = formatCommentary("This is *italic text* here.");
    expect(result).toContain("<em>italic text</em>");
    expect(result).not.toContain("*italic text*");
  });

  it("splits paragraphs on double newlines", () => {
    const result = formatCommentary("Paragraph one.\n\nParagraph two.");
    const pCount = (result.match(/<p /g) || []).length;
    expect(pCount).toBe(2);
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
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "This is the weekly commentary.");

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Stock Picking Contest");
    expect(html).toContain("Weekly Report");
    expect(html).toContain("2026-02-10");
  });

  it("includes commentary text", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "Daddy is crushing it this week.");

    expect(html).toContain("Daddy is crushing it this week.");
  });

  it("includes leaderboard with player names", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    expect(html).toContain("Leaderboard");
    expect(html).toContain("Daddy");
    expect(html).toContain("Eli");
    expect(html).toContain("Yitzi");
  });

  it("includes trade details", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    expect(html).toContain("AAPL");
    expect(html).toContain("GOOG");
    expect(html).toContain("BUY");
  });

  it("includes portfolio details with positions", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    expect(html).toContain("Portfolio Details");
    // AAPL position details
    expect(html).toContain("$50.00"); // avg cost
    expect(html).toContain("$55.00"); // current price
  });

  it("shows 'No trades this week' when no weekly trades", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-01-01");
    const html = buildEmailHtml(data, "Commentary.");

    expect(html).toContain("No trades this week");
  });

  it("shows green/red colors for gains/losses", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    // AAPL has a gain (bought at 50, current 55), should show green
    expect(html).toContain("#059669"); // green for gains
  });

  it("converts markdown bold to strong tags in commentary", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "This is **really bold** stuff.");

    expect(html).toContain("<strong>really bold</strong>");
    expect(html).not.toContain("**really bold**");
  });

  it("includes week change indicators", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    // Should contain up/down triangle arrows
    expect(html).toMatch(/&#9650;|&#9660;/);
  });

  it("includes gradient header", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    expect(html).toContain("linear-gradient");
  });

  it("includes gain/loss progress bars in portfolio details", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const html = buildEmailHtml(data, "Commentary.");

    // AAPL has a 10% gain, should show a bar
    expect(html).toContain("width: 10%"); // 10% gain bar
  });
});

describe("buildPlainText", () => {
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

  it("returns plain text without HTML tags", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const text = buildPlainText(data, "Commentary paragraph.");

    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
  });

  it("includes commentary text", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const text = buildPlainText(data, "Daddy is crushing it.");

    expect(text).toContain("Daddy is crushing it.");
  });

  it("includes leaderboard data", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const text = buildPlainText(data, "Commentary.");

    expect(text).toContain("Daddy");
    expect(text).toContain("Eli");
    expect(text).toContain("Yitzi");
    expect(text).toContain("LEADERBOARD");
  });

  it("strips markdown formatting", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const text = buildPlainText(data, "This is **bold** and *italic*.");

    expect(text).toContain("This is bold and italic.");
    expect(text).not.toContain("**");
    expect(text).not.toContain("*italic*");
  });

  it("includes trade details", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const text = buildPlainText(data, "Commentary.");

    expect(text).toContain("AAPL");
    expect(text).toContain("GOOG");
    expect(text).toContain("BUY");
  });

  it("includes portfolio details with positions", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const text = buildPlainText(data, "Commentary.");

    expect(text).toContain("PORTFOLIO DETAILS");
    expect(text).toContain("$50.00"); // avg cost
    expect(text).toContain("$55.00"); // current price
  });
});
