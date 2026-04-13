import { getContestData, saveContestData } from "@/lib/db";
import { type Trade, BENCHMARK_KEY } from "@/lib/contest";
import {
  IBApi,
  EventName,
  Contract,
  SecType,
  BarSizeSetting,
  WhatToShow,
} from "@stoqey/ib";

interface BackfillResult {
  tickers: number;
  daysAdded: number;
  errors: string[];
}

type PriceHistory = Record<string, Record<string, number>>;

const TWS_PORT = 7496;
const TWS_HOST = "127.0.0.1";
const CLIENT_ID = 2;
const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const PACE_DELAY_MS = 2000;

// Exchange suffix -> IBKR primaryExchange + currency
const EXCHANGE_MAP: Record<string, { primaryExchange: string; currency: string }> = {
  ".TO": { primaryExchange: "TSE", currency: "CAD" },
  ".V":  { primaryExchange: "VENTURE", currency: "CAD" },
  ".L":  { primaryExchange: "LSE", currency: "GBP" },
};

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
  return {
    symbol,
    secType: SecType.STK,
    exchange: "SMART",
    currency: "USD",
  };
}

function fetchHistoricalBars(
  ib: IBApi,
  reqId: number,
  symbol: string,
  durationDays: number
): Promise<Record<string, number>> {
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

    const bars: Record<string, number> = {};

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
        resolve(bars);
        return;
      }
      // Format YYYYMMDD -> YYYY-MM-DD
      const date =
        time.length === 8 && !time.includes("-")
          ? `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`
          : time.split(" ")[0];
      bars[date] = close;
    };

    const onError = (err: Error, code: number, id: number) => {
      // Codes >= 2000 are warnings (e.g., 2174 = timezone format), not errors
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
      `${durationDays} D`,
      BarSizeSetting.DAYS_ONE,
      WhatToShow.TRADES,
      1, // useRTH = regular trading hours only
      1, // formatDate = YYYYMMDD
      false
    );
  });
}

async function backfillViaIBKR(
  allTickers: string[],
  contestStartDate: string,
  priceHistory: PriceHistory
): Promise<BackfillResult> {
  const ib = new IBApi({ port: TWS_PORT, host: TWS_HOST, clientId: CLIENT_ID });

  try {
    // Connect to TWS
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Cannot connect to TWS on ${TWS_HOST}:${TWS_PORT}. Is Trader Workstation running?`));
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

    // Calculate duration: contest start to today + 5 day safety margin
    const startMs = new Date(contestStartDate).getTime();
    const nowMs = Date.now();
    const durationDays = Math.ceil((nowMs - startMs) / (1000 * 60 * 60 * 24)) + 5;

    let daysAdded = 0;
    const errors: string[] = [];
    let reqId = 1;

    for (const ticker of allTickers) {
      try {
        const bars = await fetchHistoricalBars(ib, reqId, ticker, durationDays);
        if (!priceHistory[ticker]) priceHistory[ticker] = {};
        const existing = priceHistory[ticker];
        for (const [date, price] of Object.entries(bars)) {
          if (!existing[date]) {
            existing[date] = price;
            daysAdded++;
          }
        }
      } catch (err) {
        errors.push(`${ticker}: ${err instanceof Error ? err.message : err}`);
      }

      reqId++;
      // Pace requests to respect IBKR rate limits
      if (reqId <= allTickers.length) {
        await new Promise((r) => setTimeout(r, PACE_DELAY_MS));
      }
    }

    return { tickers: allTickers.length, daysAdded, errors };
  } finally {
    try {
      ib.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }
}

async function backfillViaPolygon(
  allTickers: string[],
  contestStartDate: string,
  polygonApiKey: string,
  priceHistory: PriceHistory
): Promise<BackfillResult> {
  const from = contestStartDate;
  const to = new Date().toISOString().split("T")[0];
  let daysAdded = 0;
  const errors: string[] = [];

  const BATCH_SIZE = 5;
  for (let i = 0; i < allTickers.length; i += BATCH_SIZE) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 12500));
    }

    const batch = allTickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (ticker) => {
        try {
          const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&apiKey=${polygonApiKey}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          const data = await res.json();

          if (data.results && Array.isArray(data.results)) {
            const bars: Record<string, number> = {};
            for (const bar of data.results) {
              const date = new Date(bar.t).toISOString().split("T")[0];
              bars[date] = bar.c;
            }
            return { ticker, bars };
          }

          if (data.error) {
            errors.push(`${ticker}: ${data.error}`);
          } else {
            errors.push(`${ticker}: no data returned`);
          }
          return null;
        } catch (err) {
          errors.push(`${ticker}: ${err instanceof Error ? err.message : err}`);
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) {
        if (!priceHistory[result.ticker]) priceHistory[result.ticker] = {};
        const existing = priceHistory[result.ticker];
        for (const [date, price] of Object.entries(result.bars)) {
          if (!existing[date]) {
            existing[date] = price;
            daysAdded++;
          }
        }
      }
    }
  }

  return { tickers: allTickers.length, daysAdded, errors };
}

export async function backfillBenchmark(): Promise<BackfillResult> {
  const contestData = getContestData();
  const { polygonApiKey, contestStartDate } = contestData;
  const priceHistory = { ...contestData.priceHistory };

  let result: BackfillResult;

  // Try IBKR first (primary), Polygon as fallback
  try {
    result = await backfillViaIBKR(["SPY"], contestStartDate, priceHistory);
  } catch {
    if (!polygonApiKey) {
      return { tickers: 0, daysAdded: 0, errors: ["No price source available (TWS not running, no Polygon API key)"] };
    }
    result = await backfillViaPolygon(["SPY"], contestStartDate, polygonApiKey, priceHistory);
  }

  // backfillVia* stores under "SPY" — copy to the benchmark key the dashboard reads
  if (priceHistory["SPY"]) {
    priceHistory[BENCHMARK_KEY] = { ...(priceHistory[BENCHMARK_KEY] || {}), ...priceHistory["SPY"] };
  }

  saveContestData({ priceHistory });
  return result;
}

export async function backfillPrices(): Promise<BackfillResult> {
  const contestData = getContestData();
  const { polygonApiKey, contestStartDate } = contestData;
  const trades = contestData.trades as Trade[];

  const allTickers = [...new Set(trades.map((t) => t.ticker))].sort();

  if (allTickers.length === 0) {
    return { tickers: 0, daysAdded: 0, errors: [] };
  }

  const priceHistory = { ...contestData.priceHistory };
  let result: BackfillResult;

  // Try IBKR first
  try {
    result = await backfillViaIBKR(allTickers, contestStartDate, priceHistory);
  } catch {
    // IBKR failed (TWS not running) — fall back to Polygon
    if (!polygonApiKey) {
      return { tickers: 0, daysAdded: 0, errors: ["No price source available (TWS not running, no Polygon API key)"] };
    }
    result = await backfillViaPolygon(allTickers, contestStartDate, polygonApiKey, priceHistory);
  }

  saveContestData({ priceHistory });
  return result;
}
