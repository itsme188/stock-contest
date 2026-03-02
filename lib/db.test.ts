import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  _resetDbForTesting,
  _initSchema,
  migrateTradesFromBlob,
  getAllTrades,
  getTradeById,
  insertTrade,
  deleteTrade,
  importTrades,
  getContestData,
  saveContestData,
  addAuditEntry,
  getAuditLog,
  checkDbIntegrity,
} from "@/lib/db";
import { type Trade } from "@/lib/contest";

// --- Helpers ---

function freshDb(): Database.Database {
  const memDb = new Database(":memory:");
  _initSchema(memDb);
  _resetDbForTesting(memDb);
  return memDb;
}

function makeTrade(
  overrides: Partial<Trade> &
    Pick<Trade, "playerId" | "type" | "ticker" | "shares" | "price" | "date">
): Omit<Trade, "id"> {
  return {
    timestamp: new Date(overrides.date).getTime(),
    ...overrides,
  };
}

// --- Schema ---

describe("schema initialization", () => {
  beforeEach(() => freshDb());

  it("creates all three tables", () => {
    const db = freshDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("contest_data");
    expect(names).toContain("trades");
    expect(names).toContain("audit_log");
  });

  it("is idempotent — calling _initSchema twice does not error", () => {
    const db = new Database(":memory:");
    _initSchema(db);
    expect(() => _initSchema(db)).not.toThrow();
  });
});

// --- insertTrade ---

describe("insertTrade", () => {
  beforeEach(() => freshDb());

  it("returns a trade with a UUID id", () => {
    const trade = insertTrade(
      makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" })
    );
    expect(trade.id).toBeDefined();
    expect(trade.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(trade.playerId).toBe("p1");
    expect(trade.ticker).toBe("AAPL");
  });

  it("generates unique IDs for rapid inserts", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const trade = insertTrade(
        makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 10, price: 100, date: "2026-01-15" })
      );
      ids.add(trade.id);
    }
    expect(ids.size).toBe(50);
  });

  it("audit logs the addition", () => {
    insertTrade(
      makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" })
    );
    const log = getAuditLog();
    expect(log.length).toBe(1);
    expect(log[0].action).toBe("trade_add");
    const detail = JSON.parse(log[0].detail);
    expect(detail.ticker).toBe("AAPL");
  });
});

// --- getAllTrades ---

describe("getAllTrades", () => {
  beforeEach(() => freshDb());

  it("returns empty array on fresh DB", () => {
    expect(getAllTrades()).toEqual([]);
  });

  it("returns trades in timestamp order", () => {
    insertTrade(makeTrade({ playerId: "p1", type: "buy", ticker: "MSFT", shares: 50, price: 300, date: "2026-02-01" }));
    insertTrade(makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }));
    const trades = getAllTrades();
    expect(trades.length).toBe(2);
    expect(trades[0].ticker).toBe("AAPL"); // Jan 15 < Feb 1
    expect(trades[1].ticker).toBe("MSFT");
  });
});

// --- getTradeById ---

describe("getTradeById", () => {
  beforeEach(() => freshDb());

  it("returns null for non-existent ID", () => {
    expect(getTradeById("nonexistent")).toBeNull();
  });

  it("returns the correct trade", () => {
    const created = insertTrade(
      makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" })
    );
    const found = getTradeById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.ticker).toBe("AAPL");
    expect(found!.shares).toBe(100);
  });
});

// --- deleteTrade ---

describe("deleteTrade", () => {
  beforeEach(() => freshDb());

  it("returns null for non-existent ID", () => {
    expect(deleteTrade("nonexistent")).toBeNull();
  });

  it("removes the trade and returns it", () => {
    const created = insertTrade(
      makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" })
    );
    const deleted = deleteTrade(created.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.id).toBe(created.id);
    // Verify it's gone
    expect(getTradeById(created.id)).toBeNull();
    expect(getAllTrades()).toHaveLength(0);
  });

  it("audit logs the deletion", () => {
    const created = insertTrade(
      makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" })
    );
    deleteTrade(created.id);
    const log = getAuditLog();
    const deleteEntry = log.find((e) => e.action === "trade_delete");
    expect(deleteEntry).toBeDefined();
    const detail = JSON.parse(deleteEntry!.detail);
    expect(detail.id).toBe(created.id);
  });
});

// --- CHECK constraints ---

describe("insertTrade constraints", () => {
  beforeEach(() => freshDb());

  it("rejects shares <= 0", () => {
    expect(() =>
      insertTrade(makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 0, price: 150, date: "2026-01-15" }))
    ).toThrow();
    expect(() =>
      insertTrade(makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: -10, price: 150, date: "2026-01-15" }))
    ).toThrow();
  });

  it("rejects price <= 0", () => {
    expect(() =>
      insertTrade(makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 0, date: "2026-01-15" }))
    ).toThrow();
    expect(() =>
      insertTrade(makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: -5, date: "2026-01-15" }))
    ).toThrow();
  });

  it("rejects invalid type", () => {
    expect(() =>
      insertTrade(
        makeTrade({
          playerId: "p1",
          type: "hold" as "buy",
          ticker: "AAPL",
          shares: 100,
          price: 150,
          date: "2026-01-15",
        })
      )
    ).toThrow();
  });
});

// --- importTrades ---

describe("importTrades", () => {
  beforeEach(() => freshDb());

  it("imports multiple trades", () => {
    const trades: Trade[] = [
      { id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1736899200000 },
      { id: "t2", playerId: "p1", type: "buy", ticker: "MSFT", shares: 50, price: 300, date: "2026-01-16", timestamp: 1736985600000 },
    ];
    importTrades(trades);
    expect(getAllTrades()).toHaveLength(2);
  });

  it("clear=true deletes existing trades first", () => {
    insertTrade(makeTrade({ playerId: "p1", type: "buy", ticker: "GOOG", shares: 20, price: 100, date: "2026-01-10" }));
    expect(getAllTrades()).toHaveLength(1);

    const trades: Trade[] = [
      { id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1736899200000 },
    ];
    importTrades(trades, true);
    const all = getAllTrades();
    expect(all).toHaveLength(1);
    expect(all[0].ticker).toBe("AAPL");
  });

  it("clear=false preserves existing trades", () => {
    insertTrade(makeTrade({ playerId: "p1", type: "buy", ticker: "GOOG", shares: 20, price: 100, date: "2026-01-10" }));
    const trades: Trade[] = [
      { id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1736899200000 },
    ];
    importTrades(trades, false);
    expect(getAllTrades()).toHaveLength(2);
  });

  it("preserves existing IDs when present", () => {
    const trades: Trade[] = [
      { id: "my-custom-id", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1736899200000 },
    ];
    importTrades(trades);
    expect(getTradeById("my-custom-id")).not.toBeNull();
  });

  it("generates new IDs when missing", () => {
    const trades = [
      { id: "", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1736899200000 },
    ] as Trade[];
    importTrades(trades);
    const all = getAllTrades();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBeTruthy();
    expect(all[0].id).not.toBe("");
  });

  it("audit logs the import", () => {
    const trades: Trade[] = [
      { id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1736899200000 },
      { id: "t2", playerId: "p1", type: "buy", ticker: "MSFT", shares: 50, price: 300, date: "2026-01-16", timestamp: 1736985600000 },
    ];
    importTrades(trades);
    const log = getAuditLog();
    const importEntry = log.find((e) => e.action === "import");
    expect(importEntry).toBeDefined();
    const detail = JSON.parse(importEntry!.detail);
    expect(detail.tradeCount).toBe(2);
  });
});

// --- getContestData ---

describe("getContestData", () => {
  beforeEach(() => freshDb());

  it("returns defaults on fresh DB", () => {
    const data = getContestData();
    expect(data.players).toEqual([]);
    expect(data.trades).toEqual([]);
    expect(data.contestStartDate).toBe("2026-01-01");
    expect(data.currentPrices).toEqual({});
    expect(data.polygonApiKey).toBe("");
  });

  it("merges trades from normalized table", () => {
    insertTrade(makeTrade({ playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15" }));
    const data = getContestData();
    expect(data.trades).toHaveLength(1);
    expect(data.trades[0].ticker).toBe("AAPL");
  });
});

// --- saveContestData ---

describe("saveContestData", () => {
  beforeEach(() => freshDb());

  it("persists and retrieves data correctly", () => {
    saveContestData({
      contestStartDate: "2026-02-01",
      polygonApiKey: "my-key",
      currentPrices: { AAPL: 150 },
    });
    const data = getContestData();
    expect(data.contestStartDate).toBe("2026-02-01");
    expect(data.polygonApiKey).toBe("my-key");
    expect(data.currentPrices).toEqual({ AAPL: 150 });
  });

  it("strips trades from save", () => {
    const db = new Database(":memory:");
    _initSchema(db);
    _resetDbForTesting(db);

    saveContestData({
      trades: [
        { id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1 },
      ],
      polygonApiKey: "key",
    });

    // Verify trades key is NOT in contest_data table
    const row = db.prepare("SELECT value FROM contest_data WHERE key = 'trades'").get();
    expect(row).toBeUndefined();

    // Verify other data was saved
    const data = getContestData();
    expect(data.polygonApiKey).toBe("key");
  });

  it("upserts existing keys", () => {
    saveContestData({ polygonApiKey: "first" });
    expect(getContestData().polygonApiKey).toBe("first");

    saveContestData({ polygonApiKey: "second" });
    expect(getContestData().polygonApiKey).toBe("second");
  });
});

// --- Migration ---

describe("migrateTradesFromBlob", () => {
  it("moves blob trades to normalized table", () => {
    const db = new Database(":memory:");
    _initSchema(db);
    _resetDbForTesting(db);

    // Simulate pre-migration state: trades blob in contest_data, table is empty
    const blobTrades = [
      { id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1736899200000 },
      { id: "t2", playerId: "p2", type: "buy", ticker: "MSFT", shares: 50, price: 300, date: "2026-01-16", timestamp: 1736985600000 },
    ];
    db.prepare("INSERT INTO contest_data (key, value) VALUES ('trades', ?)").run(JSON.stringify(blobTrades));

    migrateTradesFromBlob(db);

    // Trades should be in the normalized table
    const trades = getAllTrades();
    expect(trades).toHaveLength(2);
    expect(trades[0].ticker).toBe("AAPL");
    expect(trades[1].ticker).toBe("MSFT");

    // Blob key should be deleted
    const blobRow = db.prepare("SELECT value FROM contest_data WHERE key = 'trades'").get();
    expect(blobRow).toBeUndefined();
  });

  it("is idempotent — second call is a no-op when trades exist", () => {
    const db = new Database(":memory:");
    _initSchema(db);
    _resetDbForTesting(db);

    const blobTrades = [
      { id: "t1", playerId: "p1", type: "buy", ticker: "AAPL", shares: 100, price: 150, date: "2026-01-15", timestamp: 1736899200000 },
    ];
    db.prepare("INSERT INTO contest_data (key, value) VALUES ('trades', ?)").run(JSON.stringify(blobTrades));

    migrateTradesFromBlob(db);
    migrateTradesFromBlob(db); // Second call — trades table is non-empty, should skip

    expect(getAllTrades()).toHaveLength(1);
  });

  it("handles malformed JSON gracefully", () => {
    const db = new Database(":memory:");
    _initSchema(db);
    _resetDbForTesting(db);

    db.prepare("INSERT INTO contest_data (key, value) VALUES ('trades', ?)").run("not valid json {{{");

    expect(() => migrateTradesFromBlob(db)).not.toThrow();
    expect(getAllTrades()).toHaveLength(0);
  });

  it("does nothing when no blob exists", () => {
    const db = new Database(":memory:");
    _initSchema(db);
    _resetDbForTesting(db);

    expect(() => migrateTradesFromBlob(db)).not.toThrow();
    expect(getAllTrades()).toHaveLength(0);
  });
});

// --- Audit Log ---

describe("audit log", () => {
  beforeEach(() => freshDb());

  it("persists action and detail", () => {
    addAuditEntry("test_action", { foo: "bar", count: 42 });
    const log = getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("test_action");
    const detail = JSON.parse(log[0].detail);
    expect(detail.foo).toBe("bar");
    expect(detail.count).toBe(42);
  });

  it("preserves insertion order", () => {
    addAuditEntry("first", {});
    addAuditEntry("second", {});
    addAuditEntry("third", {});
    const log = getAuditLog();
    expect(log.map((e) => e.action)).toEqual(["first", "second", "third"]);
  });
});

// --- DB Integrity ---

describe("checkDbIntegrity", () => {
  beforeEach(() => freshDb());

  it("returns true for healthy database", () => {
    expect(checkDbIntegrity()).toBe(true);
  });
});
