import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  importTrades: vi.fn(),
}));

import { POST } from "./route";
import { importTrades } from "@/lib/db";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3001/api/trades/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_TRADE = {
  id: "t1",
  playerId: "p1",
  type: "buy",
  ticker: "AAPL",
  shares: 100,
  price: 150,
  date: "2026-01-15",
  timestamp: 1736899200000,
};

describe("POST /api/trades/import", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when trades is not an array", async () => {
    const res = await POST(makeRequest({ trades: "not-array" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("array");
  });

  it("returns 400 when any trade has missing fields", async () => {
    const res = await POST(makeRequest({ trades: [{ playerId: "p1" }] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("missing fields");
  });

  it("returns 400 for invalid trade type", async () => {
    const res = await POST(makeRequest({ trades: [{ ...VALID_TRADE, type: "hold" }] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid trade type");
  });

  it("returns 400 for non-positive shares", async () => {
    const res = await POST(makeRequest({ trades: [{ ...VALID_TRADE, shares: -10 }] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid shares");
  });

  it("returns 400 for non-positive price", async () => {
    const res = await POST(makeRequest({ trades: [{ ...VALID_TRADE, price: 0 }] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid price");
  });

  it("returns 400 for invalid date", async () => {
    const res = await POST(makeRequest({ trades: [{ ...VALID_TRADE, date: "not-a-date" }] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid date");
  });

  it("imports valid trades with clear=false", async () => {
    const res = await POST(makeRequest({ trades: [VALID_TRADE], clear: false }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.count).toBe(1);
    expect(vi.mocked(importTrades)).toHaveBeenCalledWith([VALID_TRADE], false);
  });

  it("imports valid trades with clear=true", async () => {
    const res = await POST(makeRequest({ trades: [VALID_TRADE], clear: true }));
    expect(res.status).toBe(200);
    expect(vi.mocked(importTrades)).toHaveBeenCalledWith([VALID_TRADE], true);
  });

  it("defaults clear to false", async () => {
    await POST(makeRequest({ trades: [VALID_TRADE] }));
    expect(vi.mocked(importTrades)).toHaveBeenCalledWith([VALID_TRADE], false);
  });

  it("returns 500 on DB error", async () => {
    vi.mocked(importTrades).mockImplementation(() => { throw new Error("import failed"); });

    const res = await POST(makeRequest({ trades: [VALID_TRADE] }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("import failed");
  });
});
