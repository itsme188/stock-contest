import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  getContestData: vi.fn(),
  saveContestData: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  buildReportData: vi.fn(() => ({ reportDate: "2026-04-20" })),
  generateCommentary: vi.fn(async () => "mock commentary"),
  sendWeeklyEmail: vi.fn(async () => {}),
}));

vi.mock("@/lib/vital-knowledge", () => ({
  fetchVitalKnowledge: vi.fn(async () => ""),
}));

vi.mock("@/lib/prices", () => ({
  backfillPrices: vi.fn(async () => ({ tickers: 0, daysAdded: 0, errors: [] })),
}));

import { POST } from "./route";
import { getContestData, saveContestData } from "@/lib/db";
import { sendWeeklyEmail } from "@/lib/email";

const FIXED_TODAY = "2026-04-20";

const BASE_DATA = {
  players: [{ id: "p1", name: "Yitzi", color: "#4F46E5" }],
  trades: [],
  contestStartDate: "2026-01-01",
  currentPrices: {},
  priceHistory: {},
  polygonApiKey: "",
  gmailAddress: "me@example.com",
  gmailAppPassword: "pw",
  anthropicApiKey: "sk-ant-x",
  aiModel: "claude-sonnet-4-5-20250929",
  playerEmails: { p1: "y@example.com" },
  lastWeeklyEmailSentDate: "",
};

function postReq(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost:3001/api/email/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/email/weekly — idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${FIXED_TODAY}T15:00:00Z`));
  });

  it("skips the send when lastWeeklyEmailSentDate matches today", async () => {
    vi.mocked(getContestData).mockReturnValue({
      ...BASE_DATA,
      lastWeeklyEmailSentDate: FIXED_TODAY,
    });

    const res = await POST(postReq({}));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("already_sent_today");
    expect(sendWeeklyEmail).not.toHaveBeenCalled();
    expect(saveContestData).not.toHaveBeenCalled();
  });

  it("sends and records the date when flag is empty (never sent)", async () => {
    vi.mocked(getContestData).mockReturnValue({ ...BASE_DATA, lastWeeklyEmailSentDate: "" });

    const res = await POST(postReq({}));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toBeUndefined();
    expect(json.ok).toBe(true);
    expect(sendWeeklyEmail).toHaveBeenCalledTimes(1);
    expect(saveContestData).toHaveBeenCalledWith({ lastWeeklyEmailSentDate: FIXED_TODAY });
  });

  it("sends and records when flag is a previous date", async () => {
    vi.mocked(getContestData).mockReturnValue({ ...BASE_DATA, lastWeeklyEmailSentDate: "2026-04-13" });

    const res = await POST(postReq({}));
    expect(res.status).toBe(200);
    expect(sendWeeklyEmail).toHaveBeenCalledTimes(1);
    expect(saveContestData).toHaveBeenCalledWith({ lastWeeklyEmailSentDate: FIXED_TODAY });
  });

  it("force:true bypasses the same-day guard and re-sends", async () => {
    vi.mocked(getContestData).mockReturnValue({ ...BASE_DATA, lastWeeklyEmailSentDate: FIXED_TODAY });

    const res = await POST(postReq({ force: true }));
    expect(res.status).toBe(200);
    expect(sendWeeklyEmail).toHaveBeenCalledTimes(1);
    expect(saveContestData).toHaveBeenCalledWith({ lastWeeklyEmailSentDate: FIXED_TODAY });
  });

  it("test-send (body.to) bypasses the guard AND does NOT update the flag", async () => {
    vi.mocked(getContestData).mockReturnValue({ ...BASE_DATA, lastWeeklyEmailSentDate: FIXED_TODAY });

    const res = await POST(postReq({ to: "qa@example.com" }));
    expect(res.status).toBe(200);
    expect(sendWeeklyEmail).toHaveBeenCalledTimes(1);
    expect(saveContestData).not.toHaveBeenCalled();
  });
});
