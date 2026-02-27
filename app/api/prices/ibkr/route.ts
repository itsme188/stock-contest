import { NextResponse } from "next/server";
import { getContestData, saveContestData } from "@/lib/db";
import { type Player, type Trade, getPlayerPositions } from "@/lib/contest";
import {
  IBApi,
  EventName,
  Contract,
  SecType,
  BarSizeSetting,
  WhatToShow,
} from "@stoqey/ib";

const TWS_PORT = 7496;
const TWS_HOST = "127.0.0.1";
const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const PACE_DELAY_MS = 2000;

// Exchange suffix → IBKR primaryExchange + currency
const EXCHANGE_MAP: Record<string, { primaryExchange: string; currency: string }> = {
  ".TO": { primaryExchange: "TSE", currency: "CAD" },   // Toronto Stock Exchange
  ".V":  { primaryExchange: "VENTURE", currency: "CAD" },// TSX Venture
  ".L":  { primaryExchange: "LSE", currency: "GBP" },    // London
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

function fetchClosingPrice(
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
      // Format YYYYMMDD → YYYY-MM-DD
      const date =
        time.length === 8 && !time.includes("-")
          ? `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`
          : time.split(" ")[0];
      lastBar = { price: close, date };
    };

    const onError = (err: Error, code: number, id: number) => {
      if (id === reqId || id === -1) {
        cleanup();
        reject(new Error(`IBKR error ${code} for ${symbol}: ${err.message}`));
      }
    };

    ib.on(EventName.historicalData, onData);
    ib.on(EventName.error, onError);

    // Request just the last trading day's bar
    ib.reqHistoricalData(
      reqId,
      makeContract(symbol),
      "", // end date = now
      "1 D", // duration = 1 day
      BarSizeSetting.DAYS_ONE,
      WhatToShow.TRADES,
      1, // useRTH = regular trading hours only
      1, // formatDate = YYYYMMDD
      false
    );
  });
}

export async function POST() {
  const ib = new IBApi({ port: TWS_PORT, host: TWS_HOST });

  try {
    const contestData = getContestData();
    const players = contestData.players as Player[];
    const trades = contestData.trades as Trade[];

    const openTickers = [
      ...new Set(
        players.flatMap((p) =>
          getPlayerPositions(p.id, trades).map((pos) => pos.ticker)
        )
      ),
    ].sort();

    if (openTickers.length === 0) {
      return NextResponse.json(
        { error: "No open positions to update." },
        { status: 400 }
      );
    }

    // Connect to TWS with short timeout
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
          reject(
            new Error(`TWS connection refused (code ${code}): ${err.message}`)
          );
        }
      });

      ib.connect();
    });

    const updated: Record<string, number> = {};
    const priceDates: Record<string, string> = {};
    const errors: string[] = [];
    const today = new Date().toISOString().split("T")[0];
    let reqId = 1;

    for (const ticker of openTickers) {
      try {
        const result = await fetchClosingPrice(ib, reqId, ticker);
        if (result) {
          updated[ticker] = result.price;
          priceDates[ticker] = result.date;
        } else {
          errors.push(`${ticker}: no data from TWS`);
        }
      } catch (err) {
        errors.push(
          `${ticker}: ${err instanceof Error ? err.message : err}`
        );
      }

      reqId++;
      // Pace requests to respect IBKR rate limits
      if (reqId <= openTickers.length) {
        await new Promise((r) => setTimeout(r, PACE_DELAY_MS));
      }
    }

    // Update currentPrices and priceHistory
    const currentPrices = { ...contestData.currentPrices, ...updated };
    const priceHistory = { ...contestData.priceHistory };
    for (const [ticker, price] of Object.entries(updated)) {
      if (!priceHistory[ticker]) priceHistory[ticker] = {};
      priceHistory[ticker][today] = price;
    }

    saveContestData({ currentPrices, priceHistory });

    return NextResponse.json({
      ok: true,
      source: "ibkr-tws",
      updated,
      priceDates,
      date: today,
      ...(errors.length > 0 && { errors }),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `IBKR TWS failed: ${err instanceof Error ? err.message : err}`,
      },
      { status: 503 }
    );
  } finally {
    try {
      ib.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }
}
