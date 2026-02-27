// --- Types ---

export interface Player {
  id: string;
  name: string;
  color: string;
}

export interface Trade {
  id: string;
  playerId: string;
  type: "buy" | "sell";
  ticker: string;
  shares: number;
  price: number;
  date: string;
  timestamp: number;
}

export interface Position {
  ticker: string;
  shares: number;
  avgCost: number;
  totalCost: number;
  trades: Trade[];
}

export interface TradeForm {
  playerId: string;
  type: "buy" | "sell";
  ticker: string;
  shares: string;
  price: string;
  date: string;
}

export interface ClosedTrade {
  ticker: string;
  shares: number;
  costBasis: number;
  proceeds: number;
  gain: number;
  gainPct: number;
}

export interface PlayerStats {
  cashRemaining: number;
  portfolioValue: number;
  totalValue: number;
  totalReturn: number;
  returnPct: number;
  realizedGains: number;
  unrealizedGains: number;
  positions: Position[];
  closedTrades: ClosedTrade[];
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  bestTrade: ClosedTrade | null;
  worstTrade: ClosedTrade | null;
  totalTrades: number;
}

export type LeaderboardEntry = Player & PlayerStats;

// --- Constants ---

export const COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];
export const STARTING_CASH = 100000;
export const DEFAULT_POSITION_SIZE = 20000;

// --- Position Logic ---

export function getPlayerPositions(
  playerId: string,
  trades: Trade[]
): Position[] {
  const playerTrades = trades
    .filter((t) => t.playerId === playerId)
    .sort((a, b) => a.timestamp - b.timestamp);
  const positions: Record<
    string,
    { buyLots: Array<{ shares: number; price: number }>; trades: Trade[] }
  > = {};

  playerTrades.forEach((trade) => {
    if (!positions[trade.ticker]) {
      positions[trade.ticker] = { buyLots: [], trades: [] };
    }

    if (trade.type === "buy") {
      positions[trade.ticker].buyLots.push({
        shares: trade.shares,
        price: trade.price,
      });
    } else {
      let sharesToSell = trade.shares;
      while (
        sharesToSell > 0 &&
        positions[trade.ticker].buyLots.length > 0
      ) {
        const oldestLot = positions[trade.ticker].buyLots[0];
        const sharesToUse = Math.min(sharesToSell, oldestLot.shares);
        sharesToSell -= sharesToUse;
        oldestLot.shares -= sharesToUse;
        if (oldestLot.shares === 0) {
          positions[trade.ticker].buyLots.shift();
        }
      }
    }
    positions[trade.ticker].trades.push(trade);
  });

  return Object.entries(positions)
    .filter(([, pos]) => pos.buyLots.length > 0)
    .map(([ticker, pos]) => {
      const shares = pos.buyLots.reduce((sum, lot) => sum + lot.shares, 0);
      const totalCost = pos.buyLots.reduce(
        (sum, lot) => sum + lot.shares * lot.price,
        0
      );
      return {
        ticker,
        shares,
        avgCost: totalCost / shares,
        totalCost,
        trades: pos.trades,
      };
    });
}

export function getOpenPositionCount(
  playerId: string,
  trades: Trade[]
): number {
  return getPlayerPositions(playerId, trades).length;
}

export function canAddPosition(
  playerId: string,
  ticker: string,
  trades: Trade[]
): boolean {
  const positions = getPlayerPositions(playerId, trades);
  const existingPosition = positions.find(
    (p) => p.ticker === ticker.toUpperCase()
  );
  if (existingPosition) return true;
  return positions.length < 5;
}

// --- Price Logic ---

export function getLatestTradePrice(
  ticker: string,
  trades: Trade[]
): number | null {
  const tickerTrades = trades
    .filter((t) => t.ticker === ticker)
    .sort((a, b) => b.timestamp - a.timestamp);
  return tickerTrades.length > 0 ? tickerTrades[0].price : null;
}

export function getCurrentPrice(
  ticker: string,
  currentPrices: Record<string, number>,
  trades: Trade[]
): number {
  return currentPrices[ticker] || getLatestTradePrice(ticker, trades) || 0;
}

export function getLastSaleProceeds(
  playerId: string,
  trades: Trade[]
): number | null {
  const playerTrades = trades
    .filter((t) => t.playerId === playerId)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (playerTrades.length === 0) return null;

  const lastTrade = playerTrades[0];
  if (lastTrade.type !== "sell") return null;

  return lastTrade.shares * lastTrade.price;
}

export function getPriceAtDate(
  ticker: string,
  date: string,
  priceHistory: Record<string, Record<string, number>>
): number | null {
  const history = priceHistory[ticker];
  if (!history) return null;

  if (history[date]) return history[date];

  const dates = Object.keys(history).sort();
  let bestDate: string | null = null;
  for (const d of dates) {
    if (d <= date) bestDate = d;
    else break;
  }
  return bestDate ? history[bestDate] : null;
}

// --- Stats ---

export function getPlayerStats(
  playerId: string,
  trades: Trade[],
  currentPrices: Record<string, number>
): PlayerStats {
  const playerTrades = trades.filter((t) => t.playerId === playerId);
  const positions = getPlayerPositions(playerId, trades);

  let realizedGains = 0;
  const closedTrades: ClosedTrade[] = [];

  const tickerHistory: Record<
    string,
    { buys: Array<{ shares: number; price: number }>; totalShares: number }
  > = {};

  playerTrades
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach((trade) => {
      if (!tickerHistory[trade.ticker]) {
        tickerHistory[trade.ticker] = { buys: [], totalShares: 0 };
      }

      if (trade.type === "buy") {
        tickerHistory[trade.ticker].buys.push({
          shares: trade.shares,
          price: trade.price,
        });
        tickerHistory[trade.ticker].totalShares += trade.shares;
      } else {
        let sharesToSell = trade.shares;
        let costBasis = 0;

        while (
          sharesToSell > 0 &&
          tickerHistory[trade.ticker].buys.length > 0
        ) {
          const oldestBuy = tickerHistory[trade.ticker].buys[0];
          const sharesToUse = Math.min(sharesToSell, oldestBuy.shares);

          costBasis += sharesToUse * oldestBuy.price;
          sharesToSell -= sharesToUse;
          oldestBuy.shares -= sharesToUse;

          if (oldestBuy.shares === 0) {
            tickerHistory[trade.ticker].buys.shift();
          }
        }

        const proceeds = trade.shares * trade.price;
        realizedGains += proceeds - costBasis;
        tickerHistory[trade.ticker].totalShares -= trade.shares;

        closedTrades.push({
          ticker: trade.ticker,
          shares: trade.shares,
          costBasis,
          proceeds,
          gain: proceeds - costBasis,
          gainPct: ((proceeds - costBasis) / costBasis) * 100,
        });
      }
    });

  let portfolioValue = 0;
  let unrealizedGains = 0;

  positions.forEach((pos) => {
    const price = getCurrentPrice(pos.ticker, currentPrices, trades);
    const currentValue = pos.shares * price;
    portfolioValue += currentValue;
    unrealizedGains += currentValue - pos.totalCost;
  });

  let cashSpent = 0;
  let cashReceived = 0;
  playerTrades.forEach((trade) => {
    if (trade.type === "buy") {
      cashSpent += trade.shares * trade.price;
    } else {
      cashReceived += trade.shares * trade.price;
    }
  });

  const cashRemaining = STARTING_CASH - cashSpent + cashReceived;
  const totalValue = cashRemaining + portfolioValue;
  const totalReturn = totalValue - STARTING_CASH;
  const returnPct = (totalReturn / STARTING_CASH) * 100;

  const winningTrades = closedTrades.filter((t) => t.gain > 0).length;
  const losingTrades = closedTrades.filter((t) => t.gain < 0).length;
  const winRate =
    closedTrades.length > 0
      ? (winningTrades / closedTrades.length) * 100
      : 0;

  const bestTrade =
    closedTrades.length > 0
      ? closedTrades.reduce((best, t) =>
          t.gainPct > best.gainPct ? t : best
        )
      : null;
  const worstTrade =
    closedTrades.length > 0
      ? closedTrades.reduce((worst, t) =>
          t.gainPct < worst.gainPct ? t : worst
        )
      : null;

  return {
    cashRemaining,
    portfolioValue,
    totalValue,
    totalReturn,
    returnPct,
    realizedGains,
    unrealizedGains,
    positions,
    closedTrades,
    winningTrades,
    losingTrades,
    winRate,
    bestTrade,
    worstTrade,
    totalTrades: playerTrades.length,
  };
}

export function getLeaderboard(
  players: Player[],
  trades: Trade[],
  currentPrices: Record<string, number>
): LeaderboardEntry[] {
  return players
    .map((player) => {
      const stats = getPlayerStats(player.id, trades, currentPrices);
      return { ...player, ...stats };
    })
    .sort((a, b) => b.returnPct - a.returnPct);
}

// --- Historical Value ---

export function getPlayerValueAtDate(
  playerId: string,
  asOfDate: string,
  trades: Trade[],
  priceHistory: Record<string, Record<string, number>>
): number {
  const playerTrades = trades.filter(
    (t) => t.playerId === playerId && t.date <= asOfDate
  );

  const positions: Record<string, number> = {};
  let cashSpent = 0;
  let cashReceived = 0;
  const lastTradePrice: Record<string, number> = {};

  playerTrades
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach((trade) => {
      lastTradePrice[trade.ticker] = trade.price;
      if (!positions[trade.ticker]) positions[trade.ticker] = 0;

      if (trade.type === "buy") {
        positions[trade.ticker] += trade.shares;
        cashSpent += trade.shares * trade.price;
      } else {
        positions[trade.ticker] -= trade.shares;
        cashReceived += trade.shares * trade.price;
      }
    });

  let portfolioValue = 0;
  Object.entries(positions).forEach(([ticker, shares]) => {
    if (shares > 0) {
      const price =
        getPriceAtDate(ticker, asOfDate, priceHistory) ||
        lastTradePrice[ticker] ||
        0;
      portfolioValue += shares * price;
    }
  });

  const cashRemaining = STARTING_CASH - cashSpent + cashReceived;
  return cashRemaining + portfolioValue;
}

export function getPerformanceChartData(
  players: Player[],
  trades: Trade[],
  currentPrices: Record<string, number>,
  priceHistory: Record<string, Record<string, number>>,
  today?: string
): Record<string, string>[] {
  if (players.length === 0 || trades.length === 0) return [];

  const resolvedToday = today || new Date().toISOString().split("T")[0];

  const dateSet = new Set<string>(trades.map((t) => t.date));
  Object.values(priceHistory).forEach((tickerHistory) => {
    Object.keys(tickerHistory).forEach((date) => dateSet.add(date));
  });

  if (Object.keys(currentPrices).length > 0) {
    dateSet.add(resolvedToday);
  }

  const allDates = [...dateSet].sort();

  return allDates.map((date) => {
    const dataPoint: Record<string, string> = { date };

    players.forEach((player) => {
      let totalValue: number;

      if (date === resolvedToday && Object.keys(currentPrices).length > 0) {
        const stats = getPlayerStats(player.id, trades, currentPrices);
        totalValue = stats.totalValue;
      } else {
        totalValue = getPlayerValueAtDate(player.id, date, trades, priceHistory);
      }

      const returnPct =
        ((totalValue - STARTING_CASH) / STARTING_CASH) * 100;
      dataPoint[player.name] = returnPct.toFixed(2);
    });

    return dataPoint;
  });
}

// --- Formatting ---

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

// --- Trade Validation ---

export interface TradeValidationResult {
  valid: boolean;
  error?: string;
}

export function validateTrade(
  trade: {
    playerId: string;
    type: "buy" | "sell";
    ticker: string;
    shares: number;
    price: number;
  },
  trades: Trade[],
  currentPrices: Record<string, number>
): TradeValidationResult {
  if (!trade.playerId || !trade.ticker || !trade.shares || !trade.price) {
    return { valid: false, error: "Please fill in all fields" };
  }

  const ticker = trade.ticker.toUpperCase();

  if (trade.type === "buy") {
    if (!canAddPosition(trade.playerId, ticker, trades)) {
      return {
        valid: false,
        error:
          "This player already has 5 open positions. Close a position before opening a new one.",
      };
    }

    const tradeCost = trade.shares * trade.price;
    const stats = getPlayerStats(trade.playerId, trades, currentPrices);
    if (tradeCost > stats.cashRemaining) {
      return {
        valid: false,
        error: `Insufficient cash. Available: ${formatCurrency(stats.cashRemaining)}, Trade cost: ${formatCurrency(tradeCost)}`,
      };
    }
  }

  if (trade.type === "sell") {
    const positions = getPlayerPositions(trade.playerId, trades);
    const position = positions.find((p) => p.ticker === ticker);
    if (!position || position.shares < trade.shares) {
      return { valid: false, error: "Cannot sell more shares than owned" };
    }
  }

  return { valid: true };
}
