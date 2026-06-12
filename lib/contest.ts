import { addDays, localToday } from "./dates";

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
  realizedLosses: number;
  unrealizedGains: number;
  positions: Position[];
  closedTrades: ClosedTrade[];
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  bestTrade: ClosedTrade | null;
  worstTrade: ClosedTrade | null;
  totalTrades: number;
  sharpeRatio: number | null;
}

export type LeaderboardEntry = Player & PlayerStats;

export interface DailyValuePoint {
  date: string;
  value: number;
}

// --- Constants ---

export const COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];
export const STARTING_CASH = 100000;
export const DEFAULT_POSITION_SIZE = 20000;
export const BENCHMARK_KEY = "__BENCHMARK_SPY";
export const DEFAULT_CONTEST_START_DATE = "2026-01-01";

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
  currentPrices: Record<string, number>,
  priceHistory?: Record<string, Record<string, number>>,
  contestStartDate?: string
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

  const realizedLosses = closedTrades
    .filter((t) => t.gain < 0)
    .reduce((sum, t) => sum + t.gain, 0);

  const sharpeRatio =
    priceHistory && contestStartDate
      ? getPlayerSharpeRatio(playerId, trades, priceHistory, contestStartDate)
      : null;

  return {
    cashRemaining,
    portfolioValue,
    totalValue,
    totalReturn,
    returnPct,
    realizedGains,
    realizedLosses,
    unrealizedGains,
    positions,
    closedTrades,
    winningTrades,
    losingTrades,
    winRate,
    bestTrade,
    worstTrade,
    totalTrades: playerTrades.length,
    sharpeRatio,
  };
}

export function getLeaderboard(
  players: Player[],
  trades: Trade[],
  currentPrices: Record<string, number>,
  priceHistory?: Record<string, Record<string, number>>,
  contestStartDate?: string
): LeaderboardEntry[] {
  return players
    .map((player) => {
      const stats = getPlayerStats(
        player.id,
        trades,
        currentPrices,
        priceHistory,
        contestStartDate
      );
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

// Daily time series of a player's total portfolio value (cash + positions
// at historical prices). One point per date that appears in the player's
// trades or anywhere in priceHistory, restricted to [contestStartDate,
// today]. This is the single source for every series-derived statistic
// (Sharpe, drawdown, volatility, Sortino, alpha/beta).
// Per-ticker gaps carry the nearest PRIOR price forward (no interpolation).
export function buildDailyValueSeries(
  playerId: string,
  trades: Trade[],
  priceHistory: Record<string, Record<string, number>>,
  contestStartDate: string,
  today?: string
): DailyValuePoint[] {
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

// Annualized Sharpe ratio computed from the daily time series of total
// portfolio value. Because players have no cash flows after the initial
// STARTING_CASH deposit, day-over-day portfolio-value returns are a clean
// measure of investment performance. Returns null if fewer than 2 usable
// daily returns exist or stdev is 0.
export function getPlayerSharpeRatio(
  playerId: string,
  trades: Trade[],
  priceHistory: Record<string, Record<string, number>>,
  contestStartDate: string,
  options?: { annualRiskFreeRate?: number; today?: string }
): number | null {
  const annualRF = options?.annualRiskFreeRate ?? 0;
  const dailyRF = annualRF / 252;

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
  if (excessReturns.length < 2) return null;

  const mean =
    excessReturns.reduce((sum, r) => sum + r, 0) / excessReturns.length;
  const variance =
    excessReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    (excessReturns.length - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return null;

  return (mean / stdev) * Math.sqrt(252);
}

export interface AdvancedStats {
  maxDrawdownPct: number | null;        // peak-to-trough, negative %
  maxDrawdownPeakDate: string | null;
  maxDrawdownTroughDate: string | null;
  annualizedVolatilityPct: number | null;
  sortino: number | null;
  beta: number | null;                  // vs __BENCHMARK_SPY daily returns
  alphaAnnualizedPct: number | null;    // Jensen's alpha: annualized OLS intercept on excess returns, in %
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
    let worstPeak: DailyValuePoint | null = null;
    let worstTrough: DailyValuePoint | null = null;
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

  // --- Daily returns between consecutive series points. NOTE: consecutive
  // points may span calendar gaps, and a ticker missing a date carries its
  // prior price forward — both smooth the series slightly (volatility is a
  // floor, beta attenuates toward 0 when player tickers lag the benchmark
  // calendar). Acceptable for contest stats; never interpolated.
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
    // ≥2 downside obs: a single losing day makes downside deviation pure noise.
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
      playerR.push((aligned[i].value - prevP) / prevP - dailyRF);
      benchR.push((curB - prevB) / prevB - dailyRF);
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

export function getPerformanceChartData(
  players: Player[],
  trades: Trade[],
  currentPrices: Record<string, number>,
  priceHistory: Record<string, Record<string, number>>,
  today?: string,
  contestStartDate?: string,
  benchmarkHistory?: Record<string, number>
): Record<string, string>[] {
  if (players.length === 0 || trades.length === 0) return [];

  const resolvedToday = today || localToday();
  const resolvedStart = contestStartDate || "2026-01-01";

  const dateSet = new Set<string>(trades.map((t) => t.date));
  Object.values(priceHistory).forEach((tickerHistory) => {
    Object.keys(tickerHistory).forEach((date) => dateSet.add(date));
  });

  if (Object.keys(currentPrices).length > 0) {
    dateSet.add(resolvedToday);
  }

  const allDates = [...dateSet]
    .sort()
    .filter((d) => !contestStartDate || d >= contestStartDate);

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

    // Add S&P 500 benchmark return if data available
    if (benchmarkHistory) {
      const benchmarkReturn = getBenchmarkReturnAtDate(
        date,
        benchmarkHistory,
        resolvedStart
      );
      if (benchmarkReturn !== null) {
        dataPoint["S&P 500"] = benchmarkReturn.toFixed(2);
      }
    }

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

// --- Period Returns ---

export type Period = "1D" | "1W" | "1M" | "YTD" | "ALL";

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

export function getPeriodReturn(
  playerId: string,
  period: Period,
  trades: Trade[],
  currentPrices: Record<string, number>,
  priceHistory: Record<string, Record<string, number>>,
  contestStartDate: string,
  today?: string
): { returnPct: number; returnDollar: number } {
  const stats = getPlayerStats(playerId, trades, currentPrices);
  const currentValue = stats.totalValue;

  if (period === "ALL") {
    return {
      returnDollar: currentValue - STARTING_CASH,
      returnPct: ((currentValue - STARTING_CASH) / STARTING_CASH) * 100,
    };
  }

  const startDate = getPeriodStartDate(period, contestStartDate, today);
  const previousValue = getPlayerValueAtDate(
    playerId,
    startDate,
    trades,
    priceHistory
  );

  if (previousValue === 0) {
    return { returnDollar: 0, returnPct: 0 };
  }

  return {
    returnDollar: currentValue - previousValue,
    returnPct: ((currentValue - previousValue) / previousValue) * 100,
  };
}

// --- Position Enrichment ---

export function getPositionDailyChange(
  ticker: string,
  currentPrice: number,
  priceHistory: Record<string, Record<string, number>>,
  today?: string
): { changeDollar: number; changePct: number } | null {
  const history = priceHistory[ticker];
  if (!history) return null;

  // Refresh writes each bar under its real session date (today only when the
  // bar IS today's), so excluding entries >= today reliably yields the prior
  // session's close.
  const resolvedToday = today || localToday();
  const previousDates = Object.keys(history)
    .filter((d) => d < resolvedToday)
    .sort();
  if (previousDates.length === 0) return null;

  const previousDate = previousDates[previousDates.length - 1];
  const previousPrice = history[previousDate];
  if (!previousPrice || previousPrice === 0) return null;

  // Suppress "today" when the most recent prior close is more than 4 calendar
  // days old. 4 covers a normal Mon-after-weekend gap (Fri->Mon = 3) plus a
  // long-weekend holiday (Fri->Tue = 4). Anything older is almost always a
  // data gap rather than a real 1-day move.
  const todayMs = new Date(resolvedToday + "T00:00:00Z").getTime();
  const prevMs = new Date(previousDate + "T00:00:00Z").getTime();
  if (Math.round((todayMs - prevMs) / 86400000) > 4) return null;

  return {
    changeDollar: currentPrice - previousPrice,
    changePct: ((currentPrice - previousPrice) / previousPrice) * 100,
  };
}

export function getPositionDaysHeld(position: Position, today?: string): number {
  const buyTrades = position.trades.filter((t) => t.type === "buy");
  if (buyTrades.length === 0) return 0;

  const earliest = buyTrades.reduce((min, t) =>
    t.date < min.date ? t : min
  );

  // Use UTC to avoid DST issues
  const todayDate = today ? new Date(today + "T00:00:00Z") : new Date();
  const buyDate = new Date(earliest.date + "T00:00:00Z");
  return Math.round((todayDate.getTime() - buyDate.getTime()) / 86400000);
}

// --- Benchmark ---

export function getBenchmarkReturnAtDate(
  date: string,
  benchmarkHistory: Record<string, number>,
  contestStartDate: string
): number | null {
  const startPrice = getPriceAtDate(
    BENCHMARK_KEY,
    contestStartDate,
    { [BENCHMARK_KEY]: benchmarkHistory }
  );
  const datePrice = getPriceAtDate(
    BENCHMARK_KEY,
    date,
    { [BENCHMARK_KEY]: benchmarkHistory }
  );

  if (!startPrice || !datePrice) return null;
  return ((datePrice - startPrice) / startPrice) * 100;
}

// --- Price Staleness ---

export function getPriceStaleness(
  currentPrices: Record<string, number>,
  priceHistory: Record<string, Record<string, number>>,
  openTickers?: string[]
): { stale: boolean; latestDate: string | null; daysOld: number } {
  const tickers = openTickers ?? Object.keys(currentPrices);
  if (tickers.length === 0) return { stale: false, latestDate: null, daysOld: 0 };

  let oldestLatest: string | null = null;

  for (const ticker of tickers) {
    const history = priceHistory[ticker];
    if (!history || Object.keys(history).length === 0) {
      return { stale: true, latestDate: null, daysOld: Infinity };
    }
    const dates = Object.keys(history).sort();
    const latest = dates[dates.length - 1];
    if (!oldestLatest || latest < oldestLatest) {
      oldestLatest = latest;
    }
  }

  if (!oldestLatest) return { stale: true, latestDate: null, daysOld: Infinity };

  const daysOld = Math.floor(
    (Date.parse(localToday() + "T00:00:00Z") - Date.parse(oldestLatest + "T00:00:00Z")) / 86400000
  );

  // Stale if more than 1 calendar day old (allows for weekends: Friday prices on Saturday are OK)
  return { stale: daysOld > 1, latestDate: oldestLatest, daysOld };
}
