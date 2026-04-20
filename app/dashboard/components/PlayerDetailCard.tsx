import React from "react";
import {
  type Trade,
  type LeaderboardEntry,
  type Period,
  getCurrentPrice,
  getPositionDailyChange,
  getPositionDaysHeld,
  getPeriodReturn,
  formatCurrency,
  formatPercent,
} from "@/lib/contest";

interface PlayerDetailCardProps {
  player: LeaderboardEntry;
  trades: Trade[];
  currentPrices: Record<string, number>;
  priceHistory: Record<string, Record<string, number>>;
  contestStartDate: string;
  selectedPeriod: Period;
}

export default function PlayerDetailCard({
  player,
  trades,
  currentPrices,
  priceHistory,
  contestStartDate,
  selectedPeriod,
}: PlayerDetailCardProps) {
  const periodReturn = getPeriodReturn(
    player.id,
    selectedPeriod,
    trades,
    currentPrices,
    priceHistory,
    contestStartDate
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: player.color }}
          />
          <h3 className="font-semibold text-gray-900">{player.name}</h3>
        </div>
        <div className="text-right">
          <p className="font-semibold text-gray-900">
            {formatCurrency(player.totalValue)}
          </p>
          <div className="flex items-center gap-1.5 justify-end">
            <span
              className={`text-sm font-medium ${player.returnPct >= 0 ? "text-green-600" : "text-red-600"}`}
            >
              {formatPercent(player.returnPct)}
            </span>
            {selectedPeriod !== "ALL" && (
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

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <StatItem label="Cash" value={formatCurrency(player.cashRemaining)} />
        <StatItem
          label="Unrealized P&L"
          value={formatCurrency(player.unrealizedGains)}
          color={player.unrealizedGains >= 0 ? "green" : "red"}
        />
        <StatItem
          label="Realized P&L"
          value={formatCurrency(player.realizedGains)}
          color={player.realizedGains >= 0 ? "green" : "red"}
        />
        <StatItem
          label="Realized Losses"
          value={formatCurrency(player.realizedLosses)}
          color={player.realizedLosses < 0 ? "red" : undefined}
        />
        <StatItem
          label="Win Rate"
          value={`${player.winRate.toFixed(0)}% (${player.winningTrades}W-${player.losingTrades}L)`}
        />
        <StatItem
          label="Sharpe Ratio"
          value={
            player.sharpeRatio != null ? player.sharpeRatio.toFixed(2) : "—"
          }
          color={
            player.sharpeRatio != null
              ? player.sharpeRatio >= 0
                ? "green"
                : "red"
              : undefined
          }
        />
      </div>

      {/* Best/Worst Trades */}
      {(player.bestTrade || player.worstTrade) && (
        <div className="grid grid-cols-2 gap-3 mb-4 pt-3 border-t border-gray-100">
          {player.bestTrade && (
            <div className="text-sm">
              <span className="text-gray-500">Best</span>
              <span className="ml-1.5 font-medium text-green-600">
                {player.bestTrade.ticker} ({formatPercent(player.bestTrade.gainPct)})
              </span>
            </div>
          )}
          {player.worstTrade && (
            <div className="text-sm">
              <span className="text-gray-500">Worst</span>
              <span className="ml-1.5 font-medium text-red-600">
                {player.worstTrade.ticker} ({formatPercent(player.worstTrade.gainPct)})
              </span>
            </div>
          )}
        </div>
      )}

      {/* Open Positions */}
      {player.positions.length > 0 && (
        <div className="pt-3 border-t border-gray-100">
          <p className="text-sm font-medium text-gray-700 mb-2">
            Open Positions ({player.positions.length}/5)
          </p>
          <div className="space-y-2">
            {player.positions.map((pos) => {
              const price = getCurrentPrice(pos.ticker, currentPrices, trades);
              const marketValue = pos.shares * price;
              const gain = marketValue - pos.totalCost;
              const gainPct = pos.totalCost !== 0 ? (gain / pos.totalCost) * 100 : 0;
              const weight = player.portfolioValue > 0
                ? (marketValue / player.portfolioValue) * 100
                : 0;
              const dailyChange = getPositionDailyChange(pos.ticker, price, priceHistory);
              const daysHeld = getPositionDaysHeld(pos);

              return (
                <div key={pos.ticker} className="bg-gray-50 rounded-lg px-3 py-2">
                  {/* Row 1: Ticker, Market Value, Return */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-gray-900">{pos.ticker}</span>
                      <span className="text-xs text-gray-400">{weight.toFixed(0)}%</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-gray-900">
                        {formatCurrency(marketValue)}
                      </span>
                      <span className={`text-sm font-semibold ${gain >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {formatPercent(gainPct)}
                      </span>
                    </div>
                  </div>
                  {/* Row 2: Details */}
                  <div className="flex items-center justify-between mt-0.5 text-xs text-gray-500">
                    <span>
                      {pos.shares.toLocaleString()} shares @ {formatCurrency(pos.avgCost)} &rarr; {formatCurrency(price)}
                    </span>
                    <span className="flex items-center gap-2">
                      {dailyChange ? (
                        <span className={dailyChange.changeDollar >= 0 ? "text-green-600" : "text-red-600"}>
                          {dailyChange.changePct >= 0 ? "+" : ""}{dailyChange.changePct.toFixed(1)}% today
                        </span>
                      ) : null}
                      <span>{daysHeld}d</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatItem({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: "green" | "red";
}) {
  const colorClass = color === "green"
    ? "text-green-600"
    : color === "red"
      ? "text-red-600"
      : "text-gray-900";

  return (
    <div className="bg-gray-50 rounded-lg p-2.5">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-sm font-semibold ${colorClass}`}>{value}</p>
    </div>
  );
}
