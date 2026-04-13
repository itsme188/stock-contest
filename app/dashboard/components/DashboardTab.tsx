import React, { useState } from "react";
import {
  type Player,
  type Trade,
  type LeaderboardEntry,
  type Period,
  BENCHMARK_KEY,
  getPlayerPositions,
  getLatestTradePrice,
  getPriceStaleness,
  getPeriodReturn,
  formatCurrency,
  formatPercent,
} from "@/lib/contest";
import PeriodSelector from "./PeriodSelector";
import PerformanceChart from "./PerformanceChart";
import PlayerDetailCard from "./PlayerDetailCard";

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
  contestStartDate: string;
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
  contestStartDate,
}: DashboardTabProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshSource, setRefreshSource] = useState<"polygon" | "ibkr" | null>(null);
  const [refreshStatus, setRefreshStatus] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<Period>("ALL");
  const [loadingBenchmark, setLoadingBenchmark] = useState(false);

  const hasBenchmark = !!(priceHistory[BENCHMARK_KEY] && Object.keys(priceHistory[BENCHMARK_KEY]).length > 0);

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
    if (data.errors?.length) {
      const failedTickers = data.errors.map(e => e.split(':')[0].trim());
      setRefreshStatus(`${msg} (failed: ${failedTickers.join(', ')})`);
    } else {
      setRefreshStatus(msg);
    }
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

  const loadBenchmark = async () => {
    setLoadingBenchmark(true);
    setRefreshStatus("Loading S&P 500 benchmark data...");
    try {
      const res = await fetch("/api/prices/benchmark", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setPriceHistory((prev) => ({
          ...prev,
          [BENCHMARK_KEY]: { ...(prev[BENCHMARK_KEY] || {}), ...data.prices },
        }));
        setRefreshStatus(`Loaded ${data.daysLoaded} days of S&P 500 data`);
      } else {
        setRefreshStatus(`Error: ${data.error}`);
      }
    } catch (err) {
      setRefreshStatus(`Error: ${err instanceof Error ? err.message : err}`);
    } finally {
      setLoadingBenchmark(false);
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
        <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-gray-900">Leaderboard</h2>
            <PeriodSelector selected={selectedPeriod} onChange={setSelectedPeriod} />
          </div>
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
          {leaderboard.map((player, index) => {
            const periodReturn = selectedPeriod !== "ALL"
              ? getPeriodReturn(player.id, selectedPeriod, trades, currentPrices, priceHistory, contestStartDate)
              : null;

            return (
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
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
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
                <div className="text-right flex-shrink-0">
                  <p className="font-semibold text-gray-900">
                    {formatCurrency(player.totalValue)}
                  </p>
                  <div className="flex items-center gap-1.5 justify-end">
                    <span
                      className={`text-sm font-medium ${player.returnPct >= 0 ? "text-green-600" : "text-red-600"}`}
                    >
                      {formatPercent(player.returnPct)}
                    </span>
                    {periodReturn && (
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          periodReturn.returnDollar >= 0
                            ? "bg-green-50 text-green-700"
                            : "bg-red-50 text-red-700"
                        }`}
                      >
                        {periodReturn.returnDollar >= 0 ? "+" : ""}
                        {formatCurrency(periodReturn.returnDollar).replace("$", "$")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Update Current Prices */}
      {allOpenTickers.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                Update Current Prices
              </h2>
              <p className="text-sm text-gray-500">
                Enter today&apos;s prices to calculate accurate returns
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
              {!hasBenchmark && (
                <button
                  onClick={loadBenchmark}
                  disabled={loadingBenchmark}
                  title="Load S&P 500 benchmark data for chart comparison (IBKR primary, Polygon fallback)"
                  className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loadingBenchmark ? "Loading..." : "Load S&P 500"}
                </button>
              )}
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
                    Prices last updated: {staleness.latestDate
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
      <PerformanceChart
        chartData={chartData}
        players={players}
        selectedPeriod={selectedPeriod}
        contestStartDate={contestStartDate}
        hasBenchmark={hasBenchmark}
      />

      {/* Player Details */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {leaderboard.map((player) => (
          <PlayerDetailCard
            key={player.id}
            player={player}
            trades={trades}
            currentPrices={currentPrices}
            priceHistory={priceHistory}
            contestStartDate={contestStartDate}
            selectedPeriod={selectedPeriod}
          />
        ))}
      </div>
    </div>
  );
}
