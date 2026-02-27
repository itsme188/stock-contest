import Database from "better-sqlite3";
import path from "path";

export interface ContestData {
  players: unknown[];
  trades: unknown[];
  contestStartDate: string;
  currentPrices: Record<string, number>;
  priceHistory: Record<string, Record<string, number>>;
  polygonApiKey: string;
  gmailAddress: string;
  gmailAppPassword: string;
  anthropicApiKey: string;
  aiModel: string;
  playerEmails: Record<string, string>;
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
  }
  return db;
}

const DEFAULTS: ContestData = {
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

  return {
    players: (data.players as unknown[]) ?? DEFAULTS.players,
    trades: (data.trades as unknown[]) ?? DEFAULTS.trades,
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
  };
}

export function saveContestData(data: Partial<ContestData>): void {
  const conn = getDb();
  const upsert = conn.prepare(
    "INSERT INTO contest_data (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );

  const saveMany = conn.transaction((entries: [string, string][]) => {
    for (const [key, value] of entries) {
      upsert.run(key, value);
    }
  });

  const entries: [string, string][] = Object.entries(data).map(
    ([key, value]) => [key, JSON.stringify(value)]
  );

  saveMany(entries);
}
