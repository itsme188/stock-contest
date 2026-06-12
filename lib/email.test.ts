import { describe, it, expect } from "vitest";
import { type Player, type Trade, BENCHMARK_KEY } from "@/lib/contest";
import {
  type WeeklyReportData,
  getWeeklyTrades,
  buildReportData,
  buildCommentaryPrompt,
  buildEmailHtml,
  buildPlainText,
  buildWeeklyHighlights,
  detectCommentaryViolations,
  detectFactualViolations,
  formatCommentary,
  renderHighlightsHtml,
  detectMilestones,
} from "@/lib/email";
import { htmlToCommentaryMarkdown } from "@/lib/commentary";

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

  // Prior bug: a trade executed on Friday before 4:00 PM ET appeared in both
  // that Friday's email and the next Friday's email. The window is now
  // anchored to Friday market close (4:00 PM America/New_York) and half-open
  // on the start side, so a Friday pre-close trade belongs to that Friday's
  // email only.
  it("excludes a trade executed before 4:00 PM ET on the prior Friday", () => {
    // Apr 10, 2026 at 15:00 ET = 19:00 UTC (EDT, UTC-4). One hour before
    // market close -> should belong to the Apr 10 email, not the Apr 17 one.
    const tsBeforeClose = Date.UTC(2026, 3, 10, 19, 0, 0);
    const trade: Trade = {
      id: "bound-before",
      playerId: "p1",
      ticker: "NVDA",
      type: "buy",
      shares: 1,
      price: 100,
      date: "2026-04-10",
      timestamp: tsBeforeClose,
    };
    const weekly = getWeeklyTrades([trade], "2026-04-17");
    expect(weekly).toHaveLength(0);
  });

  it("includes a trade executed after 4:00 PM ET on the prior Friday", () => {
    // Apr 10, 2026 at 17:00 ET = 21:00 UTC. After market close -> belongs to
    // the Apr 17 email because it missed the Apr 10 cutoff.
    const tsAfterClose = Date.UTC(2026, 3, 10, 21, 0, 0);
    const trade: Trade = {
      id: "bound-after",
      playerId: "p1",
      ticker: "NVDA",
      type: "buy",
      shares: 1,
      price: 100,
      date: "2026-04-10",
      timestamp: tsAfterClose,
    };
    const weekly = getWeeklyTrades([trade], "2026-04-17");
    expect(weekly).toHaveLength(1);
  });

  it("excludes a trade executed after 4:00 PM ET on the report Friday", () => {
    // Apr 17, 2026 at 16:30 ET = 20:30 UTC. After close on report day ->
    // rolls into the next week's email.
    const tsAfterReportClose = Date.UTC(2026, 3, 17, 20, 30, 0);
    const trade: Trade = {
      id: "bound-report",
      playerId: "p1",
      ticker: "NVDA",
      type: "buy",
      shares: 1,
      price: 100,
      date: "2026-04-17",
      timestamp: tsAfterReportClose,
    };
    const weekly = getWeeklyTrades([trade], "2026-04-17");
    expect(weekly).toHaveLength(0);
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

  it("starves the AI of pre-ranked data so it cannot paraphrase rankings", () => {
    // The deterministic weekly highlights block is rendered ABOVE the
    // commentary in the email; the AI doesn't need (and shouldn't see) the
    // ranking data. Feeding it "biggest gainer X" tempts paraphrase ("X was
    // the standout pick"), bypassing the no-numbers rule. Phase 4a deletes
    // the ranking summary from the prompt entirely.
    //
    // The string "biggest gainer/laggard" still appears once — in the
    // prohibition rule itself — but the data-block patterns (per-player
    // ranking lines, contest-wide top/bottom mover lines) are gone.
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    // Per-player data lines from renderHighlightsForPrompt — gone.
    expect(prompt).not.toMatch(/best mover [A-Z]+\s+[+\-]/);
    expect(prompt).not.toMatch(/worst mover [A-Z]+\s+[+\-]/);
    // Contest-wide ranking lines from renderHighlightsForPrompt — gone.
    expect(prompt).not.toContain("Contest top mover:");
    expect(prompt).not.toContain("Contest bottom mover:");
    // "Weekly highlights" section header from old prompt — gone.
    expect(prompt).not.toMatch(/Weekly highlights[^\w]/);
  });

  it("includes a cross-portfolio holdings block for verbatim attribution", () => {
    // The AI used to derive cross-holdings from the standings table and got
    // it wrong (claiming a ticker was held "across all portfolios" when only
    // some held it). The prompt now includes a pre-computed lookup.
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("Cross-portfolio holdings");
    expect(prompt).toContain("use these verbatim for attribution");
  });

  it("includes a hard rule banning ranking-paraphrase language", () => {
    // Phase 4c also enforces this via detectCommentaryViolations regex
    // matching, but the prompt rule is the first line of defense.
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("ranking language");
    expect(prompt).toContain("standout");
    expect(prompt).toContain("led the charge");
  });

  it("specifies edge-case behavior for 0-trade and 1-trade weeks", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("EDGE CASES");
    expect(prompt).toContain("No trades this week");
    expect(prompt).toContain("only one trade");
  });

  it("uses active examples to prevent inferring weekly returns on new positions", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toMatch(/✓.*opened a HOOD stake/);
    expect(prompt).toMatch(/✗.*as semiconductor strength returned/);
  });

  it("forbids quoting dollar amounts and percentages", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("DO NOT quote any dollar amount");
    expect(prompt).toContain("DO NOT quote any percentage");
  });

  it("includes example output", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).toContain("EXAMPLE");
    expect(prompt).toContain("Semiconductor strength");
  });

  it("includes VK market context body when provided", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data, "S&P 500 fell 1.5% on tariff fears.");

    expect(prompt).toContain("S&P 500 fell 1.5% on tariff fears.");
    expect(prompt).toContain("Vital Knowledge");
  });

  it("omits VK block when market context is not provided", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data);

    expect(prompt).not.toContain("Vital Knowledge newsletter digests");
  });

  it("omits VK block when market context is empty string", () => {
    const data = buildReportData(players, trades, currentPrices, {}, "2026-02-10");
    const prompt = buildCommentaryPrompt(data, "");

    expect(prompt).not.toContain("Vital Knowledge newsletter digests");
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

describe("htmlToCommentaryMarkdown", () => {
  it("converts <strong> to **bold**", () => {
    const result = htmlToCommentaryMarkdown("<p>This is <strong>bold</strong> text.</p>");
    expect(result).toBe("This is **bold** text.");
  });

  it("converts <b> to **bold** (browser variant)", () => {
    const result = htmlToCommentaryMarkdown("<p>This is <b>bold</b> text.</p>");
    expect(result).toBe("This is **bold** text.");
  });

  it("converts <em> to *italic*", () => {
    const result = htmlToCommentaryMarkdown("<p>This is <em>italic</em> text.</p>");
    expect(result).toBe("This is *italic* text.");
  });

  it("converts <i> to *italic* (browser variant)", () => {
    const result = htmlToCommentaryMarkdown("<p>This is <i>italic</i> text.</p>");
    expect(result).toBe("This is *italic* text.");
  });

  it("handles multiple paragraphs", () => {
    const result = htmlToCommentaryMarkdown(
      '<p style="margin: 0;">First paragraph.</p><p style="margin: 0;">Second paragraph.</p>'
    );
    expect(result).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("handles <div> wrappers (Chrome Enter key)", () => {
    const result = htmlToCommentaryMarkdown(
      "<div>First paragraph.</div><div>Second paragraph.</div>"
    );
    expect(result).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("handles <br> as newline", () => {
    const result = htmlToCommentaryMarkdown("<p>Line one.<br>Line two.</p>");
    expect(result).toBe("Line one.\nLine two.");
  });

  it("strips inline styles from tags", () => {
    const result = htmlToCommentaryMarkdown(
      '<p style="color: red; font-size: 15px;">Clean text.</p>'
    );
    expect(result).toBe("Clean text.");
  });

  it("decodes HTML entities", () => {
    const result = htmlToCommentaryMarkdown("<p>AT&amp;T &lt;3 &quot;quotes&quot;</p>");
    expect(result).toBe('AT&T <3 "quotes"');
  });

  it("collapses excessive newlines", () => {
    const result = htmlToCommentaryMarkdown("<p>A</p><p></p><p></p><p>B</p>");
    expect(result).toBe("A\n\nB");
  });

  it("round-trips with formatCommentary", () => {
    const original = "The **S&P 500** fell 2% this week.\n\nMeanwhile, *tech stocks* rallied.";
    const html = formatCommentary(original);
    const roundTripped = htmlToCommentaryMarkdown(html);
    expect(roundTripped).toBe(original);
  });

  it("handles nested bold+italic", () => {
    const result = htmlToCommentaryMarkdown("<p><strong><em>bold italic</em></strong></p>");
    expect(result).toBe("***bold italic***");
  });
});

describe("buildEmailHtml commentary id", () => {
  it("includes id=\"commentary\" on the commentary div", () => {
    const data = buildReportData(
      [{ id: "p1", name: "Test", color: "#000", initialCash: 100000 }],
      [],
      {},
      {},
      "2026-03-01"
    );
    const result = buildEmailHtml(data, "Test commentary.");
    expect(result).toContain('id="commentary"');
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

// ---- Phase 4 / 5: deterministic highlights + content-quality coverage ----
//
// `buildWeeklyHighlights` is the engine producing the deterministic facts
// that render above the AI commentary. It had zero direct tests before
// Phase 5; the failure modes that were silently shipping (positions dropped
// on missing price history, unfiltered new-this-week ranking, contest-wide
// top/bottom selection) are now covered.

describe("buildWeeklyHighlights", () => {
  // Helper: trades that establish position(s) one ticker per player at $100,
  // dated before the report window so they're "held at week-start".
  const trades: Trade[] = [
    makeTrade({ playerId: "p1", ticker: "AAPL", date: "2026-01-15", price: 100, shares: 100 }),
    makeTrade({ playerId: "p2", ticker: "GOOG", date: "2026-01-15", price: 100, shares: 50 }),
    makeTrade({ playerId: "p3", ticker: "MSFT", date: "2026-01-15", price: 100, shares: 80 }),
  ];
  const currentPrices = { AAPL: 110, GOOG: 95, MSFT: 105 };
  // Prior-week-cutoff prices for "2026-02-10" report: cutoff = "2026-02-03"
  const priceHistory = {
    AAPL: { "2026-02-03": 100 }, // +10% over week
    GOOG: { "2026-02-03": 100 }, // -5%
    MSFT: { "2026-02-03": 100 }, // +5%
  };

  it("computes per-player best 7-day move (single open position)", () => {
    const data = buildReportData(players, trades, currentPrices, priceHistory, "2026-02-10");
    const h = buildWeeklyHighlights(data);

    const daddy = h.perPlayer.find((p) => p.name === "Daddy");
    expect(daddy?.best?.ticker).toBe("AAPL");
    expect(daddy?.best?.pct).toBeCloseTo(10, 5);
    // worst is null when only one position (sorted.length > 1 check)
    expect(daddy?.worst).toBeNull();
  });

  it("selects contest-wide best & worst across all players", () => {
    const data = buildReportData(players, trades, currentPrices, priceHistory, "2026-02-10");
    const h = buildWeeklyHighlights(data);

    expect(h.contestTop?.ticker).toBe("AAPL"); // +10%
    expect(h.contestTop?.player).toBe("Daddy");
    expect(h.contestBottom?.ticker).toBe("GOOG"); // -5%
    expect(h.contestBottom?.player).toBe("Eli");
  });

  it("excludes positions opened this week from rankings", () => {
    // Yitzi opens HOOD this week (after the cutoff).
    const tradesWithNew: Trade[] = [
      ...trades,
      makeTrade({ playerId: "p3", ticker: "HOOD", date: "2026-02-08", price: 70, shares: 100 }),
    ];
    const cp = { ...currentPrices, HOOD: 80 };
    // priceHistory for HOOD at the cutoff would imply +14%, the largest move.
    // Because HOOD is new-this-week it must be excluded.
    const ph = { ...priceHistory, HOOD: { "2026-02-03": 70 } };

    const data = buildReportData(players, tradesWithNew, cp, ph, "2026-02-10");
    const h = buildWeeklyHighlights(data);

    const yitzi = h.perPlayer.find((p) => p.name === "Yitzi");
    expect(yitzi?.newThisWeek).toContain("HOOD");
    // best/worst for Yitzi only reflects MSFT (+5%); HOOD is excluded
    expect(yitzi?.best?.ticker).toBe("MSFT");
    // Contest top mover must be AAPL (+10%), not HOOD (+14%)
    expect(h.contestTop?.ticker).toBe("AAPL");
  });

  it("warns and excludes positions when priceHistory is missing for the cutoff", () => {
    // Drop AAPL's history → it should be excluded with a warning instead of
    // silently disappearing (the pre-Phase-4e behavior).
    const phPartial = {
      GOOG: { "2026-02-03": 100 },
      MSFT: { "2026-02-03": 100 },
    };
    const data = buildReportData(players, trades, currentPrices, phPartial, "2026-02-10");
    const h = buildWeeklyHighlights(data);

    expect(h.warnings.some((w) => w.includes("AAPL") && w.includes("Daddy"))).toBe(true);
    // Daddy has no other positions, so best is null; AAPL was excluded
    const daddy = h.perPlayer.find((p) => p.name === "Daddy");
    expect(daddy?.best).toBeNull();
    // Contest top now reflects MSFT (+5%), since AAPL was excluded
    expect(h.contestTop?.ticker).toBe("MSFT");
  });

  it("returns empty warnings when all positions have price data", () => {
    const data = buildReportData(players, trades, currentPrices, priceHistory, "2026-02-10");
    const h = buildWeeklyHighlights(data);
    expect(h.warnings).toEqual([]);
  });

  it("counts trades per player from the weekly window", () => {
    const tradesWithWeekly: Trade[] = [
      ...trades,
      makeTrade({ playerId: "p1", ticker: "TSLA", date: "2026-02-08", price: 200, shares: 50 }),
      makeTrade({ playerId: "p1", ticker: "AAPL", date: "2026-02-09", type: "sell", price: 105, shares: 50 }),
    ];
    const data = buildReportData(players, tradesWithWeekly, { ...currentPrices, TSLA: 210 }, priceHistory, "2026-02-10");
    const h = buildWeeklyHighlights(data);

    const daddy = h.perPlayer.find((p) => p.name === "Daddy");
    expect(daddy?.tradeCount).toBe(2); // buy TSLA + sell AAPL this week
    const eli = h.perPlayer.find((p) => p.name === "Eli");
    expect(eli?.tradeCount).toBe(0);
  });
});

describe("renderHighlightsHtml", () => {
  // Phase 4e: HTML labels are "Best 7-day move" / "Worst 7-day move", not
  // "Top mover" / "Laggard" — so recipients (and downstream LLMs eyeballing
  // the email) don't conflate a ticker price-move with a "best trade" claim.
  it("uses 7-day-move labels rather than top-mover labels", () => {
    const html = renderHighlightsHtml({
      contestTop: { ticker: "INTC", pct: 5.2, player: "Daddy" },
      contestBottom: { ticker: "MDI", pct: -1.8, player: "Eli" },
      perPlayer: [
        { playerId: "p1", name: "Daddy", best: { ticker: "INTC", pct: 5.2 }, worst: null, newThisWeek: [], tradeCount: 0 },
      ],
      warnings: [],
    });

    expect(html).toContain("Best 7-day move");
    expect(html).toContain("Worst 7-day move");
    expect(html).toContain("7-Day Price Moves");
    expect(html).not.toContain(">Top mover:<");
    expect(html).not.toContain(">Laggard:<");
  });
});

describe("detectCommentaryViolations", () => {
  it("returns zero violations on clean rationale prose", () => {
    const v = detectCommentaryViolations(
      "Eli rotated out of CRCL and built a fresh HOOD stake in two tranches."
    );
    expect(v.numericViolations).toBe(0);
    expect(v.rankingViolations).toBe(0);
  });

  it("counts dollar amounts as numeric violations", () => {
    const v = detectCommentaryViolations("Realized a $3,896 gain on the trim.");
    expect(v.numericViolations).toBeGreaterThan(0);
    expect(v.numericSnippets).toContain("$3,896");
  });

  it("counts percentages as numeric violations", () => {
    const v = detectCommentaryViolations("INTC rallied 20.5% on AI capex news.");
    expect(v.numericViolations).toBeGreaterThan(0);
    expect(v.numericSnippets[0]).toMatch(/20\.5\s?%/);
  });

  it("detects ranking-paraphrase: 'best trade'", () => {
    const v = detectCommentaryViolations("HOOD was the best trade of the week.");
    expect(v.rankingViolations).toBe(1);
    expect(v.rankingSnippets[0].toLowerCase()).toContain("best trade");
  });

  it("detects ranking-paraphrase: 'biggest gainer'", () => {
    const v = detectCommentaryViolations("Yitzi's biggest gainer was an outlier this week.");
    expect(v.rankingViolations).toBe(1);
  });

  it("detects ranking-paraphrase: 'standout'", () => {
    const v = detectCommentaryViolations("HOOD was the standout of the portfolio.");
    expect(v.rankingViolations).toBe(1);
  });

  it("detects ranking-paraphrase: 'led the charge'", () => {
    const v = detectCommentaryViolations("INTC led the charge on semiconductor strength.");
    expect(v.rankingViolations).toBe(1);
  });

  it("detects ranking-paraphrase: 'dominated the week'", () => {
    const v = detectCommentaryViolations("Tech dominated the week.");
    expect(v.rankingViolations).toBe(1);
  });

  it("does not match 'best' inside other words (e.g., 'bestow')", () => {
    const v = detectCommentaryViolations("That trade did not bestow much luck.");
    expect(v.rankingViolations).toBe(0);
  });

  it("counts numeric and ranking violations independently", () => {
    const v = detectCommentaryViolations(
      "INTC was the standout, up 20.5% — a $4,000 gain on Daddy's biggest gainer."
    );
    expect(v.numericViolations).toBeGreaterThanOrEqual(2); // 20.5% + $4,000
    expect(v.rankingViolations).toBeGreaterThanOrEqual(2); // standout + biggest gainer
  });
});

// ---- Phase 6: factual hallucination validator ----
//
// Catches the failure class from the 2026-05-08 email:
//   - Missed trades: AI never mentions Yitzi's HOOD adds despite the prompt
//   - Wrong attribution: "Both also harvested INTC" but only Yitzi did
//   - Hallucinated tickers: AI mentions a ticker no one trades
// detectCommentaryViolations is regex-only and can't see these. The
// factual validator cross-checks the prose against the actual trade log.

describe("detectFactualViolations", () => {
  const tradePlayers = [
    { id: "p1", name: "Daddy", color: "#000" },
    { id: "p2", name: "Eli", color: "#111" },
    { id: "p3", name: "Yitzi", color: "#222" },
  ];

  // Simulating the 2026-05-08 actual trade log
  const weeklyTrades = [
    makeTrade({ playerId: "p2", ticker: "LFMD", date: "2026-05-06", type: "sell" }),
    makeTrade({ playerId: "p3", ticker: "LFMD", date: "2026-05-06", type: "sell" }),
    makeTrade({ playerId: "p3", ticker: "HOOD", date: "2026-05-06", type: "buy" }),
    makeTrade({ playerId: "p3", ticker: "INTC", date: "2026-05-06", type: "sell" }),
    makeTrade({ playerId: "p3", ticker: "HOOD", date: "2026-05-06", type: "buy" }),
    makeTrade({ playerId: "p3", ticker: "APP", date: "2026-05-07", type: "buy" }),
    makeTrade({ playerId: "p2", ticker: "CVV", date: "2026-05-07", type: "buy" }),
    makeTrade({ playerId: "p3", ticker: "TER", date: "2026-05-08", type: "buy" }),
  ];
  const knownTickers = new Set(["LFMD", "HOOD", "INTC", "APP", "CVV", "TER", "MDI", "QS"]);

  it("flags a missed trade when (player, ticker) doesn't co-occur", () => {
    // The 5/8 prose this would have caught: it never mentions HOOD
    const prose = `Eli reduced his LFMD stake. Yitzi followed similar logic, trimming LFMD twice on May 6 and closing the position entirely on May 7, then deployed those proceeds into a new APP position. Both harvested gains from INTC. Eli shifted into a new CVV position. Yitzi added to TER.`;
    const v = detectFactualViolations(prose, weeklyTrades, tradePlayers, knownTickers);
    // Yitzi has HOOD trades this week but HOOD isn't in the prose
    expect(v.missedTrades.some((m) => m.player === "Yitzi" && m.ticker === "HOOD")).toBe(true);
  });

  it("returns no missed trades when every (player, ticker) is co-mentioned", () => {
    const prose =
      "Eli sold LFMD repeatedly. Eli also opened CVV. " +
      "Yitzi sold LFMD, bought HOOD twice, sold INTC, opened APP, and added TER.";
    const v = detectFactualViolations(prose, weeklyTrades, tradePlayers, knownTickers);
    expect(v.missedTrades).toEqual([]);
  });

  it("flags hallucinated tickers not in the contest's known set", () => {
    const prose = "Eli rotated capital into NVDA after their earnings beat.";
    const v = detectFactualViolations(prose, weeklyTrades, tradePlayers, knownTickers);
    expect(v.unknownTickers.some((u) => u.ticker === "NVDA")).toBe(true);
  });

  it("does NOT flag finance abbreviations as unknown tickers", () => {
    const prose = "The CPI print missed; SPX dropped on the news. AI capex remained strong.";
    const v = detectFactualViolations(prose, weeklyTrades, tradePlayers, knownTickers);
    // CPI, SPX, AI should all be recognized as finance/general acronyms, not tickers
    expect(v.unknownTickers.map((u) => u.ticker)).not.toContain("CPI");
    expect(v.unknownTickers.map((u) => u.ticker)).not.toContain("SPX");
    expect(v.unknownTickers.map((u) => u.ticker)).not.toContain("AI");
  });

  it("respects word boundaries (TER doesn't match 'after' or 'INTER')", () => {
    // Yitzi's TER trade requires "Yitzi" + "TER" to co-occur. Words like
    // "after" embed "ter" but with the \b regex it shouldn't match TER.
    const prose = "Yitzi sold LFMD, bought HOOD, sold INTC, opened APP. Daddy stood pat after a quiet week.";
    const v = detectFactualViolations(prose, weeklyTrades, tradePlayers, knownTickers);
    // TER should be flagged as missed (Yitzi's TER trade not co-mentioned)
    expect(v.missedTrades.some((m) => m.player === "Yitzi" && m.ticker === "TER")).toBe(true);
  });

  it("counts a (player, ticker) co-occurrence within ~250 chars as covered", () => {
    // Ticker mentioned ~150 chars after player name (typical sentence span)
    const filler = "did some things over the course of the day, taking advantage of the morning move and then waiting until later.";
    const prose = `Yitzi ${filler} The notable transaction was an LFMD sell.`;
    const v = detectFactualViolations(prose, weeklyTrades, tradePlayers, knownTickers);
    expect(v.missedTrades.some((m) => m.player === "Yitzi" && m.ticker === "LFMD")).toBe(false);
  });
});

describe("buildReportData contestStartDate", () => {
  it("buildReportData carries contestStartDate (defaulting when omitted)", () => {
    const data = buildReportData([], [], {}, {}, "2026-06-12", "2026-01-14");
    expect(data.contestStartDate).toBe("2026-01-14");
    const defaulted = buildReportData([], [], {}, {}, "2026-06-12");
    expect(defaulted.contestStartDate).toBe("2026-01-01");
  });
});

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

  it("provides a number-free aiText for drawdown recoveries", () => {
    const trades = [
      { id: "1", playerId: "p1", type: "buy", ticker: "A", shares: 1000, price: 100, date: "2026-05-01", timestamp: 1 },
    ] as Trade[];
    const priceHistory = {
      A: { "2026-05-01": 100, "2026-05-08": 104, "2026-05-22": 96, "2026-06-12": 107 },
    };
    const data = {
      leaderboard: [{ id: "p1", name: "Daddy", totalValue: 107000 }],
      weekDeltas: [{ playerId: "p1", rankChange: 0 }],
      trades,
      priceHistory,
      reportDate: "2026-06-12",
      contestStartDate: "2026-05-01",
    } as unknown as WeeklyReportData;
    const m = detectMilestones(data).find((x) => x.type === "drawdown_recovered")!;
    expect(m.text).toMatch(/\d+% drawdown/);   // banner keeps the number
    expect(m.aiText).not.toMatch(/[\d%]/);     // AI variant must be number-free
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

  it("suppresses leader_change in week 1 (previous ranking is meaningless)", () => {
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
      contestStartDate: "2026-06-09", // contest started mid-week — weekAgo < start
    } as unknown as WeeklyReportData;
    expect(detectMilestones(data)).toEqual([]);
  });
});

// ---- Task 15: email template upgrades ----
//
// Milestones banner, per-player vs-SPY line, contest statistics table,
// data-notes footer, and AI-prompt milestones block.

describe("email template upgrades", () => {
  // Fixture: all three players each hold a position established before the
  // report window.  priceHistory includes a BENCHMARK_KEY (SPY) series
  // covering contestStartDate through the reportDate, so getBenchmarkReturnAtDate
  // returns a non-null value and the vs-SPY line renders.
  function reportDataFixture(): WeeklyReportData {
    const fixtureTrades: Trade[] = [
      makeTrade({ playerId: "p1", ticker: "AAPL", date: "2026-01-20", price: 100, shares: 100 }),
      makeTrade({ playerId: "p2", ticker: "GOOG", date: "2026-01-20", price: 100, shares: 50 }),
      makeTrade({ playerId: "p3", ticker: "MSFT", date: "2026-01-20", price: 100, shares: 80 }),
    ];
    const currentPrices = { AAPL: 110, GOOG: 95, MSFT: 105 };
    const priceHistory = {
      AAPL: { "2026-01-14": 95, "2026-01-20": 100, "2026-02-03": 105, "2026-02-10": 110 },
      GOOG: { "2026-01-14": 105, "2026-01-20": 100, "2026-02-03": 98, "2026-02-10": 95 },
      MSFT: { "2026-01-14": 98, "2026-01-20": 100, "2026-02-03": 102, "2026-02-10": 105 },
      [BENCHMARK_KEY]: { "2026-01-14": 480, "2026-02-03": 490, "2026-02-10": 495 },
    };
    return buildReportData(players, fixtureTrades, currentPrices, priceHistory, "2026-02-10", "2026-01-14");
  }

  // Fixture: p1 (Daddy) buys AAPL this week and jumps from rank 1 → rank 0,
  // displacing p2 (Eli) who held GOOG from before the week window.
  // weekAgo = 2026-02-03 >= contestStartDate 2026-01-14 → leader_change fires.
  function leaderChangeFixture(): WeeklyReportData {
    const fixtureTrades: Trade[] = [
      makeTrade({ playerId: "p2", ticker: "GOOG", date: "2026-01-20", price: 100, shares: 50 }),
      makeTrade({ playerId: "p1", ticker: "AAPL", date: "2026-02-08", price: 100, shares: 200 }),
    ];
    const currentPrices = { AAPL: 130, GOOG: 110 };
    const priceHistory = {
      AAPL: { "2026-01-14": 100, "2026-02-03": 100, "2026-02-10": 130 },
      GOOG: { "2026-01-14": 100, "2026-01-20": 100, "2026-02-03": 110, "2026-02-10": 110 },
      [BENCHMARK_KEY]: { "2026-01-14": 480, "2026-02-03": 490, "2026-02-10": 495 },
    };
    return buildReportData(players, fixtureTrades, currentPrices, priceHistory, "2026-02-10", "2026-01-14");
  }

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

  it("prompt milestones block contains no % when drawdown_recovered fires", () => {
    // Build real report data that produces a drawdown_recovered milestone:
    // Player buys A at $100, A rises to $104 (new high), drops to $96 (>5% drawdown),
    // then recovers to $107 (new contest high) — triggering drawdown_recovered.
    const drawdownTrades: Trade[] = [
      { id: "1", playerId: "p1", type: "buy", ticker: "A", shares: 1000, price: 100, date: "2026-05-01", timestamp: 1 } as Trade,
    ];
    const data = buildReportData(
      [{ id: "p1", name: "Daddy", color: "#3B82F6" }],
      drawdownTrades,
      { A: 107 },
      { A: { "2026-05-01": 100, "2026-05-08": 104, "2026-05-22": 96, "2026-06-12": 107 } },
      "2026-06-12",
      "2026-05-01"
    );
    const prompt = buildCommentaryPrompt(data);
    // The MILESTONES block is appended at the end of the prompt.
    const milestonesIdx = prompt.lastIndexOf("MILESTONES");
    expect(milestonesIdx).toBeGreaterThan(-1);
    const milestonesSection = prompt.slice(milestonesIdx);
    expect(milestonesSection).toContain("sizable drawdown");
    expect(milestonesSection).not.toMatch(/%/);
  });

  it("escapes HTML in data notes", () => {
    const html = buildEmailHtml(reportDataFixture(), "Commentary.", ["note with <tag> & ampersand"]);
    expect(html).toContain("note with &lt;tag&gt; &amp; ampersand");
    expect(html).not.toContain("note with <tag>");
  });
});
