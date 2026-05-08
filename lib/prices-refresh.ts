// Shared price-refresh logic, used by both the API route handlers
// (`app/api/prices/{ibkr,update}/route.ts`) and the standalone scheduled
// scripts (`scripts/run-{daily-refresh,weekly-email}.ts`). Extracted from the
// route handlers in Phase 1 so the schedule no longer depends on the Next.js
// dev server being up at job time.
//
// Three exports:
//   - `refreshIbkrPrices()`   — single-source: IBKR TWS only
//   - `refreshPolygonPrices()`— single-source: Polygon /prev only
//   - `refreshAllOpenPrices()`— orchestrator (IBKR primary, Polygon fallback
//                                with stale-price retry) for scheduled jobs

import { getContestData, saveContestData } from "@/lib/db";
import { type Player, type Trade, getPlayerPositions } from "@/lib/contest";
import { localToday } from "@/lib/dates";
import {
  IBApi,
  EventName,
  Contract,
  SecType,
  BarSizeSetting,
  WhatToShow,
} from "@stoqey/ib";

// ---------- Constants ----------

const TWS_PORT = 7496;
const TWS_HOST = "127.0.0.1";
const CLIENT_ID = 2;
const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const PACE_DELAY_MS = 2000;

const POLYGON_BATCH_SIZE = 5; // Polygon free tier: 5 calls/min
const POLYGON_BATCH_DELAY_MS = 61000;
const POLYGON_REQUEST_TIMEOUT_MS = 10000;

const STALE_RETRY_DELAY_MS = 300_000; // 5 min — Polygon /prev publishes ~15min after close
const MAX_STALE_RETRIES = 2;

// Exchange suffix → IBKR primaryExchange + currency
const EXCHANGE_MAP: Record<string, { primaryExchange: string; currency: string }> = {
  ".TO": { primaryExchange: "TSE", currency: "CAD" },
  ".V": { primaryExchange: "VENTURE", currency: "CAD" },
  ".L": { primaryExchange: "LSE", currency: "GBP" },
};

// ---------- Types ----------

export interface RefreshResult {
  source: "ibkr" | "polygon";
  updated: Record<string, number>;
  priceDates: Record<string, string>;
  errors: string[];
  date: string;
  // True when every successfully-fetched price has a barDate of today; false
  // means the data source returned at least one prior session's close.
  pricesAreFresh: boolean;
}

export class NoOpenPositionsError extends Error {
  constructor() {
    super("No open positions to update.");
    this.name = "NoOpenPositionsError";
  }
}

// ---------- Helpers ----------

function makeContract(symbol: string): Contract {
  for (const [suffix, info] of Object.entries(EXCHANGE_MAP)) {
    if (symbol.endsWith(suffix)) {
      return {
        symbol: symbol.slice(0, -suffix.length),
        secType: SecType.STK,
        exchange: "SMART",
        primaryExch: info.primaryExchange,
        currency: info.currency,
      };
    }
  }
  return { symbol, secType: SecType.STK, exchange: "SMART", currency: "USD" };
}

export function getOpenTickers(): string[] {
  const data = getContestData();
  const players = data.players as Player[];
  const trades = data.trades as Trade[];
  return [
    ...new Set(
      players.flatMap((p) =>
        getPlayerPositions(p.id, trades).map((pos) => pos.ticker)
      )
    ),
  ].sort();
}

function computeFreshness(priceDates: Record<string, string>, today: string): boolean {
  const dates = Object.values(priceDates);
  if (dates.length === 0) return false;
  return dates.every((d) => d === today);
}

function persistPrices(updated: Record<string, number>, today: string) {
  const contestData = getContestData();
  const currentPrices = { ...contestData.currentPrices, ...updated };
  const priceHistory = { ...contestData.priceHistory };
  for (const [ticker, price] of Object.entries(updated)) {
    if (!priceHistory[ticker]) priceHistory[ticker] = {};
    priceHistory[ticker][today] = price;
  }
  saveContestData({ currentPrices, priceHistory });
}

// ---------- IBKR ----------

function fetchIbkrClosingPrice(
  ib: IBApi,
  reqId: number,
  symbol: string
): Promise<{ price: number; date: string } | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout fetching ${symbol}`));
    }, REQUEST_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      ib.off(EventName.historicalData, onData);
      ib.off(EventName.error, onError);
    }

    let lastBar: { price: number; date: string } | null = null;

    const onData = (
      id: number,
      time: string,
      _open: number,
      _high: number,
      _low: number,
      close: number
    ) => {
      if (id !== reqId) return;
      if (typeof time === "string" && time.startsWith("finished")) {
        cleanup();
        resolve(lastBar);
        return;
      }
      const date =
        time.length === 8 && !time.includes("-")
          ? `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`
          : time.split(" ")[0];
      lastBar = { price: close, date };
    };

    const onError = (err: Error, code: number, id: number) => {
      // Codes >= 2000 are warnings (e.g. 2174 timezone format), not errors
      if (code >= 2000) return;
      if (id === reqId || id === -1) {
        cleanup();
        reject(new Error(`IBKR error ${code} for ${symbol}: ${err.message}`));
      }
    };

    ib.on(EventName.historicalData, onData);
    ib.on(EventName.error, onError);

    ib.reqHistoricalData(
      reqId,
      makeContract(symbol),
      "",
      "1 D",
      BarSizeSetting.DAYS_ONE,
      WhatToShow.TRADES,
      1,
      1,
      false
    );
  });
}

export async function refreshIbkrPrices(): Promise<RefreshResult> {
  const openTickers = getOpenTickers();
  if (openTickers.length === 0) throw new NoOpenPositionsError();

  const ib = new IBApi({ port: TWS_PORT, host: TWS_HOST, clientId: CLIENT_ID });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Cannot connect to TWS on ${TWS_HOST}:${TWS_PORT}. Is Trader Workstation running?`
          )
        );
      }, CONNECT_TIMEOUT_MS);

      ib.on(EventName.connected, () => {
        clearTimeout(timeout);
        resolve();
      });

      ib.on(EventName.error, (err: Error, code: number) => {
        if (code === 502 || code === 504) {
          clearTimeout(timeout);
          reject(new Error(`TWS connection refused (code ${code}): ${err.message}`));
        }
      });

      ib.connect();
    });

    const updated: Record<string, number> = {};
    const priceDates: Record<string, string> = {};
    const errors: string[] = [];
    const today = localToday();
    let reqId = 1;

    for (const ticker of openTickers) {
      try {
        const result = await fetchIbkrClosingPrice(ib, reqId, ticker);
        if (result) {
          updated[ticker] = result.price;
          priceDates[ticker] = result.date;
        } else {
          errors.push(`${ticker}: no data from TWS`);
        }
      } catch (err) {
        errors.push(`${ticker}: ${err instanceof Error ? err.message : err}`);
      }

      reqId++;
      if (reqId <= openTickers.length) {
        await new Promise((r) => setTimeout(r, PACE_DELAY_MS));
      }
    }

    persistPrices(updated, today);

    return {
      source: "ibkr",
      updated,
      priceDates,
      errors,
      date: today,
      pricesAreFresh: computeFreshness(priceDates, today),
    };
  } finally {
    try {
      ib.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }
}

// ---------- Polygon ----------

export async function refreshPolygonPrices(): Promise<RefreshResult> {
  const contestData = getContestData();
  const { polygonApiKey } = contestData;
  if (!polygonApiKey) {
    throw new Error("Polygon API key not configured. Add it in Settings.");
  }

  const openTickers = getOpenTickers();
  if (openTickers.length === 0) throw new NoOpenPositionsError();

  const updated: Record<string, number> = {};
  const priceDates: Record<string, string> = {};
  const errors: string[] = [];
  const today = localToday();

  for (let i = 0; i < openTickers.length; i += POLYGON_BATCH_SIZE) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, POLYGON_BATCH_DELAY_MS));
    }

    const batch = openTickers.slice(i, i + POLYGON_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (ticker) => {
        try {
          const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polygonApiKey}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(POLYGON_REQUEST_TIMEOUT_MS) });
          const data = await res.json();
          const closePrice = data.results?.[0]?.c;
          if (typeof closePrice === "number" && isFinite(closePrice) && closePrice > 0) {
            const barDate = data.results[0].t
              ? new Date(data.results[0].t).toISOString().split("T")[0]
              : undefined;
            return { ticker, price: closePrice, barDate };
          }
          errors.push(`${ticker}: no valid price data`);
          return null;
        } catch (err) {
          errors.push(`${ticker}: ${err instanceof Error ? err.message : err}`);
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) {
        updated[result.ticker] = result.price;
        if (result.barDate) priceDates[result.ticker] = result.barDate;
      }
    }
  }

  persistPrices(updated, today);

  return {
    source: "polygon",
    updated,
    priceDates,
    errors,
    date: today,
    pricesAreFresh: computeFreshness(priceDates, today),
  };
}

// ---------- Orchestrator (used by scheduled scripts only) ----------

export interface OrchestratedRefreshResult extends RefreshResult {
  staleRetries: number;
  ibkrError?: string;
}

// IBKR-primary, Polygon-fallback. If Polygon returns stale prices (Polygon
// /prev publishes ~15 min after market close), retry up to 2 times with
// 5-minute delays. Returns the final result plus retry count so the caller
// (scheduled script) can flag stale-data sends in the audit log.
export async function refreshAllOpenPrices(): Promise<OrchestratedRefreshResult> {
  let ibkrResult: RefreshResult | null = null;
  let ibkrError: string | undefined;

  try {
    ibkrResult = await refreshIbkrPrices();
    if (ibkrResult.pricesAreFresh) {
      return { ...ibkrResult, staleRetries: 0 };
    }
    console.warn(
      `[Refresh] IBKR returned stale prices (priceDates=${JSON.stringify(ibkrResult.priceDates)}). Falling back to Polygon.`
    );
  } catch (err) {
    ibkrError = err instanceof Error ? err.message : String(err);
    if (err instanceof NoOpenPositionsError) throw err;
    console.warn(`[Refresh] IBKR failed: ${ibkrError}. Falling back to Polygon.`);
  }

  let result = await refreshPolygonPrices();
  let staleRetries = 0;
  while (!result.pricesAreFresh && staleRetries < MAX_STALE_RETRIES) {
    staleRetries++;
    console.warn(
      `[Refresh] Polygon stale, retry ${staleRetries}/${MAX_STALE_RETRIES} in ${STALE_RETRY_DELAY_MS / 1000}s`
    );
    await new Promise((r) => setTimeout(r, STALE_RETRY_DELAY_MS));
    result = await refreshPolygonPrices();
  }

  return { ...result, staleRetries, ibkrError };
}
