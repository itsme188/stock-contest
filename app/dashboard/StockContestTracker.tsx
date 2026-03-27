"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  type Player,
  type Trade,
  type TradeForm,
  COLORS,
  DEFAULT_POSITION_SIZE,
  getLastSaleProceeds,
  getLeaderboard,
  getPerformanceChartData,
  getPlayerPositions,
  getPlayerStats,
  validateTrade,
} from "@/lib/contest";
import DashboardTab from "./components/DashboardTab";
import TradesTab from "./components/TradesTab";
import PlayersTab from "./components/PlayersTab";
import SettingsTab from "./components/SettingsTab";

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
  const [priceHistory, setPriceHistory] = useState<
    Record<string, Record<string, number>>
  >({});
  const [gmailAddress, setGmailAddress] = useState("");
  const [gmailAppPassword, setGmailAppPassword] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [aiModel, setAiModel] = useState("claude-sonnet-4-5-20250929");
  const [playerEmails, setPlayerEmails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [tradeForm, setTradeForm] = useState<TradeForm>({
    playerId: "",
    type: "buy",
    ticker: "",
    shares: "",
    price: "",
    date: new Date().toISOString().split("T")[0],
  });

  // Track whether initial load is complete to avoid saving default state
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load data from API on mount
  useEffect(() => {
    fetch("/api/contest")
      .then((res) => res.json())
      .then((data) => {
        if (data.players?.length) setPlayers(data.players);
        if (data.trades?.length) setTrades(data.trades);
        if (data.contestStartDate) setContestStartDate(data.contestStartDate);
        if (data.polygonApiKey) setPolygonApiKey(data.polygonApiKey);
        if (data.currentPrices && Object.keys(data.currentPrices).length)
          setCurrentPrices(data.currentPrices);
        if (data.priceHistory && Object.keys(data.priceHistory).length)
          setPriceHistory(data.priceHistory);
        if (data.gmailAddress) setGmailAddress(data.gmailAddress);
        if (data.gmailAppPassword) setGmailAppPassword(data.gmailAppPassword);
        if (data.anthropicApiKey) setAnthropicApiKey(data.anthropicApiKey);
        if (data.aiModel) setAiModel(data.aiModel);
        if (data.playerEmails && Object.keys(data.playerEmails).length)
          setPlayerEmails(data.playerEmails);
        loaded.current = true;
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load contest data:", err);
        setLoadError("Failed to load contest data. Check that the server is running.");
        setLoading(false);
        loaded.current = true;
      });
  }, []);

  // Debounced save for settings, prices, players (NOT trades — those use atomic API calls)
  const saveToApi = useCallback(() => {
    if (!loaded.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch("/api/contest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          players,
          contestStartDate,
          polygonApiKey,
          currentPrices,
          priceHistory,
          gmailAddress,
          gmailAppPassword,
          anthropicApiKey,
          aiModel,
          playerEmails,
        }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Save failed (${res.status})`);
          setSaveError(null);
        })
        .catch((err) => {
          console.error("Failed to save contest data:", err);
          setSaveError("Failed to save. Changes may be lost.");
        });
    }, 500);
  }, [players, contestStartDate, polygonApiKey, currentPrices, priceHistory, gmailAddress, gmailAppPassword, anthropicApiKey, aiModel, playerEmails]);

  useEffect(() => {
    saveToApi();
  }, [saveToApi]);

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

  const deletePlayer = async (id: string) => {
    if (!window.confirm("Delete this player and all their trades?")) return;

    // Delete trades from DB first (server-first for irreversible operations)
    const playerTrades = trades.filter((t) => t.playerId === id);
    for (const trade of playerTrades) {
      try {
        const res = await fetch(`/api/trades/${trade.id}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json();
          alert(`Failed to delete trade ${trade.ticker}: ${data.error || res.status}`);
          return;
        }
      } catch (err) {
        alert(`Failed to delete trade: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    setPlayers(players.filter((p) => p.id !== id));
    setTrades(trades.filter((t) => t.playerId !== id));
  };

  // --- Price Fetching (via server-side API route) ---

  const fetchStockPrice = async (
    ticker: string,
    date: string | null = null
  ): Promise<number | null> => {
    setFetchingPrice(true);
    setPriceError("");

    const targetDate = date || tradeForm.date;

    try {
      const params = new URLSearchParams({ ticker });
      // Always pass date to get opening price for that day
      params.set("date", targetDate);

      const res = await fetch(`/api/prices?${params}`);
      const data = await res.json();

      if (!res.ok) {
        setPriceError(data.error || `Failed to fetch price (${res.status})`);
        return null;
      }

      // Show price type label
      if (data.actualDate) {
        setPriceError(`Market closed ${targetDate}. Using ${data.actualDate} open.`);
      } else if (data.priceType === "current") {
        setPriceError(`Current price (${data.source === "ibkr" ? "IBKR" : "Polygon"})`);
      } else if (data.priceType === "close") {
        setPriceError(`Closing price, ${new Date(data.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${data.source === "ibkr" ? "IBKR" : "Polygon"})`);
      } else if (data.priceType === "open") {
        setPriceError(`Opening price, ${new Date(data.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${data.source === "ibkr" ? "IBKR" : "Polygon"})`);
      }

      setTradeForm((prev) => ({ ...prev, price: data.price.toFixed(2) }));
      return data.price;
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
      if (tradeForm.type === "sell" && tradeForm.playerId) {
        const positions = getPlayerPositions(tradeForm.playerId, trades);
        const position = positions.find(p => p.ticker === tradeForm.ticker.toUpperCase());
        if (position) {
          setTradeForm((prev) => ({ ...prev, shares: position.shares.toString() }));
        }
      } else if (tradeForm.playerId) {
        const stats = getPlayerStats(tradeForm.playerId, trades, currentPrices);
        const lastSaleProceeds = getLastSaleProceeds(tradeForm.playerId, trades);
        const targetBudget = lastSaleProceeds ?? DEFAULT_POSITION_SIZE;
        const budget = Math.min(targetBudget, stats.cashRemaining);
        const shares = Math.floor(budget / price);
        setTradeForm((prev) => ({ ...prev, shares: shares.toString() }));
      } else {
        const shares = Math.floor(DEFAULT_POSITION_SIZE / price);
        setTradeForm((prev) => ({ ...prev, shares: shares.toString() }));
      }
    }
  };

  // --- Trade Logic ---

  const addTrade = async () => {
    // Client-side validation for instant feedback
    const result = validateTrade(
      {
        playerId: tradeForm.playerId,
        type: tradeForm.type,
        ticker: tradeForm.ticker,
        shares: parseFloat(tradeForm.shares),
        price: parseFloat(tradeForm.price),
      },
      trades,
      currentPrices
    );

    if (!result.valid) {
      alert(result.error);
      return;
    }

    try {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: tradeForm.playerId,
          type: tradeForm.type,
          ticker: tradeForm.ticker.toUpperCase(),
          shares: parseFloat(tradeForm.shares),
          price: parseFloat(tradeForm.price),
          date: tradeForm.date,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to save trade");
        return;
      }

      // Only update local state AFTER server confirms persistence
      setTrades((prev) => [...prev, data.trade]);
      setTradeForm({
        playerId: tradeForm.playerId,
        type: "buy",
        ticker: "",
        shares: "",
        price: "",
        date: new Date().toISOString().split("T")[0],
      });
      setShowAddTrade(false);
    } catch (err) {
      alert(`Failed to save trade: ${err instanceof Error ? err.message : err}`);
    }
  };

  const deleteTrade = async (tradeId: string) => {
    if (!window.confirm("Delete this trade?")) return;

    try {
      const res = await fetch(`/api/trades/${tradeId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to delete trade");
        return;
      }
      setTrades((prev) => prev.filter((t) => t.id !== tradeId));
    } catch (err) {
      alert(`Failed to delete trade: ${err instanceof Error ? err.message : err}`);
    }
  };

  // --- Import / Export ---

  const exportData = () => {
    const data = { players, trades, contestStartDate, currentPrices, priceHistory };
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
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target?.result as string);
          if (data.players) setPlayers(data.players);
          if (data.contestStartDate)
            setContestStartDate(data.contestStartDate);
          if (data.currentPrices) setCurrentPrices(data.currentPrices);
          if (data.priceHistory) setPriceHistory(data.priceHistory);

          // Import trades via atomic API endpoint
          if (data.trades?.length) {
            const res = await fetch("/api/trades/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trades: data.trades, clear: true }),
            });
            if (!res.ok) {
              const err = await res.json();
              alert(`Failed to import trades: ${err.error}`);
              return;
            }
            setTrades(data.trades);
          }

          alert("Data imported successfully!");
        } catch {
          alert("Error importing data. Please check the file format.");
        }
      };
      reader.readAsText(file);
    }
  };

  // --- Derived Data ---

  const leaderboard = useMemo(() => getLeaderboard(players, trades, currentPrices), [players, trades, currentPrices]);
  const chartData = useMemo(() => getPerformanceChartData(players, trades, currentPrices, priceHistory, undefined, contestStartDate), [players, trades, currentPrices, priceHistory, contestStartDate]);


  // --- Render ---

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">Loading contest data...</p>
      </div>
    );
  }

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

      {loadError && (
        <div className="max-w-7xl mx-auto px-4 pt-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between">
            <p className="text-red-700 text-sm">{loadError}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {saveError && (
        <div className="max-w-7xl mx-auto px-4 pt-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center justify-between">
            <p className="text-amber-700 text-sm">{saveError}</p>
            <button
              onClick={() => { setSaveError(null); saveToApi(); }}
              className="px-3 py-1 text-sm bg-amber-100 text-amber-700 rounded hover:bg-amber-200 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-6">
        {activeTab === "dashboard" && (
          <DashboardTab
            players={players}
            trades={trades}
            currentPrices={currentPrices}
            setCurrentPrices={setCurrentPrices}
            priceHistory={priceHistory}
            setPriceHistory={setPriceHistory}
            leaderboard={leaderboard}
            chartData={chartData}
            setActiveTab={setActiveTab}
            setShowAddTrade={setShowAddTrade}
            polygonApiKey={polygonApiKey}
          />
        )}

        {activeTab === "trades" && (
          <TradesTab
            players={players}
            trades={trades}
            currentPrices={currentPrices}
            tradeForm={tradeForm}
            setTradeForm={setTradeForm}
            showAddTrade={showAddTrade}
            setShowAddTrade={setShowAddTrade}
            priceError={priceError}
            addTrade={addTrade}
            deleteTrade={deleteTrade}
            fetchingPrice={fetchingPrice}
            fetchPriceAndCalculateShares={fetchPriceAndCalculateShares}
          />
        )}

        {activeTab === "players" && (
          <PlayersTab
            players={players}
            editingPlayer={editingPlayer}
            setEditingPlayer={setEditingPlayer}
            showAddPlayer={showAddPlayer}
            setShowAddPlayer={setShowAddPlayer}
            newPlayerName={newPlayerName}
            setNewPlayerName={setNewPlayerName}
            addPlayer={addPlayer}
            updatePlayerName={updatePlayerName}
            deletePlayer={deletePlayer}
          />
        )}

        {activeTab === "settings" && (
          <SettingsTab
            contestStartDate={contestStartDate}
            setContestStartDate={setContestStartDate}
            polygonApiKey={polygonApiKey}
            setPolygonApiKey={setPolygonApiKey}
            exportData={exportData}
            importData={importData}
            setPlayers={setPlayers}
            setTrades={setTrades}
            setCurrentPrices={setCurrentPrices}
            gmailAddress={gmailAddress}
            setGmailAddress={setGmailAddress}
            gmailAppPassword={gmailAppPassword}
            setGmailAppPassword={setGmailAppPassword}
            anthropicApiKey={anthropicApiKey}
            setAnthropicApiKey={setAnthropicApiKey}
            aiModel={aiModel}
            setAiModel={setAiModel}
            playerEmails={playerEmails}
            setPlayerEmails={setPlayerEmails}
            players={players}
          />
        )}
      </div>
    </div>
  );
}
