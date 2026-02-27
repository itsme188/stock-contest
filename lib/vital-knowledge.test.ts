import { describe, it, expect, vi, beforeEach } from "vitest";
import { stripHtml, findPart, fetchVitalKnowledge } from "@/lib/vital-knowledge";
import type { MessageStructureObject } from "imapflow";

// ---------- Mock imapflow ----------

const mockSearch = vi.fn();
const mockFetchOne = vi.fn();
const mockDownload = vi.fn();
const mockConnect = vi.fn();
const mockLogout = vi.fn();
const mockLockRelease = vi.fn();
const mockGetMailboxLock = vi.fn();

vi.mock("imapflow", () => {
  return {
    ImapFlow: class {
      connect = mockConnect;
      logout = mockLogout;
      getMailboxLock = mockGetMailboxLock;
      search = mockSearch;
      fetchOne = mockFetchOne;
      download = mockDownload;
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockLogout.mockResolvedValue(undefined);
  mockLockRelease.mockReturnValue(undefined);
  mockGetMailboxLock.mockResolvedValue({ release: mockLockRelease });
});

// ---------- stripHtml ----------

describe("stripHtml", () => {
  it("removes HTML tags", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("removes style blocks", () => {
    expect(stripHtml('<style type="text/css">body{color:red}</style>Text')).toBe(
      "Text"
    );
  });

  it("removes script blocks", () => {
    expect(stripHtml("<script>alert(1)</script>Content")).toBe("Content");
  });

  it("decodes common entities", () => {
    expect(stripHtml("A&amp;B &lt;C&gt; D&nbsp;E")).toBe("A&B <C> D E");
  });

  it("collapses whitespace", () => {
    expect(stripHtml("  Hello   world  \n\n  foo  ")).toBe("Hello world foo");
  });

  it("handles empty string", () => {
    expect(stripHtml("")).toBe("");
  });
});

// ---------- findPart ----------

describe("findPart", () => {
  it("finds text/plain at root level", () => {
    const node: MessageStructureObject = { type: "text/plain", part: "1", size: 100 };
    expect(findPart(node, "text/plain")).toBe("1");
  });

  it("finds text/plain in multipart structure", () => {
    const node: MessageStructureObject = {
      type: "multipart/alternative",
      part: undefined,
      size: 0,
      childNodes: [
        { type: "text/plain", part: "1", size: 100 },
        { type: "text/html", part: "2", size: 200 },
      ],
    };
    expect(findPart(node, "text/plain")).toBe("1");
    expect(findPart(node, "text/html")).toBe("2");
  });

  it("finds nested part in deep structure", () => {
    const node: MessageStructureObject = {
      type: "multipart/mixed",
      part: undefined,
      size: 0,
      childNodes: [
        {
          type: "multipart/alternative",
          part: undefined,
          size: 0,
          childNodes: [
            { type: "text/plain", part: "1.1", size: 100 },
            { type: "text/html", part: "1.2", size: 200 },
          ],
        },
        { type: "application/pdf", part: "2", size: 5000 },
      ],
    };
    expect(findPart(node, "text/plain")).toBe("1.1");
  });

  it("returns null when part type not found", () => {
    const node: MessageStructureObject = { type: "text/html", part: "1", size: 100 };
    expect(findPart(node, "text/plain")).toBeNull();
  });

  it("returns null for empty multipart", () => {
    const node: MessageStructureObject = {
      type: "multipart/alternative",
      part: undefined,
      size: 0,
      childNodes: [],
    };
    expect(findPart(node, "text/plain")).toBeNull();
  });
});

// ---------- fetchVitalKnowledge ----------

function makeMsg(uid: number, subject: string, date: string, bodyStructure: MessageStructureObject) {
  return {
    uid,
    seq: uid,
    envelope: { subject, date },
    bodyStructure,
  };
}

function makeTextDownload(text: string) {
  const readable = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
  return { content: readable, meta: { expectedSize: text.length, contentType: "text/plain" } };
}

const plainStructure: MessageStructureObject = {
  type: "multipart/alternative",
  size: 0,
  childNodes: [
    { type: "text/plain", part: "1", size: 100 },
    { type: "text/html", part: "2", size: 200 },
  ],
};

const htmlOnlyStructure: MessageStructureObject = {
  type: "text/html",
  part: "1",
  size: 200,
};

describe("fetchVitalKnowledge", () => {
  it("returns empty string when gmail credentials are missing", async () => {
    expect(await fetchVitalKnowledge("", "pass")).toBe("");
    expect(await fetchVitalKnowledge("user@gmail.com", "")).toBe("");
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("returns empty string when no VK emails found", async () => {
    mockSearch.mockResolvedValue([]);
    const result = await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(result).toBe("");
  });

  it("returns empty string when search returns false", async () => {
    mockSearch.mockResolvedValue(false);
    const result = await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(result).toBe("");
  });

  it("returns empty string on connection failure", async () => {
    mockConnect.mockRejectedValue(new Error("IMAP auth failed"));
    const result = await fetchVitalKnowledge("user@gmail.com", "badpass");
    expect(result).toBe("");
  });

  it("fetches and formats VK emails", async () => {
    mockSearch.mockResolvedValue([101]);
    mockFetchOne.mockResolvedValue(
      makeMsg(101, "VK Morning Note", "2026-02-20T09:00:00Z", plainStructure)
    );
    mockDownload.mockResolvedValue(makeTextDownload("Markets rallied on strong earnings."));

    const result = await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(result).toContain("[2026-02-20]");
    expect(result).toContain("VK Morning Note");
    expect(result).toContain("Markets rallied on strong earnings.");
  });

  it("sorts multiple emails chronologically", async () => {
    mockSearch.mockResolvedValue([102, 101]);
    mockFetchOne
      .mockResolvedValueOnce(
        makeMsg(102, "Wednesday Note", "2026-02-19T09:00:00Z", plainStructure)
      )
      .mockResolvedValueOnce(
        makeMsg(101, "Monday Note", "2026-02-17T09:00:00Z", plainStructure)
      );
    mockDownload
      .mockResolvedValueOnce(makeTextDownload("Wednesday content"))
      .mockResolvedValueOnce(makeTextDownload("Monday content"));

    const result = await fetchVitalKnowledge("user@gmail.com", "pass123");
    const mondayIdx = result.indexOf("Monday");
    const wednesdayIdx = result.indexOf("Wednesday");
    expect(mondayIdx).toBeLessThan(wednesdayIdx);
  });

  it("falls back to text/html and strips tags", async () => {
    mockSearch.mockResolvedValue([103]);
    mockFetchOne.mockResolvedValue(
      makeMsg(103, "HTML Only", "2026-02-20T09:00:00Z", htmlOnlyStructure)
    );
    mockDownload.mockResolvedValue(
      makeTextDownload("<p>Strong <b>rally</b> in tech.</p>")
    );

    const result = await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(result).toContain("Strong rally in tech.");
    expect(result).not.toContain("<p>");
  });

  it("truncates individual emails exceeding per-email limit", async () => {
    const longBody = "A".repeat(4000);
    mockSearch.mockResolvedValue([104]);
    mockFetchOne.mockResolvedValue(
      makeMsg(104, "Long Note", "2026-02-20T09:00:00Z", plainStructure)
    );
    mockDownload.mockResolvedValue(makeTextDownload(longBody));

    const result = await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(result).toContain("...[truncated]");
    expect(result.length).toBeLessThan(4000);
  });

  it("truncates total output exceeding total limit", async () => {
    const body = "B".repeat(2500);
    const uids = [101, 102, 103, 104, 105];
    mockSearch.mockResolvedValue(uids);

    for (let i = 0; i < uids.length; i++) {
      mockFetchOne.mockResolvedValueOnce(
        makeMsg(uids[i], `Note ${i}`, `2026-02-${17 + i}T09:00:00Z`, plainStructure)
      );
      mockDownload.mockResolvedValueOnce(makeTextDownload(body));
    }

    const result = await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(result.length).toBeLessThanOrEqual(8000 + "\n...[truncated]".length);
  });

  it("limits to 5 most recent emails", async () => {
    const uids = [1, 2, 3, 4, 5, 6, 7];
    mockSearch.mockResolvedValue(uids);

    for (let i = 0; i < 5; i++) {
      mockFetchOne.mockResolvedValueOnce(
        makeMsg(uids[2 + i], `Note`, `2026-02-${20 + i}T09:00:00Z`, plainStructure)
      );
      mockDownload.mockResolvedValueOnce(makeTextDownload("Content"));
    }

    await fetchVitalKnowledge("user@gmail.com", "pass123");
    // Should only fetch the last 5 UIDs (3,4,5,6,7), not all 7
    expect(mockFetchOne).toHaveBeenCalledTimes(5);
  });

  it("skips messages with no body structure", async () => {
    mockSearch.mockResolvedValue([105]);
    mockFetchOne.mockResolvedValue({ uid: 105, seq: 105, envelope: { subject: "Bad" } });

    const result = await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(result).toBe("");
  });

  it("always releases lock and logs out", async () => {
    mockSearch.mockRejectedValue(new Error("search failed"));

    await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(mockLockRelease).toHaveBeenCalled();
    expect(mockLogout).toHaveBeenCalled();
  });
});
