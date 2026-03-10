import { describe, it, expect } from "vitest";
import {
  Trade,
  getPlayerPositions,
  getOpenPositionCount,
  canAddPosition,
  getLatestTradePrice,
  getCurrentPrice,
  getLastSaleProceeds,
  getPlayerStats,
  getLeaderboard,
  getPriceAtDate,
  getPlayerValueAtDate,
  getPerformanceChartData,
  getPriceStaleness,
  formatCurrency,
  formatPercent,
  validateTrade,
  STARTING_CASH,
} from "@/lib/contest";

// --- Helpers ---

let tradeCounter = 0;

function makeTrade(
  overrides: Partial<Trade> &
    Pick<Trade, "playerId" | "type" | "ticker" | "shares" | "price" | "date">
): Trade {
  tradeCounter++;
  return {
    id: `trade-${tradeCounter}`,
    timestamp: new Date(overrides.date).getTime() + tradeCounter,
    ...overrides,
  };
}

const PLAYER_A = "player-a";
const PLAYER_B = "player-b";

// --- getPlayerPositions ---

describe("getPlayerPositions", () => {
  it("single buy creates one position with correct shares and avgCost", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 100,
        price: 150,
        date: "2026-01-10",
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(1);
    expect(positions[0].ticker).toBe("AAPL");
    expect(positions[0].shares).toBe(100);
    expect(positions[0].avgCost).toBe(150);
    expect(positions[0].totalCost).toBe(15000);
  });

  it("multiple buys at different prices computes correct weighted avgCost", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 100,
        price: 100,
        date: "2026-01-10",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 50,
        price: 200,
        date: "2026-01-11",
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(1);
    expect(positions[0].shares).toBe(150);
    expect(positions[0].totalCost).toBe(20000);
    expect(positions[0].avgCost).toBeCloseTo(133.33, 1);
  });

  it("buy then full sell results in no open position", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 100,
        price: 150,
        date: "2026-01-10",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "sell",
        ticker: "AAPL",
        shares: 100,
        price: 200,
        date: "2026-01-15",
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(0);
  });

  it("buy then partial sell leaves remaining shares at original cost", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 100,
        price: 150,
        date: "2026-01-10",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "sell",
        ticker: "AAPL",
        shares: 40,
        price: 200,
        date: "2026-01-15",
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(1);
    expect(positions[0].shares).toBe(60);
    expect(positions[0].avgCost).toBe(150);
    expect(positions[0].totalCost).toBe(9000);
  });

  it("FIFO: multiple lots, sell consumes oldest lot first", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 50,
        price: 100,
        date: "2026-01-10",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 50,
        price: 200,
        date: "2026-01-11",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "sell",
        ticker: "AAPL",
        shares: 50,
        price: 180,
        date: "2026-01-15",
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(1);
    expect(positions[0].shares).toBe(50);
    expect(positions[0].avgCost).toBe(200);
    expect(positions[0].totalCost).toBe(10000);
  });

  it("FIFO: sell spanning two lots", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 30,
        price: 100,
        date: "2026-01-10",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 70,
        price: 200,
        date: "2026-01-11",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "sell",
        ticker: "AAPL",
        shares: 50,
        price: 180,
        date: "2026-01-15",
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(1);
    // 30 from first lot consumed, 20 from second lot consumed, 50 remain from second lot
    expect(positions[0].shares).toBe(50);
    expect(positions[0].avgCost).toBe(200);
    expect(positions[0].totalCost).toBe(10000);
  });

  it("buy, sell all, buy again (re-entry) creates fresh position", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 100,
        price: 150,
        date: "2026-01-10",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "sell",
        ticker: "AAPL",
        shares: 100,
        price: 200,
        date: "2026-01-15",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 50,
        price: 180,
        date: "2026-01-20",
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(1);
    expect(positions[0].shares).toBe(50);
    expect(positions[0].avgCost).toBe(180);
    expect(positions[0].totalCost).toBe(9000);
  });

  it("multiple tickers tracked independently", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 100,
        price: 150,
        date: "2026-01-10",
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "GOOG",
        shares: 50,
        price: 300,
        date: "2026-01-11",
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(2);
    const aapl = positions.find((p) => p.ticker === "AAPL")!;
    const goog = positions.find((p) => p.ticker === "GOOG")!;
    expect(aapl.shares).toBe(100);
    expect(goog.shares).toBe(50);
  });

  it("filters only the given player's trades", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 100,
        price: 150,
        date: "2026-01-10",
      }),
      makeTrade({
        playerId: PLAYER_B,
        type: "buy",
        ticker: "GOOG",
        shares: 50,
        price: 300,
        date: "2026-01-11",
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(1);
    expect(positions[0].ticker).toBe("AAPL");
  });

  it("returns empty array when player has no trades", () => {
    const positions = getPlayerPositions(PLAYER_A, []);
    expect(positions).toHaveLength(0);
  });

  it("trades are processed in timestamp order regardless of input order", () => {
    // Sell comes first in array but has later timestamp
    const trades = [
      makeTrade({
        playerId: PLAYER_A,
        type: "sell",
        ticker: "AAPL",
        shares: 50,
        price: 200,
        date: "2026-01-15",
        timestamp: new Date("2026-01-15").getTime(),
      }),
      makeTrade({
        playerId: PLAYER_A,
        type: "buy",
        ticker: "AAPL",
        shares: 100,
        price: 150,
        date: "2026-01-10",
        timestamp: new Date("2026-01-10").getTime(),
      }),
    ];
    const positions = getPlayerPositions(PLAYER_A, trades);
    expect(positions).toHaveLength(1);
    expect(positions[0].shares).toBe(50);
  });
});

// --- getOpenPositionCount ---

describe("getOpenPositionCount", () => {
  it("returns 0 for player with no trades", () => {
    expect(getOpenPositionCount(PLAYER_A, [])).toBe(0);
  });

  it("returns correct count of distinct open tickers", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 300, date: "2026-01-11" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "MSFT", shares: 80, price: 400, date: "2026-01-12" }),
    ];
    expect(getOpenPositionCount(PLAYER_A, trades)).toBe(3);
  });

  it("does not count fully sold positions", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 200, date: "2026-01-15" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 300, date: "2026-01-11" }),
    ];
    expect(getOpenPositionCount(PLAYER_A, trades)).toBe(1);
  });
});

// --- canAddPosition ---

describe("canAddPosition", () => {
  it("allows adding when player has fewer than 5 positions", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 10, price: 150, date: "2026-01-10" }),
    ];
    expect(canAddPosition(PLAYER_A, "GOOG", trades)).toBe(true);
  });

  it("allows buying into an existing open position (same ticker)", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 10, price: 150, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 10, price: 300, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "MSFT", shares: 10, price: 400, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "TSLA", shares: 10, price: 200, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AMZN", shares: 10, price: 180, date: "2026-01-10" }),
    ];
    // Already at 5 positions, but buying into existing one is OK
    expect(canAddPosition(PLAYER_A, "AAPL", trades)).toBe(true);
  });

  it("blocks adding a 6th distinct position", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 10, price: 150, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 10, price: 300, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "MSFT", shares: 10, price: 400, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "TSLA", shares: 10, price: 200, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AMZN", shares: 10, price: 180, date: "2026-01-10" }),
    ];
    expect(canAddPosition(PLAYER_A, "NVDA", trades)).toBe(false);
  });
});

// --- getLatestTradePrice ---

describe("getLatestTradePrice", () => {
  it("returns most recent trade price for a ticker", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 50, price: 160, date: "2026-01-15" }),
    ];
    expect(getLatestTradePrice("AAPL", trades)).toBe(160);
  });

  it("returns null when no trades exist for ticker", () => {
    expect(getLatestTradePrice("AAPL", [])).toBeNull();
  });

  it("picks most recent by timestamp, not by array order", () => {
    const trades = [
      makeTrade({
        playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 50, price: 160,
        date: "2026-01-15", timestamp: new Date("2026-01-15").getTime(),
      }),
      makeTrade({
        playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150,
        date: "2026-01-10", timestamp: new Date("2026-01-10").getTime(),
      }),
    ];
    expect(getLatestTradePrice("AAPL", trades)).toBe(160);
  });
});

// --- getCurrentPrice ---

describe("getCurrentPrice", () => {
  it("returns currentPrices entry when available", () => {
    const currentPrices = { AAPL: 175 };
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
    ];
    expect(getCurrentPrice("AAPL", currentPrices, trades)).toBe(175);
  });

  it("falls back to latest trade price when no current price", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
    ];
    expect(getCurrentPrice("AAPL", {}, trades)).toBe(150);
  });

  it("returns 0 when neither current price nor trades exist", () => {
    expect(getCurrentPrice("AAPL", {}, [])).toBe(0);
  });
});

// --- getPlayerStats ---

describe("getPlayerStats", () => {
  it("returns STARTING_CASH as totalValue when no trades", () => {
    const stats = getPlayerStats(PLAYER_A, [], {});
    expect(stats.totalValue).toBe(STARTING_CASH);
    expect(stats.cashRemaining).toBe(STARTING_CASH);
    expect(stats.portfolioValue).toBe(0);
    expect(stats.realizedGains).toBe(0);
    expect(stats.unrealizedGains).toBe(0);
    expect(stats.totalTrades).toBe(0);
  });

  describe("cash tracking", () => {
    it("deducts buy cost from cash", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      expect(stats.cashRemaining).toBe(STARTING_CASH - 15000);
    });

    it("adds sell proceeds to cash", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 200, date: "2026-01-15" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      expect(stats.cashRemaining).toBe(STARTING_CASH - 15000 + 20000);
    });

    it("handles multiple buys and sells correctly", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-11" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 120, date: "2026-01-15" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      // 100000 - 10000 - 10000 + 12000 = 92000
      expect(stats.cashRemaining).toBe(92000);
    });
  });

  describe("realized gains", () => {
    it("computes gain from a winning trade", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      expect(stats.realizedGains).toBe(5000);
    });

    it("computes loss from a losing trade", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-15" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      expect(stats.realizedGains).toBe(-5000);
    });

    it("FIFO cost basis for partial sells across multiple lots", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 50, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 50, price: 200, date: "2026-01-11" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 50, price: 150, date: "2026-01-15" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      // FIFO: sell 50 shares, cost basis = 50 * $100 = $5000, proceeds = 50 * $150 = $7500
      expect(stats.realizedGains).toBe(2500);
      expect(stats.closedTrades).toHaveLength(1);
      expect(stats.closedTrades[0].costBasis).toBe(5000);
      expect(stats.closedTrades[0].proceeds).toBe(7500);
    });
  });

  describe("unrealized gains", () => {
    it("computes unrealized gains using current prices", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, { AAPL: 120 });
      expect(stats.unrealizedGains).toBe(2000);
      expect(stats.portfolioValue).toBe(12000);
    });

    it("handles multiple open positions", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-11" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, { AAPL: 120, GOOG: 180 });
      // AAPL: unrealized = 100*(120-100) = 2000
      // GOOG: unrealized = 50*(180-200) = -1000
      expect(stats.unrealizedGains).toBe(1000);
    });
  });

  describe("portfolio value and total return", () => {
    it("totalValue = cashRemaining + portfolioValue", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, { AAPL: 120 });
      expect(stats.totalValue).toBe(stats.cashRemaining + stats.portfolioValue);
    });

    it("totalReturn = totalValue - STARTING_CASH", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, { AAPL: 120 });
      expect(stats.totalReturn).toBe(stats.totalValue - STARTING_CASH);
    });

    it("returnPct = (totalReturn / STARTING_CASH) * 100", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, { AAPL: 120 });
      expect(stats.returnPct).toBeCloseTo(
        (stats.totalReturn / STARTING_CASH) * 100,
        5
      );
    });
  });

  describe("closed trade stats", () => {
    it("closedTrades array contains correct entries with gain/gainPct", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      expect(stats.closedTrades).toHaveLength(1);
      expect(stats.closedTrades[0].gain).toBe(5000);
      expect(stats.closedTrades[0].gainPct).toBe(50);
    });

    it("winningTrades counts trades with gain > 0", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }),
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-11" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "GOOG", shares: 50, price: 180, date: "2026-01-16" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      expect(stats.winningTrades).toBe(1);
      expect(stats.losingTrades).toBe(1);
    });

    it("winRate percentage is correct", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }),
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-11" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "GOOG", shares: 50, price: 250, date: "2026-01-16" }),
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "MSFT", shares: 30, price: 300, date: "2026-01-12" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "MSFT", shares: 30, price: 280, date: "2026-01-17" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      // 2 wins, 1 loss = 66.67%
      expect(stats.winRate).toBeCloseTo(66.67, 1);
    });

    it("bestTrade is the closed trade with highest gainPct", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }),
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-11" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "GOOG", shares: 50, price: 260, date: "2026-01-16" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      expect(stats.bestTrade!.ticker).toBe("AAPL"); // 50% gain vs 30% gain
    });

    it("worstTrade is the closed trade with lowest gainPct", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 90, date: "2026-01-15" }),
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-11" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "GOOG", shares: 50, price: 150, date: "2026-01-16" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      // AAPL: (9000-10000)/10000 = -10%, GOOG: (7500-10000)/10000 = -25%
      expect(stats.worstTrade!.ticker).toBe("GOOG");
    });

    it("bestTrade/worstTrade are null when no closed trades", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      expect(stats.bestTrade).toBeNull();
      expect(stats.worstTrade).toBeNull();
    });
  });

  describe("totalTrades", () => {
    it("counts all trades for the player (buys + sells)", () => {
      const trades = [
        makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
        makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 50, price: 150, date: "2026-01-15" }),
        makeTrade({ playerId: PLAYER_B, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-11" }),
      ];
      const stats = getPlayerStats(PLAYER_A, trades, {});
      expect(stats.totalTrades).toBe(2);
    });
  });
});

// --- getLeaderboard ---

describe("getLeaderboard", () => {
  it("returns players sorted by returnPct descending", () => {
    const players = [
      { id: PLAYER_A, name: "Alice", color: "#3B82F6" },
      { id: PLAYER_B, name: "Bob", color: "#10B981" },
    ];
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_B, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-10" }),
    ];
    // Alice: AAPL at 120 => unrealized = 2000 => returnPct = 2%
    // Bob: GOOG at 250 => unrealized = 2500 => returnPct = 2.5%
    const leaderboard = getLeaderboard(players, trades, { AAPL: 120, GOOG: 250 });
    expect(leaderboard[0].name).toBe("Bob");
    expect(leaderboard[1].name).toBe("Alice");
  });

  it("merges player info with stats", () => {
    const players = [{ id: PLAYER_A, name: "Alice", color: "#3B82F6" }];
    const leaderboard = getLeaderboard(players, [], {});
    expect(leaderboard[0].name).toBe("Alice");
    expect(leaderboard[0].totalValue).toBe(STARTING_CASH);
  });

  it("returns empty array when no players", () => {
    expect(getLeaderboard([], [], {})).toHaveLength(0);
  });
});

// --- getPriceAtDate ---

describe("getPriceAtDate", () => {
  const priceHistory = {
    AAPL: {
      "2026-01-10": 150,
      "2026-01-13": 155,
      "2026-01-15": 160,
    },
  };

  it("returns exact match when date exists in history", () => {
    expect(getPriceAtDate("AAPL", "2026-01-13", priceHistory)).toBe(155);
  });

  it("returns most recent price on or before the given date", () => {
    // 2026-01-12 has no exact match, should return 2026-01-10 price
    expect(getPriceAtDate("AAPL", "2026-01-12", priceHistory)).toBe(150);
  });

  it("returns null when no history exists for ticker", () => {
    expect(getPriceAtDate("GOOG", "2026-01-10", priceHistory)).toBeNull();
  });

  it("returns null when all history dates are after the given date", () => {
    expect(getPriceAtDate("AAPL", "2026-01-05", priceHistory)).toBeNull();
  });

  it("returns the price when querying the exact first date", () => {
    expect(getPriceAtDate("AAPL", "2026-01-10", priceHistory)).toBe(150);
  });
});

// --- getPlayerValueAtDate ---

describe("getPlayerValueAtDate", () => {
  it("returns STARTING_CASH when no trades before the date", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }),
    ];
    const value = getPlayerValueAtDate(PLAYER_A, "2026-01-10", trades, {});
    expect(value).toBe(STARTING_CASH);
  });

  it("computes value correctly with trades before the cutoff", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
    ];
    const priceHistory = { AAPL: { "2026-01-15": 120 } };
    const value = getPlayerValueAtDate(PLAYER_A, "2026-01-15", trades, priceHistory);
    // cash = 100000 - 10000 = 90000, portfolio = 100 * 120 = 12000
    expect(value).toBe(102000);
  });

  it("ignores trades after the cutoff date", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-20" }),
    ];
    const value = getPlayerValueAtDate(PLAYER_A, "2026-01-15", trades, {});
    // Only the AAPL buy is included. No price history, falls back to trade price.
    // cash = 100000 - 10000 = 90000, portfolio = 100 * 100 = 10000
    expect(value).toBe(100000);
  });

  it("uses priceHistory for portfolio valuation", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
    ];
    const priceHistory = { AAPL: { "2026-01-10": 100, "2026-01-15": 130 } };
    const value = getPlayerValueAtDate(PLAYER_A, "2026-01-15", trades, priceHistory);
    // cash = 90000, portfolio = 100 * 130 = 13000
    expect(value).toBe(103000);
  });

  it("falls back to last trade price when no history for date", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
    ];
    const value = getPlayerValueAtDate(PLAYER_A, "2026-01-15", trades, {});
    // No price history, falls back to trade price of 100
    // cash = 90000, portfolio = 100 * 100 = 10000
    expect(value).toBe(100000);
  });

  it("handles sells correctly in historical computation", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }),
    ];
    const value = getPlayerValueAtDate(PLAYER_A, "2026-01-20", trades, {});
    // cash = 100000 - 10000 + 15000 = 105000, no open positions
    expect(value).toBe(105000);
  });
});

// --- getPerformanceChartData ---

describe("getPerformanceChartData", () => {
  it("returns empty array when no players", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
    ];
    expect(getPerformanceChartData([], trades, {}, {})).toHaveLength(0);
  });

  it("returns empty array when no trades", () => {
    const players = [{ id: PLAYER_A, name: "Alice", color: "#3B82F6" }];
    expect(getPerformanceChartData(players, [], {}, {})).toHaveLength(0);
  });

  it("produces one data point per unique date from trades and priceHistory", () => {
    const players = [{ id: PLAYER_A, name: "Alice", color: "#3B82F6" }];
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
    ];
    const priceHistory = { AAPL: { "2026-01-10": 100, "2026-01-15": 120 } };
    const data = getPerformanceChartData(players, trades, {}, priceHistory);
    // Dates: 2026-01-10 (from trade + priceHistory), 2026-01-15 (from priceHistory)
    expect(data).toHaveLength(2);
    expect(data[0].date).toBe("2026-01-10");
    expect(data[1].date).toBe("2026-01-15");
  });

  it("filters dates before contestStartDate", () => {
    const players = [{ id: PLAYER_A, name: "Alice", color: "#3B82F6" }];
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
    ];
    const priceHistory = {
      AAPL: { "2025-11-15": 90, "2025-12-15": 95, "2026-01-05": 98, "2026-01-10": 100, "2026-01-15": 120 },
    };
    const data = getPerformanceChartData(players, trades, {}, priceHistory, undefined, "2026-01-01");
    // Only dates >= 2026-01-01: Jan 5, Jan 10, Jan 15
    expect(data).toHaveLength(3);
    expect(data[0].date).toBe("2026-01-05");
    expect(data[1].date).toBe("2026-01-10");
    expect(data[2].date).toBe("2026-01-15");
  });

  it("each data point has returnPct for each player", () => {
    const players = [{ id: PLAYER_A, name: "Alice", color: "#3B82F6" }];
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
    ];
    const data = getPerformanceChartData(players, trades, {}, {});
    expect(data[0]).toHaveProperty("Alice");
    expect(parseFloat(data[0]["Alice"])).toBeCloseTo(0, 1);
  });
});

// --- validateTrade ---

describe("validateTrade", () => {
  it("rejects when required fields are missing", () => {
    const result = validateTrade(
      { playerId: "", type: "buy", ticker: "AAPL", shares: 100, price: 150 },
      [],
      {}
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("fill in all fields");
  });

  it("rejects buy when player would exceed 5 positions", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 10, price: 10, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 10, price: 10, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "MSFT", shares: 10, price: 10, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "TSLA", shares: 10, price: 10, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AMZN", shares: 10, price: 10, date: "2026-01-10" }),
    ];
    const result = validateTrade(
      { playerId: PLAYER_A, type: "buy", ticker: "NVDA", shares: 10, price: 10 },
      trades,
      {}
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("5 open positions");
  });

  it("allows buy into existing position even at 5 positions", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 10, price: 10, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 10, price: 10, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "MSFT", shares: 10, price: 10, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "TSLA", shares: 10, price: 10, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AMZN", shares: 10, price: 10, date: "2026-01-10" }),
    ];
    const result = validateTrade(
      { playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 10, price: 10 },
      trades,
      {}
    );
    expect(result.valid).toBe(true);
  });

  it("rejects buy when insufficient cash", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 500, price: 190, date: "2026-01-10" }),
    ];
    // Cash remaining = 100000 - 95000 = 5000
    const result = validateTrade(
      { playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 100, price: 100 },
      trades,
      {}
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Insufficient cash");
  });

  it("rejects sell when player has insufficient shares", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 50, price: 100, date: "2026-01-10" }),
    ];
    const result = validateTrade(
      { playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 150 },
      trades,
      {}
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Cannot sell more shares");
  });

  it("accepts valid buy trade", () => {
    const result = validateTrade(
      { playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150 },
      [],
      {}
    );
    expect(result.valid).toBe(true);
  });

  it("accepts valid sell trade", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 100, date: "2026-01-10" }),
    ];
    const result = validateTrade(
      { playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 50, price: 150 },
      trades,
      {}
    );
    expect(result.valid).toBe(true);
  });
});

// --- Formatters ---

describe("formatCurrency", () => {
  it("formats positive values as USD currency", () => {
    expect(formatCurrency(1234.56)).toBe("$1,234.56");
  });

  it("formats negative values with minus sign", () => {
    const result = formatCurrency(-500);
    expect(result).toContain("500.00");
    expect(result).toMatch(/-/);
  });

  it("formats zero", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });
});

describe("formatPercent", () => {
  it("formats positive values with + prefix", () => {
    expect(formatPercent(12.345)).toBe("+12.35%");
  });

  it("formats negative values with - prefix", () => {
    expect(formatPercent(-5.5)).toBe("-5.50%");
  });

  it("formats zero with + prefix", () => {
    expect(formatPercent(0)).toBe("+0.00%");
  });
});

// --- getLastSaleProceeds ---

describe("getLastSaleProceeds", () => {
  it("returns null when no trades exist", () => {
    expect(getLastSaleProceeds(PLAYER_A, [])).toBeNull();
  });

  it("returns null when last trade was a buy", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }),
    ];
    expect(getLastSaleProceeds(PLAYER_A, trades)).toBeNull();
  });

  it("returns proceeds when last trade was a sell", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 160, date: "2026-01-20" }),
    ];
    expect(getLastSaleProceeds(PLAYER_A, trades)).toBe(16000);
  });

  it("ignores other players' trades", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-10" }),
      makeTrade({ playerId: PLAYER_B, type: "sell", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-20" }),
    ];
    expect(getLastSaleProceeds(PLAYER_A, trades)).toBeNull();
  });

  it("uses the most recent trade by timestamp", () => {
    const trades = [
      makeTrade({ playerId: PLAYER_A, type: "sell", ticker: "AAPL", shares: 100, price: 160, date: "2026-01-15" }),
      makeTrade({ playerId: PLAYER_A, type: "buy", ticker: "GOOG", shares: 50, price: 200, date: "2026-01-20" }),
    ];
    expect(getLastSaleProceeds(PLAYER_A, trades)).toBeNull();
  });
});

describe("getPriceStaleness", () => {
  const today = new Date().toISOString().split("T")[0];

  it("returns not stale when no tickers in currentPrices", () => {
    const result = getPriceStaleness({}, {});
    expect(result.stale).toBe(false);
    expect(result.daysOld).toBe(0);
  });

  it("returns stale when a ticker has no priceHistory", () => {
    const result = getPriceStaleness({ AAPL: 150 }, {});
    expect(result.stale).toBe(true);
    expect(result.daysOld).toBe(Infinity);
  });

  it("returns not stale when all tickers have recent priceHistory", () => {
    const result = getPriceStaleness(
      { AAPL: 150, GOOG: 2800 },
      { AAPL: { [today]: 150 }, GOOG: { [today]: 2800 } }
    );
    expect(result.stale).toBe(false);
    expect(result.daysOld).toBe(0);
  });

  it("returns stale based on the OLDEST ticker's latest date", () => {
    const result = getPriceStaleness(
      { AAPL: 150, GOOG: 2800, WW: 5 },
      {
        AAPL: { [today]: 150 },
        GOOG: { [today]: 2800 },
        WW: { "2026-01-22": 5 },  // stale closed position
      }
    );
    expect(result.stale).toBe(true);
    expect(result.latestDate).toBe("2026-01-22");
  });

  it("with openTickers filter: ignores stale closed-position tickers", () => {
    const result = getPriceStaleness(
      { AAPL: 150, GOOG: 2800, WW: 5 },
      {
        AAPL: { [today]: 150 },
        GOOG: { [today]: 2800 },
        WW: { "2026-01-22": 5 },  // stale but not in open positions
      },
      ["AAPL", "GOOG"]  // only check open positions
    );
    expect(result.stale).toBe(false);
    expect(result.daysOld).toBe(0);
  });

  it("with openTickers filter: returns not stale for empty tickers list", () => {
    const result = getPriceStaleness(
      { WW: 5 },
      { WW: { "2026-01-22": 5 } },
      []  // no open positions
    );
    expect(result.stale).toBe(false);
    expect(result.daysOld).toBe(0);
  });

  it("without openTickers: backward-compatible, checks all currentPrices", () => {
    const result = getPriceStaleness(
      { AAPL: 150, WW: 5 },
      {
        AAPL: { [today]: 150 },
        WW: { "2026-01-22": 5 },
      }
    );
    // Without filter, WW drags it to stale
    expect(result.stale).toBe(true);
    expect(result.latestDate).toBe("2026-01-22");
  });
});
