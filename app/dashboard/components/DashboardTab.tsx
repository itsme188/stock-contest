import React, { useState } from "react";
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
import {
  type Player,
  type Trade,
  type LeaderboardEntry,
  getPlayerPositions,
  getLatestTradePrice,
  getCurrentPrice,
  getPriceStaleness,
  formatCurrency,
  formatPercent,
} from "@/lib/contest";

interface DashboardTabProps {
  players: Player[];
  trades: Trade[];
  currentPrices: Record<string, number>;
  setCurrentPrices: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  priceHistory: Record<string, Record<string, number>>;
  setPriceHistory: React.Dispatch<React.SetStateAction<Record<string, Record<string, number>>>>;
  leaderboard: LeaderboardEntry[];
  chartData: Record<string, string>[];
  setActiveTab: (tab: string) => void;
  setShowAddTrade: (show: boolean) => void;
  polygonApiKey: string;
}

export default function DashboardTab({
  players,
  trades,
  currentPrices,
  setCurrentPrices,
  priceHistory,
  setPriceHistory,
  leaderboard,
  chartData,
  setActiveTab,
  setShowAddTrade,
  polygonApiKey,
}: DashboardTabProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSource, setRefreshSource] = useState<"polygon" | "ibkr" | null>(null);
  const [refreshStatus, setRefreshStatus] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  const applyPriceUpdate = (data: { updated: Record<string, number>; date: string; errors?: string[] }, source: string) => {
    setCurrentPrices((prev) => ({ ...prev, ...data.updated }));
    const today = data.date;
    setPriceHistory((prev) => {
      const next = { ...prev };
      for (const [ticker, price] of Object.entries(data.updated)) {
        if (!next[ticker]) next[ticker] = {};
        next[ticker] = { ...next[ticker], [today]: price };
      }
      return next;
    });
    const count = Object.keys(data.updated).length;
    const msg = `Updated ${count} price${count !== 1 ? "s" : ""} via ${source}`;
    setRefreshStatus(data.errors?.length ? `${msg} (${data.errors.length} failed)` : msg);
    setLastRefreshed(new Date().toLocaleString());
  };

  const refreshPrices = async (source: "polygon" | "ibkr") => {
    setRefreshing(true);
    setRefreshSource(source);
    const endpoint = source === "ibkr" ? "/api/prices/ibkr" : "/api/prices/update";

    if (source === "polygon") {
      const tickerCount = allOpenTickers.length;
      const batches = Math.ceil(tickerCount / 5);
      setRefreshStatus(batches > 1 ? `Fetching batch 1/${batches} (free tier: 5/min)...` : "Fetching prices...");
    } else {
      setRefreshStatus("Connecting to IBKR TWS...");
    }

    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        applyPriceUpdate(data, source === "ibkr" ? "IBKR TWS" : "Polygon");
      } else {
        setRefreshStatus(`Error: ${data.error}`);
      }
    } catch (err) {
      setRefreshStatus(`Error: ${err instanceof Error ? err.message : err}`);
    } finally {
      setRefreshing(false);
      setRefreshSource(null);
    }
  };

  if (players.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
        <p className="text-gray-500 mb-4">No players added yet</p>
        <button
          onClick={() => setActiveTab("players")}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Add Players
        </button>
      </div>
    );
  }

  const allOpenTickers = [
    ...new Set(
      players.flatMap((p) =>
        getPlayerPositions(p.id, trades).map((pos) => pos.ticker)
      )
    ),
  ].sort();

  return (
    <div className="space-y-6">
      {/* Leaderboard */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Leaderboard</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setActiveTab("trades"); setShowAddTrade(true); }}
              className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              + Add Trade
            </button>
            <a
              href="/email/preview"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors inline-block"
            >
              Weekly Email
            </a>
          </div>
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
      {allOpenTickers.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Update Current Prices
              </h2>
              <p className="text-sm text-gray-500">
                Enter today&apos;s prices to calculate accurate returns
              </p>
            </div>
            <div className="flex items-center gap-2">
              {refreshStatus && (
                <span
                  className={`text-sm ${refreshStatus.startsWith("Error") ? "text-red-600" : "text-green-600"}`}
                >
                  {refreshStatus}
                </span>
              )}
              <button
                onClick={() => refreshPrices("ibkr")}
                disabled={refreshing}
                title="Fetch prices from IBKR Trader Workstation (must be running)"
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {refreshing && refreshSource === "ibkr" ? "Refreshing..." : "Refresh Prices"}
              </button>
              <button
                onClick={() => {
                  if (!polygonApiKey) {
                    setRefreshStatus("Add Polygon API key in Settings first");
                    return;
                  }
                  refreshPrices("polygon");
                }}
                disabled={refreshing}
                className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {refreshing && refreshSource === "polygon" ? "Refreshing..." : "Polygon"}
              </button>
              <button
                onClick={() => {
                  const url = `https://finance.yahoo.com/quotes/${allOpenTickers.join(",")}/view/v1`;
                  window.open(url, "_blank");
                }}
                className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Yahoo ↗
              </button>
            </div>
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
                    getLatestTradePrice(ticker, trades)?.toFixed(2) || "0.00"
                  }
                  step="0.01"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            ))}
          </div>
          {Object.keys(currentPrices).length > 0 && (() => {
            const staleness = getPriceStaleness(currentPrices, priceHistory, allOpenTickers);
            return (
              <p className="text-xs mt-3">
                {staleness.stale ? (
                  <span className="text-amber-600 font-medium">
                    ⚠️ Prices last updated: {staleness.latestDate
                      ? `${new Date(staleness.latestDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${staleness.daysOld} day${staleness.daysOld !== 1 ? "s" : ""} ago)`
                      : "unknown"
                    }
                  </span>
                ) : (
                  <span className="text-gray-500">
                    {lastRefreshed
                      ? `Last refreshed: ${lastRefreshed}.`
                      : "Prices are saved automatically."}
                  </span>
                )}
              </p>
            );
          })()}
        </div>
      )}

      {/* Performance Chart */}
      {chartData.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Performance Over Time
          </h2>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
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
              <h3 className="font-semibold text-gray-900">{player.name}</h3>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-500">Total Value</span>
                <span className="font-semibold">
                  {formatCurrency(player.totalValue)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Cash</span>
                <span className="font-medium">
                  {formatCurrency(player.cashRemaining)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Positions</span>
                <span className="font-medium">
                  {formatCurrency(player.portfolioValue)}
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
                  <span
                    className={`font-medium ${player.bestTrade.gainPct >= 0 ? "text-green-600" : "text-red-600"}`}
                  >
                    {player.bestTrade.ticker} (
                    {formatPercent(player.bestTrade.gainPct)})
                  </span>
                </div>
              )}
              {player.worstTrade && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Worst Trade</span>
                  <span
                    className={`font-medium ${player.worstTrade.gainPct >= 0 ? "text-green-600" : "text-red-600"}`}
                  >
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
                    const price = getCurrentPrice(
                      pos.ticker,
                      currentPrices,
                      trades
                    );
                    const currentValue = pos.shares * price;
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
                            {pos.shares} shares @ {formatCurrency(pos.avgCost)}
                          </span>
                          <span>Now: {formatCurrency(price)}</span>
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
    </div>
  );
}
