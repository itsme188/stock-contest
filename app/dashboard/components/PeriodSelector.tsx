import React from "react";
import { type Period } from "@/lib/contest";

interface PeriodSelectorProps {
  selected: Period;
  onChange: (period: Period) => void;
}

const PERIODS: { value: Period; label: string }[] = [
  { value: "1D", label: "1D" },
  { value: "1W", label: "1W" },
  { value: "1M", label: "1M" },
  { value: "YTD", label: "YTD" },
  { value: "ALL", label: "All" },
];

export default function PeriodSelector({ selected, onChange }: PeriodSelectorProps) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
      {PERIODS.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
            selected === value
              ? "bg-white text-blue-600 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
