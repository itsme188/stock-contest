import React, { useState } from "react";
import {
  type Player,
  type Trade,
  STARTING_CASH,
  formatCurrency,
} from "@/lib/contest";

interface SettingsTabProps {
  contestStartDate: string;
  setContestStartDate: (date: string) => void;
  polygonApiKey: string;
  setPolygonApiKey: (key: string) => void;
  exportData: () => void;
  importData: (event: React.ChangeEvent<HTMLInputElement>) => void;
  setPlayers: React.Dispatch<React.SetStateAction<Player[]>>;
  setTrades: React.Dispatch<React.SetStateAction<Trade[]>>;
  setCurrentPrices: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  gmailAddress: string;
  setGmailAddress: (addr: string) => void;
  gmailAppPassword: string;
  setGmailAppPassword: (pw: string) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (key: string) => void;
  playerEmails: Record<string, string>;
  setPlayerEmails: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  players: Player[];
}

export default function SettingsTab({
  contestStartDate,
  setContestStartDate,
  polygonApiKey,
  setPolygonApiKey,
  exportData,
  importData,
  setPlayers,
  setTrades,
  setCurrentPrices,
  gmailAddress,
  setGmailAddress,
  gmailAppPassword,
  setGmailAppPassword,
  anthropicApiKey,
  setAnthropicApiKey,
  playerEmails,
  setPlayerEmails,
  players,
}: SettingsTabProps) {
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailStatus, setEmailStatus] = useState("");
  const [backfilling, setBackfilling] = useState(false);
  const [backfillStatus, setBackfillStatus] = useState("");

  const backfillPriceHistory = async () => {
    setBackfilling(true);
    setBackfillStatus("");
    try {
      const res = await fetch("/api/prices/backfill", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setBackfillStatus(
          `Added ${data.daysAdded} days of price data for ${data.tickers} ticker${data.tickers !== 1 ? "s" : ""}`
        );
      } else {
        setBackfillStatus(`Error: ${data.error}`);
      }
    } catch (err) {
      setBackfillStatus(`Error: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBackfilling(false);
    }
  };

  const sendTestEmail = async () => {
    setSendingEmail(true);
    setEmailStatus("");
    try {
      const res = await fetch("/api/email/weekly", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setEmailStatus(`Email sent to ${data.recipients} recipient(s)`);
      } else {
        setEmailStatus(`Error: ${data.error}`);
      }
    } catch (err) {
      setEmailStatus(`Error: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSendingEmail(false);
    }
  };

  return (
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
          To fetch historical stock prices, you need a free Polygon.io API key.
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
              <p className="text-sm text-green-600 mt-1">API key saved</p>
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

      {/* Weekly Email Report */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">
          Weekly Email Report
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          Send a weekly summary with leaderboard, trades, and AI commentary.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Gmail Address
            </label>
            <input
              type="email"
              value={gmailAddress}
              onChange={(e) => setGmailAddress(e.target.value.trim())}
              placeholder="your-email@gmail.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Gmail App Password
            </label>
            <input
              type="password"
              value={gmailAppPassword}
              onChange={(e) => setGmailAppPassword(e.target.value.trim())}
              placeholder="xxxx xxxx xxxx xxxx"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
            />
            {!gmailAppPassword && (
              <p className="text-xs text-gray-500 mt-1">
                Google Account → Security → 2-Step Verification → App passwords
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Anthropic API Key
            </label>
            <input
              type="password"
              value={anthropicApiKey}
              onChange={(e) => setAnthropicApiKey(e.target.value.trim())}
              placeholder="sk-ant-..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              Used to generate AI commentary for the weekly email
            </p>
          </div>

          <div className="pt-2 border-t border-gray-100">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Player Email Addresses
            </label>
            <div className="space-y-2">
              {players.map((player) => (
                <div key={player.id} className="flex items-center gap-3">
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: player.color }}
                  />
                  <span className="text-sm font-medium text-gray-900 w-20">
                    {player.name}
                  </span>
                  <input
                    type="email"
                    value={playerEmails[player.id] || ""}
                    onChange={(e) =>
                      setPlayerEmails((prev) => ({
                        ...prev,
                        [player.id]: e.target.value.trim(),
                      }))
                    }
                    placeholder={`${player.name.toLowerCase()}@gmail.com`}
                    className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              ))}
              {players.length === 0 && (
                <p className="text-sm text-gray-500">
                  Add players first to configure email addresses
                </p>
              )}
            </div>
          </div>

          <div className="pt-2">
            <button
              onClick={sendTestEmail}
              disabled={sendingEmail || !gmailAddress || !gmailAppPassword || !anthropicApiKey}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              {sendingEmail ? "Sending..." : "Send Test Email"}
            </button>
            {emailStatus && (
              <p
                className={`text-sm mt-2 ${emailStatus.startsWith("Error") ? "text-red-600" : "text-green-600"}`}
              >
                {emailStatus}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Price Data */}
      {polygonApiKey && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Price Data
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            Backfill daily historical prices from contest start to today for all traded tickers.
            This populates the performance chart with smooth daily data points.
          </p>
          <div>
            <button
              onClick={backfillPriceHistory}
              disabled={backfilling}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              {backfilling ? "Backfilling..." : "Backfill Price History"}
            </button>
            {backfillStatus && (
              <p
                className={`text-sm mt-2 ${backfillStatus.startsWith("Error") ? "text-red-600" : "text-green-600"}`}
              >
                {backfillStatus}
              </p>
            )}
          </div>
        </div>
      )}

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
  );
}
