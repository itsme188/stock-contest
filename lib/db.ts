import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import { type Trade } from "./contest";

export interface ContestData {
  players: unknown[];
  trades: Trade[];
  contestStartDate: string;
  currentPrices: Record<string, number>;
  priceHistory: Record<string, Record<string, number>>;
  polygonApiKey: string;
  gmailAddress: string;
  gmailAppPassword: string;
  anthropicApiKey: string;
  aiModel: string;
  playerEmails: Record<string, string>;
  // YYYY-MM-DD of the last successful weekly email send. Used by the send
  // endpoint to refuse duplicate sends on the same day (manual + cron collision).
  lastWeeklyEmailSentDate: string;
}

const DB_PATH = path.join(process.cwd(), "data", "contest.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS contest_data (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('buy', 'sell')),
        ticker TEXT NOT NULL,
        shares REAL NOT NULL CHECK(shares > 0),
        price REAL NOT NULL CHECK(price > 0),
        date TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    migrateTradesFromBlob(db);
  }
  return db;
}

// --- Trade Row ↔ Trade Interface Mapping ---

interface TradeRow {
  id: string;
  player_id: string;
  type: string;
  ticker: string;
  shares: number;
  price: number;
  date: string;
  timestamp: number;
  created_at: string;
}

function rowToTrade(row: TradeRow): Trade {
  return {
    id: row.id,
    playerId: row.player_id,
    type: row.type as "buy" | "sell",
    ticker: row.ticker,
    shares: row.shares,
    price: row.price,
    date: row.date,
    timestamp: row.timestamp,
  };
}

// --- Migration: blob → trades table (one-time) ---

export function migrateTradesFromBlob(conn: Database.Database): void {
  const count = conn.prepare("SELECT COUNT(*) as n FROM trades").get() as { n: number };
  if (count.n > 0) return; // Already migrated

  const row = conn.prepare("SELECT value FROM contest_data WHERE key = 'trades'").get() as
    | { value: string }
    | undefined;
  if (!row) return;

  let blobTrades: Trade[];
  try {
    blobTrades = JSON.parse(row.value) as Trade[];
  } catch {
    return;
  }
  if (!Array.isArray(blobTrades) || blobTrades.length === 0) return;

  const insert = conn.prepare(
    "INSERT OR IGNORE INTO trades (id, player_id, type, ticker, shares, price, date, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  const migrate = conn.transaction((trades: Trade[]) => {
    for (const t of trades) {
      insert.run(t.id, t.playerId, t.type, t.ticker, t.shares, t.price, t.date, t.timestamp);
    }
  });

  migrate(blobTrades);

  // Remove trades from blob so debounced PUT can't overwrite
  conn.prepare("DELETE FROM contest_data WHERE key = 'trades'").run();

  addAuditEntryWithConn(conn, "migrate", { tradeCount: blobTrades.length, source: "blob" });
}

// --- Trades CRUD ---

export function getAllTrades(): Trade[] {
  const conn = getDb();
  const rows = conn.prepare("SELECT * FROM trades ORDER BY timestamp ASC, created_at ASC").all() as TradeRow[];
  return rows.map(rowToTrade);
}

export function getTradeById(id: string): Trade | null {
  const conn = getDb();
  const row = conn.prepare("SELECT * FROM trades WHERE id = ?").get(id) as TradeRow | undefined;
  return row ? rowToTrade(row) : null;
}

export function insertTrade(trade: Omit<Trade, "id">): Trade {
  const conn = getDb();
  const id = crypto.randomUUID();
  conn
    .prepare(
      "INSERT INTO trades (id, player_id, type, ticker, shares, price, date, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(id, trade.playerId, trade.type, trade.ticker, trade.shares, trade.price, trade.date, trade.timestamp);

  const created: Trade = { id, ...trade };
  addAuditEntry("trade_add", created);
  return created;
}

export function deleteTrade(id: string): Trade | null {
  const conn = getDb();
  const row = conn.prepare("SELECT * FROM trades WHERE id = ?").get(id) as TradeRow | undefined;
  if (!row) return null;

  conn.prepare("DELETE FROM trades WHERE id = ?").run(id);
  const trade = rowToTrade(row);
  addAuditEntry("trade_delete", trade);
  return trade;
}

export function importTrades(trades: Trade[], clear = false): void {
  const conn = getDb();
  const insert = conn.prepare(
    "INSERT OR REPLACE INTO trades (id, player_id, type, ticker, shares, price, date, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  const doImport = conn.transaction((trades: Trade[], clear: boolean) => {
    if (clear) {
      conn.prepare("DELETE FROM trades").run();
    }
    for (const t of trades) {
      // Preserve existing IDs if present, generate new ones if not
      const id = t.id || crypto.randomUUID();
      insert.run(id, t.playerId, t.type, t.ticker, t.shares, t.price, t.date, t.timestamp);
    }
  });

  doImport(trades, clear);
  addAuditEntry("import", { tradeCount: trades.length, clear });
}

// --- Audit Log ---

function addAuditEntryWithConn(conn: Database.Database, action: string, detail: unknown): void {
  conn
    .prepare("INSERT INTO audit_log (action, detail) VALUES (?, ?)")
    .run(action, JSON.stringify(detail));
}

export function addAuditEntry(action: string, detail: unknown): void {
  addAuditEntryWithConn(getDb(), action, detail);
}

export function getAuditLog(): { action: string; detail: string; created_at: string }[] {
  const conn = getDb();
  return conn.prepare("SELECT action, detail, created_at FROM audit_log ORDER BY id ASC").all() as {
    action: string;
    detail: string;
    created_at: string;
  }[];
}

// --- Database Health ---

export function checkDbIntegrity(): boolean {
  const conn = getDb();
  const result = conn.pragma("integrity_check") as { integrity_check: string }[];
  return result[0]?.integrity_check === "ok";
}

// --- Testing Support ---

/** Replace the module-level DB singleton. Pass undefined to reset. Tests only. */
export function _resetDbForTesting(newDb?: Database.Database): void {
  db = newDb ?? null;
}

/** Initialize schema on an existing connection (used by tests with in-memory DBs). */
export function _initSchema(conn: Database.Database): void {
  conn.pragma("journal_mode = WAL");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS contest_data (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('buy', 'sell')),
      ticker TEXT NOT NULL,
      shares REAL NOT NULL CHECK(shares > 0),
      price REAL NOT NULL CHECK(price > 0),
      date TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// --- Contest Data (settings, prices, players — NOT trades) ---

const DEFAULTS: Omit<ContestData, "trades"> & { trades: Trade[] } = {
  players: [],
  trades: [],
  contestStartDate: "2026-01-01",
  currentPrices: {},
  priceHistory: {},
  polygonApiKey: "",
  gmailAddress: "",
  gmailAppPassword: "",
  anthropicApiKey: "",
  aiModel: "claude-sonnet-4-5-20250929",
  playerEmails: {},
  lastWeeklyEmailSentDate: "",
};

export function getContestData(): ContestData {
  const conn = getDb();
  const rows = conn.prepare("SELECT key, value FROM contest_data").all() as {
    key: string;
    value: string;
  }[];

  const data: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      data[row.key] = JSON.parse(row.value);
    } catch {
      data[row.key] = row.value;
    }
  }

  // Trades come from the normalized table, not the blob
  const trades = getAllTrades();

  return {
    players: (data.players as unknown[]) ?? DEFAULTS.players,
    trades,
    contestStartDate:
      (data.contestStartDate as string) ?? DEFAULTS.contestStartDate,
    currentPrices:
      (data.currentPrices as Record<string, number>) ?? DEFAULTS.currentPrices,
    priceHistory:
      (data.priceHistory as Record<string, Record<string, number>>) ??
      DEFAULTS.priceHistory,
    polygonApiKey:
      (data.polygonApiKey as string) ?? DEFAULTS.polygonApiKey,
    gmailAddress:
      (data.gmailAddress as string) ?? DEFAULTS.gmailAddress,
    gmailAppPassword:
      (data.gmailAppPassword as string) ?? DEFAULTS.gmailAppPassword,
    anthropicApiKey:
      (data.anthropicApiKey as string) ?? DEFAULTS.anthropicApiKey,
    aiModel:
      (data.aiModel as string) ?? DEFAULTS.aiModel,
    playerEmails:
      (data.playerEmails as Record<string, string>) ?? DEFAULTS.playerEmails,
    lastWeeklyEmailSentDate:
      (data.lastWeeklyEmailSentDate as string) ?? DEFAULTS.lastWeeklyEmailSentDate,
  };
}

export function saveContestData(data: Partial<ContestData>): void {
  const conn = getDb();
  const upsert = conn.prepare(
    "INSERT INTO contest_data (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );

  // Strip trades — they are managed via the trades table now
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { trades, ...rest } = data;

  const saveMany = conn.transaction((entries: [string, string][]) => {
    for (const [key, value] of entries) {
      upsert.run(key, value);
    }
  });

  const entries: [string, string][] = Object.entries(rest).map(
    ([key, value]) => [key, JSON.stringify(value)]
  );

  saveMany(entries);
}
