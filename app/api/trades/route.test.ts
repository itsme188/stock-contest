import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  getAllTrades: vi.fn(),
  insertTrade: vi.fn(),
  getContestData: vi.fn(),
}));

vi.mock("@/lib/contest", () => ({
  validateTrade: vi.fn(),
}));

import { GET, POST } from "./route";
import { getAllTrades, insertTrade, getContestData } from "@/lib/db";
import { validateTrade } from "@/lib/contest";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3001/api/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  playerId: "p1",
  type: "buy",
  ticker: "aapl",
  shares: 100,
  price: 150,
  date: "2026-01-15",
};

describe("GET /api/trades", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all trades", async () => {
    const mockTrades = [{ id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1 }];
    vi.mocked(getAllTrades).mockReturnValue(mockTrades);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.trades).toEqual(mockTrades);
  });

  it("returns 500 on DB error", async () => {
    vi.mocked(getAllTrades).mockImplementation(() => { throw new Error("DB crashed"); });

    const res = await GET();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("DB crashed");
  });
});

describe("POST /api/trades", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getContestData).mockReturnValue({
      trades: [],
      players: [],
      contestStartDate: "2026-01-01",
      currentPrices: {},
      priceHistory: {},
      polygonApiKey: "",
      gmailAddress: "",
      gmailAppPassword: "",
      anthropicApiKey: "",
      aiModel: "",
      playerEmails: {},
    });
    vi.mocked(validateTrade).mockReturnValue({ valid: true });
    vi.mocked(insertTrade).mockImplementation((trade) => ({
      id: "generated-uuid",
      ...trade,
    }));
  });

  it("returns 400 for missing required fields", async () => {
    const res = await POST(makeRequest({ playerId: "p1" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Missing required fields");
  });

  it("returns 400 for invalid type", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, type: "hold" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("buy");
  });

  it("returns 400 for non-numeric shares", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, shares: "lots" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for shares <= 0", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, shares: 0 }));
    expect(res.status).toBe(400);

    const res2 = await POST(makeRequest({ ...VALID_BODY, shares: -10 }));
    expect(res2.status).toBe(400);
  });

  it("returns 400 for non-numeric price", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, price: "expensive" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for price <= 0", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, price: 0 }));
    expect(res.status).toBe(400);

    const res2 = await POST(makeRequest({ ...VALID_BODY, price: -5 }));
    expect(res2.status).toBe(400);
  });

  it("returns 400 for invalid date (NaN timestamp regression)", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, date: "banana" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid date");

    // insertTrade should never be called with NaN
    expect(vi.mocked(insertTrade)).not.toHaveBeenCalled();
  });

  it("uppercases ticker before saving", async () => {
    await POST(makeRequest(VALID_BODY));
    expect(vi.mocked(insertTrade)).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: "AAPL" })
    );
  });

  it("returns 400 when validateTrade fails", async () => {
    vi.mocked(validateTrade).mockReturnValue({ valid: false, error: "Max 5 positions" });

    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Max 5 positions");
  });

  it("returns 200 with trade on success", async () => {
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.trade).toBeDefined();
    expect(json.trade.id).toBe("generated-uuid");
    expect(json.trade.ticker).toBe("AAPL");
  });

  it("passes correct timestamp from date", async () => {
    await POST(makeRequest(VALID_BODY));
    const expectedTimestamp = new Date("2026-01-15").getTime();
    expect(vi.mocked(insertTrade)).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: expectedTimestamp })
    );
  });

  it("returns 500 on DB error during insert", async () => {
    vi.mocked(insertTrade).mockImplementation(() => { throw new Error("disk full"); });

    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("disk full");
  });
});
