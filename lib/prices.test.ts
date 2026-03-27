import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock IBApi ---

class MockIBApi {
  handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  connectCalled = false;
  disconnectCalled = false;

  on(event: string, handler: (...args: unknown[]) => void) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
    return this;
  }

  off(event: string, handler: (...args: unknown[]) => void) {
    if (this.handlers[event]) {
      this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
    }
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    (this.handlers[event] || []).forEach((h) => h(...args));
  }

  connect() {
    this.connectCalled = true;
    setTimeout(() => this.emit("connected"), 0);
  }

  reqHistoricalData(reqId: number) {
    // Emit sample bars then "finished" on next tick
    setTimeout(() => {
      this.emit("historicalData", reqId, "20260325", 100, 110, 95, 105);
      this.emit("historicalData", reqId, "20260326", 105, 115, 100, 112);
      this.emit("historicalData", reqId, "finished-123");
    }, 0);
  }

  disconnect() {
    this.disconnectCalled = true;
  }
}

let mockIBApiInstance: MockIBApi;

vi.mock("@stoqey/ib", () => ({
  IBApi: class {
    constructor() {
      mockIBApiInstance = new MockIBApi();
      return mockIBApiInstance;
    }
  },
  EventName: {
    connected: "connected",
    historicalData: "historicalData",
    error: "error",
  },
  SecType: { STK: "STK" },
  BarSizeSetting: { DAYS_ONE: "1 day" },
  WhatToShow: { TRADES: "TRADES" },
  Contract: {},
}));

vi.mock("@/lib/db", () => ({
  getContestData: vi.fn(),
  saveContestData: vi.fn(),
}));

// Mock global fetch for Polygon tests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { backfillPrices } from "./prices";
import { getContestData, saveContestData } from "@/lib/db";

const baseContestData = {
  players: [{ id: "p1", name: "Test", color: "#000", startingCash: 100000 }],
  trades: [
    { id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 10, price: 150, date: "2026-01-15", timestamp: 1 },
  ],
  contestStartDate: "2026-01-14",
  currentPrices: { AAPL: 155 },
  priceHistory: {} as Record<string, Record<string, number>>,
  polygonApiKey: "test-key",
  gmailAddress: "",
  gmailAppPassword: "",
  anthropicApiKey: "",
  aiModel: "",
  playerEmails: {},
};

describe("backfillPrices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it("returns early when no tickers exist", async () => {
    vi.mocked(getContestData).mockReturnValue({
      ...baseContestData,
      trades: [],
    });

    const result = await backfillPrices();
    expect(result.tickers).toBe(0);
    expect(result.daysAdded).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("uses IBKR as primary source and saves price history", async () => {
    vi.mocked(getContestData).mockReturnValue({ ...baseContestData });

    const result = await backfillPrices();

    expect(result.tickers).toBe(1);
    expect(result.daysAdded).toBe(2); // two bars emitted
    expect(result.errors).toEqual([]);
    expect(vi.mocked(saveContestData)).toHaveBeenCalledWith(
      expect.objectContaining({
        priceHistory: expect.objectContaining({
          AAPL: expect.objectContaining({
            "2026-03-25": 105,
            "2026-03-26": 112,
          }),
        }),
      })
    );
  });

  it("does not overwrite existing price history entries", async () => {
    vi.mocked(getContestData).mockReturnValue({
      ...baseContestData,
      priceHistory: { AAPL: { "2026-03-25": 999 } },
    });

    const result = await backfillPrices();

    // Only 1 new day added (2026-03-26), not 2
    expect(result.daysAdded).toBe(1);
    // Verify the existing entry was preserved
    const savedCall = vi.mocked(saveContestData).mock.calls[0][0];
    expect(savedCall.priceHistory!.AAPL["2026-03-25"]).toBe(999);
  });

  it("falls back to Polygon when IBKR connection fails", async () => {
    // Override IBApi to simulate connection failure
    vi.mocked(getContestData).mockReturnValue({ ...baseContestData });

    // Make IBKR connect emit error 502 instead of "connected"
    const origConnect = MockIBApi.prototype.connect;
    MockIBApi.prototype.connect = function () {
      this.connectCalled = true;
      setTimeout(() => this.emit("error", new Error("Connection refused"), 502, -1), 0);
    };

    // Mock Polygon response
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { t: new Date("2026-03-25").getTime(), c: 150.5 },
          { t: new Date("2026-03-26").getTime(), c: 152.0 },
        ],
      }),
    });

    const result = await backfillPrices();

    expect(result.tickers).toBe(1);
    expect(result.daysAdded).toBe(2);
    expect(mockFetch).toHaveBeenCalled();

    // Restore original connect
    MockIBApi.prototype.connect = origConnect;
  });

  it("returns error when both IBKR and Polygon unavailable", async () => {
    vi.mocked(getContestData).mockReturnValue({
      ...baseContestData,
      polygonApiKey: "", // No Polygon key
    });

    // Make IBKR fail
    const origConnect = MockIBApi.prototype.connect;
    MockIBApi.prototype.connect = function () {
      this.connectCalled = true;
      setTimeout(() => this.emit("error", new Error("Connection refused"), 502, -1), 0);
    };

    const result = await backfillPrices();

    expect(result.tickers).toBe(0);
    expect(result.errors).toContainEqual(expect.stringContaining("No price source"));

    MockIBApi.prototype.connect = origConnect;
  });
});

describe("IBKR warning codes >= 2000", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips warning codes and still resolves with data", async () => {
    vi.mocked(getContestData).mockReturnValue({ ...baseContestData });

    // Override reqHistoricalData to emit a warning code then data
    const origReq = MockIBApi.prototype.reqHistoricalData;
    MockIBApi.prototype.reqHistoricalData = function (reqId: number) {
      setTimeout(() => {
        // Emit warning 2174 (timezone format) — should be ignored
        this.emit("error", new Error("Timezone format warning"), 2174, reqId);
        // Then emit valid data
        this.emit("historicalData", reqId, "20260327", 100, 110, 95, 108);
        this.emit("historicalData", reqId, "finished-456");
      }, 0);
    };

    const result = await backfillPrices();

    expect(result.tickers).toBe(1);
    expect(result.daysAdded).toBe(1);
    expect(result.errors).toEqual([]);

    const savedCall = vi.mocked(saveContestData).mock.calls[0][0];
    expect(savedCall.priceHistory!.AAPL["2026-03-27"]).toBe(108);

    MockIBApi.prototype.reqHistoricalData = origReq;
  });

  it("rejects on real error codes < 2000", async () => {
    vi.mocked(getContestData).mockReturnValue({ ...baseContestData });

    const origReq = MockIBApi.prototype.reqHistoricalData;
    MockIBApi.prototype.reqHistoricalData = function (reqId: number) {
      setTimeout(() => {
        // Emit real error code 162 (Historical data request cancelled)
        this.emit("error", new Error("Historical data request cancelled"), 162, reqId);
      }, 0);
    };

    const result = await backfillPrices();

    // Should have an error for AAPL
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("AAPL");
    expect(result.errors[0]).toContain("162");

    MockIBApi.prototype.reqHistoricalData = origReq;
  });
});
