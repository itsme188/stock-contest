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
    // MAX_CHARS_PER_EMAIL is now 8000; use a body well above that.
    const longBody = "A".repeat(9000);
    mockSearch.mockResolvedValue([104]);
    mockFetchOne.mockResolvedValue(
      makeMsg(104, "Long Note", "2026-02-20T09:00:00Z", plainStructure)
    );
    mockDownload.mockResolvedValue(makeTextDownload(longBody));

    const result = await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(result).toContain("...[truncated]");
    expect(result.length).toBeLessThan(longBody.length);
  });

  it("fetches only the most recent recap (limit 1)", async () => {
    // Phase 8 (2026-05-08): the user asked for the Friday weekly-recap
    // email only, not aggregated daily notes. fetchVitalKnowledge now
    // limits to MAX_EMAILS=1 and filters search by subject pattern.
    const uids = [1, 2, 3, 4, 5, 6, 7];
    mockSearch.mockResolvedValue(uids);
    mockFetchOne.mockResolvedValue(
      makeMsg(7, "Vital Talking Points Recap for Week ended 2026-02-26", "2026-02-27T09:00:00Z", plainStructure)
    );
    mockDownload.mockResolvedValue(makeTextDownload("Weekly recap content"));

    await fetchVitalKnowledge("user@gmail.com", "pass123");
    expect(mockFetchOne).toHaveBeenCalledTimes(1);
  });

  it("filters search by subject pattern (recap-only)", async () => {
    mockSearch.mockResolvedValue([1]);
    mockFetchOne.mockResolvedValue(
      makeMsg(1, "Recap", "2026-02-27T09:00:00Z", plainStructure)
    );
    mockDownload.mockResolvedValue(makeTextDownload("ok"));

    await fetchVitalKnowledge("user@gmail.com", "pass123");
    // The IMAP search call must include the subject filter so daily-digest
    // emails are excluded server-side.
    expect(mockSearch).toHaveBeenCalled();
    const searchArgs = mockSearch.mock.calls[0][0];
    expect(searchArgs).toMatchObject({
      from: "updates@vitalknowledge.net",
      subject: expect.stringContaining("Vital Talking Points Recap"),
    });
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
