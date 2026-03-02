import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  getContestData: vi.fn(),
  saveContestData: vi.fn(),
}));

import { GET, PUT } from "./route";
import { getContestData, saveContestData } from "@/lib/db";

const MOCK_DATA = {
  players: [{ id: "p1", name: "Yitzi", color: "#4F46E5" }],
  trades: [{ id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1 }],
  contestStartDate: "2026-01-01",
  currentPrices: { AAPL: 155 },
  priceHistory: {},
  polygonApiKey: "pk_test",
  gmailAddress: "",
  gmailAppPassword: "",
  anthropicApiKey: "",
  aiModel: "claude-sonnet-4-5-20250929",
  playerEmails: {},
};

describe("GET /api/contest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns contest data", async () => {
    vi.mocked(getContestData).mockReturnValue(MOCK_DATA);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.players).toHaveLength(1);
    expect(json.trades).toHaveLength(1);
    expect(json.contestStartDate).toBe("2026-01-01");
  });

  it("returns 500 on DB error", async () => {
    vi.mocked(getContestData).mockImplementation(() => { throw new Error("DB corrupt"); });

    const res = await GET();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("DB corrupt");
  });
});

describe("PUT /api/contest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("strips trades from request body before saving", async () => {
    const body = {
      players: MOCK_DATA.players,
      trades: MOCK_DATA.trades,
      contestStartDate: "2026-01-01",
      polygonApiKey: "pk_test",
    };

    const req = new Request("http://localhost:3001/api/contest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);

    // saveContestData should NOT receive trades
    const savedData = vi.mocked(saveContestData).mock.calls[0][0];
    expect(savedData).not.toHaveProperty("trades");
    expect(savedData).toHaveProperty("players");
    expect(savedData).toHaveProperty("polygonApiKey");
  });

  it("saves remaining data successfully", async () => {
    const body = { contestStartDate: "2026-02-01", polygonApiKey: "new-key" };

    const req = new Request("http://localhost:3001/api/contest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(vi.mocked(saveContestData)).toHaveBeenCalledWith(body);
  });

  it("returns 500 on DB error", async () => {
    vi.mocked(saveContestData).mockImplementation(() => { throw new Error("disk full"); });

    const req = new Request("http://localhost:3001/api/contest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ polygonApiKey: "key" }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("disk full");
  });
});
