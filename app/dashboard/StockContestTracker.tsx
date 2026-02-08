"use client";

import React, { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// --- Types ---

interface Player {
  id: string;
  name: string;
  color: string;
}

interface Trade {
  id: string;
  playerId: string;
  type: "buy" | "sell";
  ticker: string;
  shares: number;
  price: number;
  date: string;
  timestamp: number;
}

interface Position {
  ticker: string;
  shares: number;
  avgCost: number;
  totalCost: number;
  trades: Trade[];
}

interface TradeForm {
  playerId: string;
  type: "buy" | "sell";
  ticker: string;
  shares: string;
  price: string;
  date: string;
}

interface ClosedTrade {
  ticker: string;
  shares: number;
  costBasis: number;
  proceeds: number;
  gain: number;
  gainPct: number;
}

interface PlayerStats {
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

type LeaderboardEntry = Player & PlayerStats;

// --- Constants ---

const COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];
const STARTING_CASH = 100000;
const DEFAULT_POSITION_SIZE = 20000;

// --- Component ---

export default function StockContestTracker() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showAddTrade, setShowAddTrade] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [contestStartDate, setContestStartDate] = useState("2026-01-01");
  const [editingPlayer, setEditingPlayer] = useState<string | null>(null);
  const [fetchingPrice, setFetchingPrice] = useState(false);
  const [priceError, setPriceError] = useState("");
  const [polygonApiKey, setPolygonApiKey] = useState("");
  const [currentPrices, setCurrentPrices] = useState<Record<string, number>>(
    {}
  );

  const [tradeForm, setTradeForm] = useState<TradeForm>({
    playerId: "",
    type: "buy",
    ticker: "",
    shares: "",
    price: "",
    date: new Date().toISOString().split("T")[0],
  });

  // Load data from localStorage on mount
  useEffect(() => {
    const savedPlayers = localStorage.getItem("stockContest_players");
    const savedTrades = localStorage.getItem("stockContest_trades");
    const savedStartDate = localStorage.getItem("stockContest_startDate");
    const savedApiKey = localStorage.getItem("stockContest_polygonApiKey");
    const savedPrices = localStorage.getItem("stockContest_currentPrices");

    if (savedPlayers) setPlayers(JSON.parse(savedPlayers));
    if (savedTrades) setTrades(JSON.parse(savedTrades));
    if (savedStartDate) setContestStartDate(savedStartDate);
    if (savedApiKey) setPolygonApiKey(savedApiKey);
    if (savedPrices) setCurrentPrices(JSON.parse(savedPrices));
  }, []);

  // Save data to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem("stockContest_players", JSON.stringify(players));
  }, [players]);

  useEffect(() => {
    localStorage.setItem("stockContest_trades", JSON.stringify(trades));
  }, [trades]);

  useEffect(() => {
    localStorage.setItem("stockContest_startDate", contestStartDate);
  }, [contestStartDate]);

  useEffect(() => {
    if (polygonApiKey) {
      localStorage.setItem("stockContest_polygonApiKey", polygonApiKey);
    }
  }, [polygonApiKey]);

  useEffect(() => {
    localStorage.setItem(
      "stockContest_currentPrices",
      JSON.stringify(currentPrices)
    );
  }, [currentPrices]);

  // --- Player Logic ---

  const addPlayer = () => {
    if (newPlayerName.trim()) {
      const newPlayer: Player = {
        id: Date.now().toString(),
        name: newPlayerName.trim(),
        color: COLORS[players.length % COLORS.length],
      };
      setPlayers([...players, newPlayer]);
      setNewPlayerName("");
      setShowAddPlayer(false);
    }
  };

  const updatePlayerName = (id: string, newName: string) => {
    setPlayers(
      players.map((p) => (p.id === id ? { ...p, name: newName } : p))
    );
    setEditingPlayer(null);
  };

  const deletePlayer = (id: string) => {
    if (window.confirm("Delete this player and all their trades?")) {
      setPlayers(players.filter((p) => p.id !== id));
      setTrades(trades.filter((t) => t.playerId !== id));
    }
  };

  // --- Position Logic ---

  const getPlayerPositions = (playerId: string): Position[] => {
    const playerTrades = trades.filter((t) => t.playerId === playerId);
    const positions: Record<
      string,
      { shares: number; totalCost: number; trades: Trade[] }
    > = {};

    playerTrades.forEach((trade) => {
      if (!positions[trade.ticker]) {
        positions[trade.ticker] = { shares: 0, totalCost: 0, trades: [] };
      }

      if (trade.type === "buy") {
        positions[trade.ticker].shares += trade.shares;
        positions[trade.ticker].totalCost += trade.shares * trade.price;
      } else {
        positions[trade.ticker].shares -= trade.shares;
        positions[trade.ticker].totalCost -= trade.shares * trade.price;
      }
      positions[trade.ticker].trades.push(trade);
    });

    return Object.entries(positions)
      .filter(([, pos]) => pos.shares > 0)
      .map(([ticker, pos]) => ({
        ticker,
        shares: pos.shares,
        avgCost: pos.totalCost / pos.shares,
        totalCost: pos.totalCost,
        trades: pos.trades,
      }));
  };

  const getOpenPositionCount = (playerId: string): number => {
    return getPlayerPositions(playerId).length;
  };

  const canAddPosition = (playerId: string, ticker: string): boolean => {
    const positions = getPlayerPositions(playerId);
    const existingPosition = positions.find(
      (p) => p.ticker === ticker.toUpperCase()
    );
    if (existingPosition) return true;
    return positions.length < 5;
  };

  // --- Price Logic ---

  const getLatestTradePrice = (ticker: string): number | null => {
    const tickerTrades = trades
      .filter((t) => t.ticker === ticker)
      .sort((a, b) => b.timestamp - a.timestamp);
    return tickerTrades.length > 0 ? tickerTrades[0].price : null;
  };

  const getCurrentPrice = (ticker: string): number => {
    return currentPrices[ticker] || getLatestTradePrice(ticker) || 0;
  };

  // Fetch with CORS proxy wrapper
  const fetchWithProxy = async (
    url: string
  ): Promise<{
    ok: boolean;
    data: Record<string, unknown> | null;
    raw?: string;
    error?: string;
  }> => {
    const proxies = [
      (u: string) =>
        `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    ];

    for (const makeProxyUrl of proxies) {
      try {
        const proxyUrl = makeProxyUrl(url);
        const response = await fetch(proxyUrl, {
          signal: AbortSignal.timeout(10000),
        });
        const text = await response.text();

        if (text) {
          try {
            const data = JSON.parse(text);
            return { ok: true, data, raw: text };
          } catch {
            return {
              ok: false,
              data: null,
              raw: text,
              error: "Invalid JSON response",
            };
          }
        }
      } catch {
        continue;
      }
    }
    return { ok: false, data: null, error: "All proxies failed" };
  };

  const fetchStockPrice = async (
    ticker: string,
    date: string | null = null
  ): Promise<number | null> => {
    if (!polygonApiKey) {
      setPriceError("Please add your API key in Settings first");
      return null;
    }

    setFetchingPrice(true);
    setPriceError("");

    const targetDate = date || tradeForm.date;
    const today = new Date().toISOString().split("T")[0];
    const isHistorical = targetDate < today;
    const upperTicker = ticker.toUpperCase();

    try {
      let price: number | null = null;
      let actualDate = targetDate;
      let lastApiResponse: Record<string, unknown> | null = null;

      if (isHistorical) {
        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
          const checkDate = new Date(targetDate);
          checkDate.setDate(checkDate.getDate() + dayOffset);
          const dateStr = checkDate.toISOString().split("T")[0];

          const url = `https://api.polygon.io/v1/open-close/${upperTicker}/${dateStr}?adjusted=true&apiKey=${polygonApiKey}`;
          const result = await fetchWithProxy(url);
          lastApiResponse = result.data;

          if (result.ok && result.data) {
            if (result.data.error) {
              setPriceError(`API Error: ${result.data.error}`);
              return null;
            }

            if (
              result.data.status === "OK" &&
              typeof result.data.open === "number"
            ) {
              price = result.data.open;
              actualDate = dateStr;
              break;
            } else if (
              result.data.status === "NOT_FOUND" ||
              result.data.status === "ERROR"
            ) {
              continue;
            }
          }
        }
      } else {
        const url = `https://api.polygon.io/v2/aggs/ticker/${upperTicker}/prev?adjusted=true&apiKey=${polygonApiKey}`;
        const result = await fetchWithProxy(url);
        lastApiResponse = result.data;

        if (result.ok && result.data) {
          if (result.data.error) {
            setPriceError(`API Error: ${result.data.error}`);
            return null;
          }

          const results = result.data.results as
            | Array<{ c: number }>
            | undefined;
          if (results && results[0]) {
            price = results[0].c;
          }
        }
      }

      if (price) {
        if (isHistorical && actualDate !== targetDate) {
          setPriceError(
            `Market closed ${targetDate}. Using ${actualDate} open.`
          );
        }
        setTradeForm((prev) => ({ ...prev, price: price!.toFixed(2) }));
        return price;
      } else {
        if (lastApiResponse) {
          if (lastApiResponse.message) {
            setPriceError(`API: ${lastApiResponse.message}`);
          } else if (lastApiResponse.status) {
            setPriceError(
              `API returned status: ${lastApiResponse.status}. Try AAPL to test.`
            );
          } else {
            setPriceError(
              `No price data for ${upperTicker}. Response: ${JSON.stringify(lastApiResponse).substring(0, 100)}`
            );
          }
        } else {
          setPriceError(
            `Could not reach API for ${upperTicker}. Check console for details.`
          );
        }
        return null;
      }
    } catch (err) {
      setPriceError(`Error: ${err instanceof Error ? err.message : err}`);
      return null;
    } finally {
      setFetchingPrice(false);
    }
  };

  const fetchPriceAndCalculateShares = async () => {
    if (!tradeForm.ticker) {
      setPriceError("Enter a ticker symbol first");
      return;
    }

    const price = await fetchStockPrice(tradeForm.ticker);
    if (price) {
      const shares = Math.floor(DEFAULT_POSITION_SIZE / price);
      setTradeForm((prev) => ({ ...prev, shares: shares.toString() }));
    }
  };

  // --- Trade Logic ---

  const addTrade = () => {
    if (
      !tradeForm.playerId ||
      !tradeForm.ticker ||
      !tradeForm.shares ||
      !tradeForm.price
    ) {
      alert("Please fill in all fields");
      return;
    }

    const ticker = tradeForm.ticker.toUpperCase();

    if (tradeForm.type === "buy" && !canAddPosition(tradeForm.playerId, ticker)) {
      alert(
        "This player already has 5 open positions. Close a position before opening a new one."
      );
      return;
    }

    if (tradeForm.type === "sell") {
      const positions = getPlayerPositions(tradeForm.playerId);
      const position = positions.find((p) => p.ticker === ticker);
      if (!position || position.shares < parseFloat(tradeForm.shares)) {
        alert("Cannot sell more shares than owned");
        return;
      }
    }

    const newTrade: Trade = {
      id: Date.now().toString(),
      playerId: tradeForm.playerId,
      type: tradeForm.type,
      ticker: ticker,
      shares: parseFloat(tradeForm.shares),
      price: parseFloat(tradeForm.price),
      date: tradeForm.date,
      timestamp: new Date(tradeForm.date).getTime(),
    };

    setTrades([...trades, newTrade]);
    setTradeForm({
      playerId: tradeForm.playerId,
      type: "buy",
      ticker: "",
      shares: "",
      price: "",
      date: new Date().toISOString().split("T")[0],
    });
    setShowAddTrade(false);
  };

  const deleteTrade = (tradeId: string) => {
    if (window.confirm("Delete this trade?")) {
      setTrades(trades.filter((t) => t.id !== tradeId));
    }
  };

  // --- Stats ---

  const getPlayerStats = (playerId: string): PlayerStats => {
    const playerTrades = trades.filter((t) => t.playerId === playerId);
    const positions = getPlayerPositions(playerId);

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
      const currentPrice = getCurrentPrice(pos.ticker);
      const currentValue = pos.shares * currentPrice;
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
  };

  const getLeaderboard = (): LeaderboardEntry[] => {
    return players
      .map((player) => {
        const stats = getPlayerStats(player.id);
        return { ...player, ...stats };
      })
      .sort((a, b) => b.returnPct - a.returnPct);
  };

  const getPlayerValueAtDate = (playerId: string, asOfDate: string): number => {
    const playerTrades = trades.filter(
      (t) => t.playerId === playerId && t.date <= asOfDate
    );

    const positions: Record<string, { shares: number; totalCost: number }> = {};
    let cashSpent = 0;
    let cashReceived = 0;
    const pricesAtDate: Record<string, number> = {};

    playerTrades
      .sort((a, b) => a.timestamp - b.timestamp)
      .forEach((trade) => {
        pricesAtDate[trade.ticker] = trade.price;

        if (!positions[trade.ticker]) {
          positions[trade.ticker] = { shares: 0, totalCost: 0 };
        }

        if (trade.type === "buy") {
          positions[trade.ticker].shares += trade.shares;
          positions[trade.ticker].totalCost += trade.shares * trade.price;
          cashSpent += trade.shares * trade.price;
        } else {
          positions[trade.ticker].shares -= trade.shares;
          positions[trade.ticker].totalCost -= trade.shares * trade.price;
          cashReceived += trade.shares * trade.price;
        }
      });

    let portfolioValue = 0;
    Object.entries(positions).forEach(([ticker, pos]) => {
      if (pos.shares > 0) {
        const price = pricesAtDate[ticker] || 0;
        portfolioValue += pos.shares * price;
      }
    });

    const cashRemaining = STARTING_CASH - cashSpent + cashReceived;
    return cashRemaining + portfolioValue;
  };

  const getPerformanceChartData = () => {
    if (players.length === 0 || trades.length === 0) return [];

    const allDates = [...new Set(trades.map((t) => t.date))].sort();

    const today = new Date().toISOString().split("T")[0];
    if (Object.keys(currentPrices).length > 0 && !allDates.includes(today)) {
      allDates.push(today);
    }

    return allDates.map((date) => {
      const dataPoint: Record<string, string> = { date };

      players.forEach((player) => {
        let totalValue: number;

        if (date === today && Object.keys(currentPrices).length > 0) {
          const stats = getPlayerStats(player.id);
          totalValue = stats.totalValue;
        } else {
          totalValue = getPlayerValueAtDate(player.id, date);
        }

        const returnPct =
          ((totalValue - STARTING_CASH) / STARTING_CASH) * 100;
        dataPoint[player.name] = returnPct.toFixed(2);
      });

      return dataPoint;
    });
  };

  // --- Formatting ---

  const formatCurrency = (value: number): string => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(value);
  };

  const formatPercent = (value: number): string => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  };

  // --- Import / Export ---

  const exportData = () => {
    const data = { players, trades, contestStartDate };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stock-contest-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
  };

  const importData = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target?.result as string);
          if (data.players) setPlayers(data.players);
          if (data.trades) setTrades(data.trades);
          if (data.contestStartDate)
            setContestStartDate(data.contestStartDate);
          if (data.currentPrices) setCurrentPrices(data.currentPrices);
          alert("Data imported successfully!");
        } catch {
          alert("Error importing data. Please check the file format.");
        }
      };
      reader.readAsText(file);
    }
  };

  // --- Derived Data ---

  const leaderboard = getLeaderboard();
  const chartData = getPerformanceChartData();

  // Suppress fetchingPrice/fetchPriceAndCalculateShares unused warnings
  void fetchingPrice;
  void fetchPriceAndCalculateShares;

  // --- Render ---

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">
                Stock Picking Contest
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                Started: {new Date(contestStartDate).toLocaleDateString()}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={exportData}
                className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Export
              </button>
              <label className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer">
                Import
                <input
                  type="file"
                  accept=".json"
                  onChange={importData}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mt-4">
            {["dashboard", "trades", "players", "settings"].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeTab === tab
                    ? "bg-blue-50 text-blue-600"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Dashboard Tab */}
        {activeTab === "dashboard" && (
          <div className="space-y-6">
            {players.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                <p className="text-gray-500 mb-4">No players added yet</p>
                <button
                  onClick={() => setActiveTab("players")}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Add Players
                </button>
              </div>
            ) : (
              <>
                {/* Leaderboard */}
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100">
                    <h2 className="text-lg font-semibold text-gray-900">
                      Leaderboard
                    </h2>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {leaderboard.map((player, index) => (
                      <div
                        key={player.id}
                        className="px-6 py-4 flex items-center gap-4"
                      >
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold ${
                            index === 0
                              ? "bg-yellow-500"
                              : index === 1
                                ? "bg-gray-400"
                                : index === 2
                                  ? "bg-amber-600"
                                  : "bg-gray-300"
                          }`}
                        >
                          {index + 1}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className="w-3 h-3 rounded-full"
                              style={{ backgroundColor: player.color }}
                            />
                            <span className="font-medium text-gray-900">
                              {player.name}
                            </span>
                          </div>
                          <p className="text-sm text-gray-500 mt-0.5">
                            {player.positions.length} positions &bull;{" "}
                            {player.totalTrades} trades
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold text-gray-900">
                            {formatCurrency(player.totalValue)}
                          </p>
                          <p
                            className={`text-sm font-medium ${player.returnPct >= 0 ? "text-green-600" : "text-red-600"}`}
                          >
                            {formatPercent(player.returnPct)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Update Current Prices */}
                {(() => {
                  const allOpenTickers = [
                    ...new Set(
                      players.flatMap((p) =>
                        getPlayerPositions(p.id).map((pos) => pos.ticker)
                      )
                    ),
                  ].sort();

                  if (allOpenTickers.length === 0) return null;

                  return (
                    <div className="bg-white rounded-xl border border-gray-200 p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <h2 className="text-lg font-semibold text-gray-900">
                            Update Current Prices
                          </h2>
                          <p className="text-sm text-gray-500">
                            Enter today&apos;s prices to calculate accurate
                            returns
                          </p>
                        </div>
                        <button
                          onClick={() => {
                            const url = `https://finance.yahoo.com/quotes/${allOpenTickers.join(",")}/view/v1`;
                            window.open(url, "_blank");
                          }}
                          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                        >
                          View All on Yahoo ↗
                        </button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        {allOpenTickers.map((ticker) => (
                          <div key={ticker} className="space-y-1">
                            <label className="block text-sm font-medium text-gray-700">
                              {ticker}
                            </label>
                            <input
                              type="number"
                              value={currentPrices[ticker] || ""}
                              onChange={(e) =>
                                setCurrentPrices((prev) => ({
                                  ...prev,
                                  [ticker]: e.target.value
                                    ? parseFloat(e.target.value)
                                    : undefined!,
                                }))
                              }
                              placeholder={
                                getLatestTradePrice(ticker)?.toFixed(2) ||
                                "0.00"
                              }
                              step="0.01"
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            />
                          </div>
                        ))}
                      </div>
                      {Object.keys(currentPrices).length > 0 && (
                        <p className="text-xs text-gray-500 mt-3">
                          Last updated: {new Date().toLocaleDateString()}.
                          Prices are saved automatically.
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* Performance Chart */}
                {chartData.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                      Performance Over Time
                    </h2>
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="#E5E7EB"
                          />
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 12, fill: "#6B7280" }}
                            tickFormatter={(date: string) =>
                              new Date(date).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })
                            }
                          />
                          <YAxis
                            tick={{ fontSize: 12, fill: "#6B7280" }}
                            tickFormatter={(value: number) => `${value}%`}
                          />
                          <Tooltip
                            formatter={(value) => [`${value}%`, ""]}
                            labelFormatter={(date) =>
                              new Date(date).toLocaleDateString()
                            }
                          />
                          <Legend />
                          {players.map((player) => (
                            <Line
                              key={player.id}
                              type="monotone"
                              dataKey={player.name}
                              stroke={player.color}
                              strokeWidth={2}
                              dot={{
                                fill: player.color,
                                strokeWidth: 2,
                                r: 4,
                              }}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* Player Details */}
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {leaderboard.map((player) => (
                    <div
                      key={player.id}
                      className="bg-white rounded-xl border border-gray-200 p-6"
                    >
                      <div className="flex items-center gap-2 mb-4">
                        <span
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: player.color }}
                        />
                        <h3 className="font-semibold text-gray-900">
                          {player.name}
                        </h3>
                      </div>

                      <div className="space-y-3">
                        <div className="flex justify-between">
                          <span className="text-gray-500">Portfolio Value</span>
                          <span className="font-medium">
                            {formatCurrency(player.portfolioValue)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Cash</span>
                          <span className="font-medium">
                            {formatCurrency(player.cashRemaining)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Realized P&L</span>
                          <span
                            className={`font-medium ${player.realizedGains >= 0 ? "text-green-600" : "text-red-600"}`}
                          >
                            {formatCurrency(player.realizedGains)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Win Rate</span>
                          <span className="font-medium">
                            {player.winRate.toFixed(0)}%
                          </span>
                        </div>
                        {player.bestTrade && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">Best Trade</span>
                            <span className="font-medium text-green-600">
                              {player.bestTrade.ticker} (
                              {formatPercent(player.bestTrade.gainPct)})
                            </span>
                          </div>
                        )}
                        {player.worstTrade && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">Worst Trade</span>
                            <span className="font-medium text-red-600">
                              {player.worstTrade.ticker} (
                              {formatPercent(player.worstTrade.gainPct)})
                            </span>
                          </div>
                        )}
                      </div>

                      {player.positions.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-gray-100">
                          <p className="text-sm font-medium text-gray-700 mb-2">
                            Open Positions ({player.positions.length}/5)
                          </p>
                          <div className="space-y-2">
                            {player.positions.map((pos) => {
                              const currentPrice = getCurrentPrice(pos.ticker);
                              const currentValue = pos.shares * currentPrice;
                              const gain = currentValue - pos.totalCost;
                              const gainPct = (gain / pos.totalCost) * 100;
                              return (
                                <div key={pos.ticker} className="text-sm">
                                  <div className="flex justify-between">
                                    <span className="font-medium text-gray-900">
                                      {pos.ticker}
                                    </span>
                                    <span
                                      className={`font-medium ${gain >= 0 ? "text-green-600" : "text-red-600"}`}
                                    >
                                      {formatPercent(gainPct)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between text-gray-500 text-xs">
                                    <span>
                                      {pos.shares} shares @{" "}
                                      {formatCurrency(pos.avgCost)}
                                    </span>
                                    <span>
                                      Now: {formatCurrency(currentPrice)}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Trades Tab */}
        {activeTab === "trades" && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900">
                Trade History
              </h2>
              <button
                onClick={() => setShowAddTrade(true)}
                disabled={players.length === 0}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                + Add Trade
              </button>
            </div>

            {/* Add Trade Modal */}
            {showAddTrade && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                <div className="bg-white rounded-xl p-6 w-full max-w-md mx-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    Log Trade
                  </h3>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Player
                      </label>
                      <select
                        value={tradeForm.playerId}
                        onChange={(e) =>
                          setTradeForm({
                            ...tradeForm,
                            playerId: e.target.value,
                          })
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="">Select player</option>
                        {players.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({getOpenPositionCount(p.id)}/5 positions)
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Type
                      </label>
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            setTradeForm({ ...tradeForm, type: "buy" })
                          }
                          className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                            tradeForm.type === "buy"
                              ? "bg-green-100 text-green-700 border-2 border-green-500"
                              : "bg-gray-100 text-gray-600 border-2 border-transparent"
                          }`}
                        >
                          Buy
                        </button>
                        <button
                          onClick={() =>
                            setTradeForm({ ...tradeForm, type: "sell" })
                          }
                          className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                            tradeForm.type === "sell"
                              ? "bg-red-100 text-red-700 border-2 border-red-500"
                              : "bg-gray-100 text-gray-600 border-2 border-transparent"
                          }`}
                        >
                          Sell
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Trade Date
                      </label>
                      <input
                        type="date"
                        value={tradeForm.date}
                        onChange={(e) =>
                          setTradeForm({
                            ...tradeForm,
                            date: e.target.value,
                            price: "",
                            shares: "",
                          })
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                      {tradeForm.date <
                        new Date().toISOString().split("T")[0] && (
                        <p className="text-xs text-blue-600 mt-1">
                          Historical date - will fetch opening price for this
                          date
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Ticker Symbol
                      </label>
                      <input
                        type="text"
                        value={tradeForm.ticker}
                        onChange={(e) =>
                          setTradeForm({
                            ...tradeForm,
                            ticker: e.target.value.toUpperCase(),
                            price: "",
                            shares: "",
                          })
                        }
                        placeholder="e.g., AAPL"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 uppercase"
                      />
                    </div>

                    {/* Quick action buttons */}
                    <div className="space-y-2">
                      <button
                        onClick={() => {
                          if (tradeForm.ticker) {
                            const ticker = tradeForm.ticker.toUpperCase();
                            const url = `https://finance.yahoo.com/quote/${ticker}/history/`;
                            window.open(url, "_blank");
                            setPriceError(
                              `Look up ${tradeForm.date} opening price for ${ticker}, then enter below`
                            );
                          }
                        }}
                        disabled={!tradeForm.ticker}
                        className="w-full py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        Lookup Price on Yahoo Finance ↗
                      </button>
                      {tradeForm.price && (
                        <button
                          onClick={() => {
                            const price = parseFloat(tradeForm.price);
                            if (price > 0) {
                              const shares = Math.floor(
                                DEFAULT_POSITION_SIZE / price
                              );
                              setTradeForm((prev) => ({
                                ...prev,
                                shares: shares.toString(),
                              }));
                            }
                          }}
                          className="w-full py-2 text-sm font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                        >
                          Calculate $20k Position (
                          {tradeForm.price
                            ? Math.floor(
                                DEFAULT_POSITION_SIZE /
                                  parseFloat(tradeForm.price)
                              ) + " shares"
                            : ""}
                          )
                        </button>
                      )}
                    </div>
                    {priceError && (
                      <p className="text-sm text-blue-600">{priceError}</p>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Shares
                        </label>
                        <input
                          type="number"
                          value={tradeForm.shares}
                          onChange={(e) =>
                            setTradeForm({
                              ...tradeForm,
                              shares: e.target.value,
                            })
                          }
                          placeholder="100"
                          min="0"
                          step="1"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Price
                        </label>
                        <input
                          type="number"
                          value={tradeForm.price}
                          onChange={(e) =>
                            setTradeForm({
                              ...tradeForm,
                              price: e.target.value,
                            })
                          }
                          placeholder="150.00"
                          min="0"
                          step="0.01"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>

                    {tradeForm.shares && tradeForm.price && (
                      <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-sm text-gray-600">
                          Total:{" "}
                          <span className="font-semibold text-gray-900">
                            {formatCurrency(
                              parseFloat(tradeForm.shares) *
                                parseFloat(tradeForm.price)
                            )}
                          </span>
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-3 mt-6">
                    <button
                      onClick={() => setShowAddTrade(false)}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={addTrade}
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      Add Trade
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Trade List */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {trades.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-gray-500">No trades logged yet</p>
                </div>
              ) : (
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Date
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Player
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Type
                      </th>
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">
                        Ticker
                      </th>
                      <th className="px-4 py-3 text-right text-sm font-medium text-gray-500">
                        Shares
                      </th>
                      <th className="px-4 py-3 text-right text-sm font-medium text-gray-500">
                        Price
                      </th>
                      <th className="px-4 py-3 text-right text-sm font-medium text-gray-500">
                        Total
                      </th>
                      <th className="px-4 py-3 text-right text-sm font-medium text-gray-500"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {[...trades]
                      .sort((a, b) => b.timestamp - a.timestamp)
                      .map((trade) => {
                        const player = players.find(
                          (p) => p.id === trade.playerId
                        );
                        return (
                          <tr key={trade.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-sm text-gray-600">
                              {new Date(trade.date).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-2 h-2 rounded-full"
                                  style={{
                                    backgroundColor: player?.color,
                                  }}
                                />
                                <span className="text-sm font-medium text-gray-900">
                                  {player?.name}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                                  trade.type === "buy"
                                    ? "bg-green-100 text-green-700"
                                    : "bg-red-100 text-red-700"
                                }`}
                              >
                                {trade.type.toUpperCase()}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-sm font-medium text-gray-900">
                              {trade.ticker}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600 text-right">
                              {trade.shares}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600 text-right">
                              {formatCurrency(trade.price)}
                            </td>
                            <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                              {formatCurrency(trade.shares * trade.price)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                onClick={() => deleteTrade(trade.id)}
                                className="text-gray-400 hover:text-red-600 transition-colors"
                              >
                                &times;
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Players Tab */}
        {activeTab === "players" && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-900">Players</h2>
              <button
                onClick={() => setShowAddPlayer(true)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                + Add Player
              </button>
            </div>

            {/* Add Player Modal */}
            {showAddPlayer && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                <div className="bg-white rounded-xl p-6 w-full max-w-sm mx-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    Add Player
                  </h3>
                  <input
                    type="text"
                    value={newPlayerName}
                    onChange={(e) => setNewPlayerName(e.target.value)}
                    placeholder="Player name"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    autoFocus
                    onKeyDown={(e) => e.key === "Enter" && addPlayer()}
                  />
                  <div className="flex gap-3 mt-4">
                    <button
                      onClick={() => setShowAddPlayer(false)}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={addPlayer}
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Player List */}
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
              {players.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-gray-500">No players added yet</p>
                </div>
              ) : (
                players.map((player) => (
                  <div
                    key={player.id}
                    className="px-6 py-4 flex items-center gap-4"
                  >
                    <span
                      className="w-4 h-4 rounded-full"
                      style={{ backgroundColor: player.color }}
                    />
                    {editingPlayer === player.id ? (
                      <input
                        type="text"
                        defaultValue={player.name}
                        autoFocus
                        className="flex-1 px-2 py-1 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        onBlur={(e) =>
                          updatePlayerName(player.id, e.target.value)
                        }
                        onKeyDown={(e) =>
                          e.key === "Enter" &&
                          updatePlayerName(
                            player.id,
                            (e.target as HTMLInputElement).value
                          )
                        }
                      />
                    ) : (
                      <span className="flex-1 font-medium text-gray-900">
                        {player.name}
                      </span>
                    )}
                    <button
                      onClick={() => setEditingPlayer(player.id)}
                      className="text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deletePlayer(player.id)}
                      className="text-gray-400 hover:text-red-600 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <div className="space-y-6">
            {/* API Key Setup */}
            <div
              className={`bg-white rounded-xl border p-6 ${polygonApiKey ? "border-gray-200" : "border-blue-300 bg-blue-50"}`}
            >
              <h2 className="text-lg font-semibold text-gray-900 mb-2">
                Stock Price API{" "}
                {!polygonApiKey && (
                  <span className="text-blue-600 text-sm font-normal ml-2">
                    ← Setup required
                  </span>
                )}
              </h2>
              <p className="text-sm text-gray-600 mb-4">
                To fetch historical stock prices, you need a free Polygon.io API
                key.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Polygon.io API Key
                  </label>
                  <input
                    type="text"
                    value={polygonApiKey}
                    onChange={(e) => setPolygonApiKey(e.target.value.trim())}
                    placeholder="Enter your API key..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
                  />
                  {polygonApiKey && (
                    <p className="text-sm text-green-600 mt-1">
                      API key saved
                    </p>
                  )}
                </div>

                {!polygonApiKey && (
                  <div className="bg-gray-50 rounded-lg p-4 text-sm">
                    <p className="font-medium text-gray-900 mb-2">
                      How to get your free API key:
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-gray-600">
                      <li>Go to polygon.io</li>
                      <li>Click &quot;Get your Free API Key&quot;</li>
                      <li>Create an account (free, no credit card)</li>
                      <li>Copy your API key from the dashboard</li>
                      <li>Paste it above</li>
                    </ol>
                    <p className="mt-3 text-gray-500">
                      Free tier: 5 API calls/minute, unlimited historical data
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                Contest Settings
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Contest Start Date
                  </label>
                  <input
                    type="date"
                    value={contestStartDate}
                    onChange={(e) => setContestStartDate(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Starting Cash
                  </label>
                  <p className="text-gray-600">
                    {formatCurrency(STARTING_CASH)} per player
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Position Limits
                  </label>
                  <p className="text-gray-600">3-5 positions per player</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                Data Management
              </h2>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-gray-900">Export Data</p>
                    <p className="text-sm text-gray-500">
                      Download all contest data as JSON
                    </p>
                  </div>
                  <button
                    onClick={exportData}
                    className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    Export
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-gray-900">Import Data</p>
                    <p className="text-sm text-gray-500">
                      Load contest data from a JSON file
                    </p>
                  </div>
                  <label className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors cursor-pointer">
                    Import
                    <input
                      type="file"
                      accept=".json"
                      onChange={importData}
                      className="hidden"
                    />
                  </label>
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                  <div>
                    <p className="font-medium text-red-600">Reset All Data</p>
                    <p className="text-sm text-gray-500">
                      Delete all players and trades
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      if (
                        window.confirm(
                          "Are you sure? This will delete all data and cannot be undone."
                        )
                      ) {
                        setPlayers([]);
                        setTrades([]);
                        setCurrentPrices({});
                        localStorage.removeItem("stockContest_players");
                        localStorage.removeItem("stockContest_trades");
                        localStorage.removeItem("stockContest_currentPrices");
                      }
                    }}
                    className="px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors"
                  >
                    Reset
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
