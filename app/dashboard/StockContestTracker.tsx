"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  type Player,
  type Trade,
  type TradeForm,
  COLORS,
  DEFAULT_POSITION_SIZE,
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
  const [playerEmails, setPlayerEmails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

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
        if (data.playerEmails && Object.keys(data.playerEmails).length)
          setPlayerEmails(data.playerEmails);
        loaded.current = true;
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load contest data:", err);
        setLoading(false);
        loaded.current = true;
      });
  }, []);

  // Debounced save to API whenever persisted state changes
  const saveToApi = useCallback(() => {
    if (!loaded.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch("/api/contest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          players,
          trades,
          contestStartDate,
          polygonApiKey,
          currentPrices,
          priceHistory,
          gmailAddress,
          gmailAppPassword,
          anthropicApiKey,
          playerEmails,
        }),
      }).catch((err) => console.error("Failed to save contest data:", err));
    }, 500);
  }, [players, trades, contestStartDate, polygonApiKey, currentPrices, priceHistory, gmailAddress, gmailAppPassword, anthropicApiKey, playerEmails]);

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

  const deletePlayer = (id: string) => {
    if (window.confirm("Delete this player and all their trades?")) {
      setPlayers(players.filter((p) => p.id !== id));
      setTrades(trades.filter((t) => t.playerId !== id));
    }
  };

  // --- Price Fetching (via server-side API route) ---

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

      if (data.actualDate) {
        setPriceError(`Market closed ${targetDate}. Using ${data.actualDate} open.`);
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
        const budget = Math.min(DEFAULT_POSITION_SIZE, stats.cashRemaining);
        const shares = Math.floor(budget / price);
        setTradeForm((prev) => ({ ...prev, shares: shares.toString() }));
      } else {
        const shares = Math.floor(DEFAULT_POSITION_SIZE / price);
        setTradeForm((prev) => ({ ...prev, shares: shares.toString() }));
      }
    }
  };

  // --- Trade Logic ---

  const addTrade = () => {
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

    const ticker = tradeForm.ticker.toUpperCase();

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
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target?.result as string);
          if (data.players) setPlayers(data.players);
          if (data.trades) setTrades(data.trades);
          if (data.contestStartDate)
            setContestStartDate(data.contestStartDate);
          if (data.currentPrices) setCurrentPrices(data.currentPrices);
          if (data.priceHistory) setPriceHistory(data.priceHistory);
          alert("Data imported successfully!");
        } catch {
          alert("Error importing data. Please check the file format.");
        }
      };
      reader.readAsText(file);
    }
  };

  // --- Derived Data ---

  const leaderboard = getLeaderboard(players, trades, currentPrices);
  const chartData = getPerformanceChartData(players, trades, currentPrices, priceHistory);


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

      <div className="max-w-7xl mx-auto px-4 py-6">
        {activeTab === "dashboard" && (
          <DashboardTab
            players={players}
            trades={trades}
            currentPrices={currentPrices}
            setCurrentPrices={setCurrentPrices}
            setPriceHistory={setPriceHistory}
            leaderboard={leaderboard}
            chartData={chartData}
            setActiveTab={setActiveTab}
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
            playerEmails={playerEmails}
            setPlayerEmails={setPlayerEmails}
            players={players}
          />
        )}
      </div>
    </div>
  );
}
