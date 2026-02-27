import {
  type Player,
  type Trade,
  type TradeForm,
  DEFAULT_POSITION_SIZE,
  getOpenPositionCount,
  getPlayerPositions,
  getPlayerStats,
  formatCurrency,
} from "@/lib/contest";

interface TradesTabProps {
  players: Player[];
  trades: Trade[];
  currentPrices: Record<string, number>;
  tradeForm: TradeForm;
  setTradeForm: React.Dispatch<React.SetStateAction<TradeForm>>;
  showAddTrade: boolean;
  setShowAddTrade: (show: boolean) => void;
  priceError: string;
  addTrade: () => void;
  deleteTrade: (id: string) => void;
  fetchingPrice: boolean;
  fetchPriceAndCalculateShares: () => void;
}

export default function TradesTab({
  players,
  trades,
  currentPrices,
  tradeForm,
  setTradeForm,
  showAddTrade,
  setShowAddTrade,
  priceError,
  addTrade,
  deleteTrade,
  fetchingPrice,
  fetchPriceAndCalculateShares,
}: TradesTabProps) {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-gray-900">Trade History</h2>
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
                      {p.name} ({getOpenPositionCount(p.id, trades)}/5
                      positions)
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
                    Historical date - will fetch opening price for this date
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Ticker Symbol
                </label>
                {tradeForm.type === "sell" && tradeForm.playerId ? (
                  <select
                    value={tradeForm.ticker}
                    onChange={(e) =>
                      setTradeForm({
                        ...tradeForm,
                        ticker: e.target.value,
                        price: "",
                        shares: "",
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Select position to sell</option>
                    {getPlayerPositions(tradeForm.playerId, trades).map((pos) => (
                      <option key={pos.ticker} value={pos.ticker}>
                        {pos.ticker} ({pos.shares} shares @ {formatCurrency(pos.avgCost)})
                      </option>
                    ))}
                  </select>
                ) : (
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
                )}
              </div>

              {/* Quick action buttons */}
              <div className="space-y-2">
                <button
                  onClick={fetchPriceAndCalculateShares}
                  disabled={!tradeForm.ticker || fetchingPrice}
                  className="w-full py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {fetchingPrice ? "Fetching..." : "Fetch Price & Calculate Shares"}
                </button>
                {tradeForm.ticker && (
                  <button
                    onClick={() => {
                      const ticker = tradeForm.ticker.toUpperCase();
                      const url = `https://finance.yahoo.com/quote/${ticker}/history/`;
                      window.open(url, "_blank");
                    }}
                    className="w-full py-2 text-sm font-medium bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    View on Yahoo Finance ↗
                  </button>
                )}
                {tradeForm.type === "sell" && tradeForm.playerId && tradeForm.ticker && (() => {
                  const positions = getPlayerPositions(tradeForm.playerId, trades);
                  const position = positions.find(p => p.ticker === tradeForm.ticker.toUpperCase());
                  if (position) {
                    return (
                      <button
                        onClick={() =>
                          setTradeForm((prev) => ({
                            ...prev,
                            shares: position.shares.toString(),
                          }))
                        }
                        className="w-full py-2 text-sm font-medium bg-red-50 text-red-700 rounded-lg hover:bg-red-100 transition-colors"
                      >
                        Sell All {position.shares} shares
                      </button>
                    );
                  }
                  return null;
                })()}
              </div>
              {tradeForm.price && !tradeForm.shares && tradeForm.playerId && (() => {
                const price = parseFloat(tradeForm.price);
                if (price <= 0) return null;
                if (tradeForm.type === "sell") {
                  const positions = getPlayerPositions(tradeForm.playerId, trades);
                  const position = positions.find(p => p.ticker === tradeForm.ticker.toUpperCase());
                  if (position) {
                    return (
                      <button
                        onClick={() =>
                          setTradeForm((prev) => ({ ...prev, shares: position.shares.toString() }))
                        }
                        className="w-full py-2 text-sm font-medium bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition-colors"
                      >
                        Calculate: Sell all {position.shares} shares
                      </button>
                    );
                  }
                } else {
                  const stats = getPlayerStats(tradeForm.playerId, trades, currentPrices);
                  const budget = Math.min(DEFAULT_POSITION_SIZE, stats.cashRemaining);
                  const shares = Math.floor(budget / price);
                  return (
                    <button
                      onClick={() =>
                        setTradeForm((prev) => ({ ...prev, shares: shares.toString() }))
                      }
                      className="w-full py-2 text-sm font-medium bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition-colors"
                    >
                      Calculate: {shares} shares ({formatCurrency(budget)} budget)
                    </button>
                  );
                }
                return null;
              })()}
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
  );
}
