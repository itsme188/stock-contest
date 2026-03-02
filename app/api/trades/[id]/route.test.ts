import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  deleteTrade: vi.fn(),
}));

import { DELETE } from "./route";
import { deleteTrade } from "@/lib/db";

function makeDeleteRequest(id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost:3001/api/trades/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  ];
}

describe("DELETE /api/trades/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 for non-existent trade", async () => {
    vi.mocked(deleteTrade).mockReturnValue(null);

    const [req, ctx] = makeDeleteRequest("nonexistent");
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("not found");
  });

  it("returns 200 for existing trade", async () => {
    vi.mocked(deleteTrade).mockReturnValue({
      id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1,
    });

    const [req, ctx] = makeDeleteRequest("t1");
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("returns 500 on DB error", async () => {
    vi.mocked(deleteTrade).mockImplementation(() => { throw new Error("DB locked"); });

    const [req, ctx] = makeDeleteRequest("t1");
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("DB locked");
  });
});
