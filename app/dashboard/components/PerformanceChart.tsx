import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { type Player, type Period, getPeriodStartDate } from "@/lib/contest";

interface PerformanceChartProps {
  chartData: Record<string, string>[];
  players: Player[];
  selectedPeriod: Period;
  contestStartDate: string;
  hasBenchmark: boolean;
}

export default function PerformanceChart({
  chartData,
  players,
  selectedPeriod,
  contestStartDate,
  hasBenchmark,
}: PerformanceChartProps) {
  if (chartData.length === 0) return null;

  // Filter chart data to the selected period's date range
  const periodStart = getPeriodStartDate(selectedPeriod, contestStartDate);
  const filteredData = chartData.filter((d) => d.date >= periodStart);

  if (filteredData.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Performance Over Time
      </h2>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={filteredData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12, fill: "#9CA3AF" }}
              tickFormatter={(date: string) =>
                new Date(date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })
              }
            />
            <YAxis
              tick={{ fontSize: 12, fill: "#9CA3AF" }}
              tickFormatter={(value: number) => `${value}%`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#fff",
                border: "1px solid #E5E7EB",
                borderRadius: 8,
                fontSize: 13,
                boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
              }}
              formatter={(value) => [`${Number(value).toFixed(2)}%`, ""]}
              labelFormatter={(date) =>
                new Date(date).toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })
              }
            />
            <Legend
              iconType="line"
              wrapperStyle={{ fontSize: 13, paddingTop: 8 }}
            />
            {/* 0% breakeven reference line */}
            <ReferenceLine y={0} stroke="#D1D5DB" strokeWidth={1} />
            {/* S&P 500 benchmark — render first so player lines draw on top */}
            {hasBenchmark && (
              <Line
                type="monotone"
                dataKey="S&P 500"
                stroke="#6366F1"
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                strokeOpacity={0.6}
              />
            )}
            {players.map((player) => (
              <Line
                key={player.id}
                type="monotone"
                dataKey={player.name}
                stroke={player.color}
                strokeWidth={2.5}
                dot={{ fill: player.color, strokeWidth: 0, r: 2.5 }}
                activeDot={{ r: 5, strokeWidth: 2, stroke: "#fff" }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
