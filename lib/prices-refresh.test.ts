import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetContestData = vi.fn();
const mockSaveContestData = vi.fn();

vi.mock("@/lib/db", () => ({
  getContestData: (...args: unknown[]) => mockGetContestData(...args),
  saveContestData: (...args: unknown[]) => mockSaveContestData(...args),
}));

// @stoqey/ib loads native-ish deps; not needed for persistPrices tests.
vi.mock("@stoqey/ib", () => ({
  IBApi: class {},
  EventName: {},
  Contract: {},
  SecType: {},
  BarSizeSetting: {},
  WhatToShow: {},
}));

import { persistPrices } from "@/lib/prices-refresh";

describe("persistPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetContestData.mockReturnValue({
      currentPrices: { AAPL: 100 },
      priceHistory: { AAPL: { "2026-06-10": 100 } },
    });
  });

  it("writes each price under its own bar date, not today", () => {
    persistPrices(
      { AAPL: 105 },
      { AAPL: "2026-06-11" }, // prior session's bar (stale /prev response)
      "2026-06-12"
    );
    const saved = mockSaveContestData.mock.calls[0][0];
    expect(saved.priceHistory.AAPL["2026-06-11"]).toBe(105);
    expect(saved.priceHistory.AAPL["2026-06-12"]).toBeUndefined();
  });

  it("still updates currentPrices regardless of bar date", () => {
    persistPrices({ AAPL: 105 }, { AAPL: "2026-06-11" }, "2026-06-12");
    const saved = mockSaveContestData.mock.calls[0][0];
    expect(saved.currentPrices.AAPL).toBe(105);
  });

  it("falls back to today when no bar date is known", () => {
    persistPrices({ AAPL: 105 }, {}, "2026-06-12");
    const saved = mockSaveContestData.mock.calls[0][0];
    expect(saved.priceHistory.AAPL["2026-06-12"]).toBe(105);
  });

  it("preserves existing history entries", () => {
    persistPrices({ AAPL: 105 }, { AAPL: "2026-06-11" }, "2026-06-12");
    const saved = mockSaveContestData.mock.calls[0][0];
    expect(saved.priceHistory.AAPL["2026-06-10"]).toBe(100);
    expect(saved.priceHistory.AAPL["2026-06-11"]).toBe(105);
  });

  it("dispatches per ticker: bar date when known, today otherwise", () => {
    persistPrices(
      { AAPL: 105, GOOG: 200 },
      { AAPL: "2026-06-11" },
      "2026-06-12"
    );
    const saved = mockSaveContestData.mock.calls[0][0];
    expect(saved.priceHistory.AAPL["2026-06-11"]).toBe(105);
    expect(saved.priceHistory.GOOG["2026-06-12"]).toBe(200);
  });
});
