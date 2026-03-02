import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock IBApi as a class (arrow functions aren't constructors)
class MockIBApi {
  handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  connectCalled = false;
  reqHistoricalDataCalled = false;
  lastReqArgs: unknown[] = [];

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
    // Auto-emit connected on next tick
    setTimeout(() => this.emit("connected"), 0);
  }

  reqHistoricalData(...args: unknown[]) {
    this.reqHistoricalDataCalled = true;
    this.lastReqArgs = args;
  }

  disconnect() {}
}

// Track the latest mock instance so tests can control it
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
}));

vi.mock("@/lib/db", () => ({
  getContestData: vi.fn(),
}));

import { NextRequest } from "next/server";
import { GET } from "./route";
import { getContestData } from "@/lib/db";

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:3001/api/prices");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

describe("GET /api/prices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getContestData).mockReturnValue({
      polygonApiKey: "test-key",
      trades: [],
      players: [],
      contestStartDate: "2026-01-01",
      currentPrices: {},
      priceHistory: {},
      gmailAddress: "",
      gmailAppPassword: "",
      anthropicApiKey: "",
      aiModel: "",
      playerEmails: {},
    });
  });

  it("returns 400 when ticker is missing", async () => {
    const res = await GET(makeRequest({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("ticker");
  });

  it("returns price from IBKR when TWS is available (no date = close price)", async () => {
    const promise = GET(makeRequest({ ticker: "AAPL" }));

    // Wait for connect to fire
    await new Promise((r) => setTimeout(r, 10));

    // Simulate IBKR returning a bar then finishing
    mockIBApiInstance.emit("historicalData", 1, "20260302", 149.5, 151.0, 148.0, 150.75);
    mockIBApiInstance.emit("historicalData", 1, "finished-123");

    const res = await promise;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.price).toBe(150.75); // close price
    expect(json.source).toBe("ibkr");
    expect(json.date).toBe("2026-03-02");
  });

  it("returns open price from IBKR for historical date", async () => {
    const promise = GET(makeRequest({ ticker: "AAPL", date: "2026-02-10" }));

    await new Promise((r) => setTimeout(r, 10));

    // Simulate bars: Feb 10 is a trading day
    mockIBApiInstance.emit("historicalData", 1, "20260210", 145.0, 147.0, 144.0, 146.5);
    mockIBApiInstance.emit("historicalData", 1, "20260211", 146.5, 148.0, 146.0, 147.0);
    mockIBApiInstance.emit("historicalData", 1, "finished-123");

    const res = await promise;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.price).toBe(145.0); // open price of the target date
    expect(json.source).toBe("ibkr");
    expect(json.date).toBe("2026-02-10");
    expect(json.actualDate).toBeUndefined();
  });

  it("skips weekends and returns next trading day open from IBKR", async () => {
    // Request Saturday Feb 7
    const promise = GET(makeRequest({ ticker: "AAPL", date: "2026-02-07" }));

    await new Promise((r) => setTimeout(r, 10));

    // IBKR only returns trading days — Feb 6 (Fri) and Feb 9 (Mon)
    mockIBApiInstance.emit("historicalData", 1, "20260206", 142.0, 143.0, 141.0, 142.5);
    mockIBApiInstance.emit("historicalData", 1, "20260209", 143.0, 144.5, 142.5, 144.0);
    mockIBApiInstance.emit("historicalData", 1, "finished-123");

    const res = await promise;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.price).toBe(143.0); // open of Feb 9 (first day >= Feb 7)
    expect(json.date).toBe("2026-02-09");
    expect(json.actualDate).toBe("2026-02-09"); // different from requested date
  });

  it("falls back to Polygon when IBKR connection fails", async () => {
    // Make IBKR fail by emitting connection error
    const originalConnect = MockIBApi.prototype.connect;
    MockIBApi.prototype.connect = function () {
      this.connectCalled = true;
      setTimeout(() => this.emit("error", new Error("Connection refused"), 502, -1), 0);
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        results: [{ c: 150.25, t: 1709337600000 }],
      }))
    );

    const res = await GET(makeRequest({ ticker: "AAPL" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.price).toBe(150.25);
    expect(json.source).toBe("polygon");

    fetchSpy.mockRestore();
    MockIBApi.prototype.connect = originalConnect;
  });

  it("returns 503 when both IBKR and Polygon are unavailable", async () => {
    // IBKR fails
    const originalConnect = MockIBApi.prototype.connect;
    MockIBApi.prototype.connect = function () {
      this.connectCalled = true;
      setTimeout(() => this.emit("error", new Error("Connection refused"), 502, -1), 0);
    };

    // No Polygon key
    vi.mocked(getContestData).mockReturnValue({
      polygonApiKey: "",
      trades: [],
      players: [],
      contestStartDate: "2026-01-01",
      currentPrices: {},
      priceHistory: {},
      gmailAddress: "",
      gmailAppPassword: "",
      anthropicApiKey: "",
      aiModel: "",
      playerEmails: {},
    });

    const res = await GET(makeRequest({ ticker: "AAPL" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("IBKR TWS unavailable");
    expect(json.error).toContain("Polygon");

    MockIBApi.prototype.connect = originalConnect;
  });

  it("uppercases ticker parameter", async () => {
    const promise = GET(makeRequest({ ticker: "aapl" }));

    await new Promise((r) => setTimeout(r, 10));

    mockIBApiInstance.emit("historicalData", 1, "20260302", 149.5, 151.0, 148.0, 150.75);
    mockIBApiInstance.emit("historicalData", 1, "finished-123");

    const res = await promise;
    const json = await res.json();
    expect(json.price).toBe(150.75);
  });

  it("falls back to Polygon for historical date when IBKR fails", async () => {
    // Make IBKR fail
    const originalConnect = MockIBApi.prototype.connect;
    MockIBApi.prototype.connect = function () {
      this.connectCalled = true;
      setTimeout(() => this.emit("error", new Error("Connection refused"), 502, -1), 0);
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "OK",
        open: 145.5,
        close: 146.0,
      }))
    );

    const res = await GET(makeRequest({ ticker: "AAPL", date: "2026-02-10" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.price).toBe(145.5); // Polygon returns open price
    expect(json.source).toBe("polygon");

    fetchSpy.mockRestore();
    MockIBApi.prototype.connect = originalConnect;
  });
});
