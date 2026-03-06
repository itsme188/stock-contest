import { NextRequest, NextResponse } from "next/server";
import { getContestData } from "@/lib/db";
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
const CLIENT_ID = 2;
const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;

// Exchange suffix → IBKR primaryExchange + currency
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

interface PriceBar {
  date: string;
  open: number;
  close: number;
}

/**
 * Fetch price bars for a single ticker from IBKR TWS.
 * Returns bars sorted by date ascending.
 */
function fetchBarsFromIBKR(
  symbol: string,
  endDateTime: string,
  duration: string
): Promise<PriceBar[]> {
  const ib = new IBApi({ port: TWS_PORT, host: TWS_HOST, clientId: CLIENT_ID });

  return new Promise((resolve, reject) => {
    const bars: PriceBar[] = [];
    let connected = false;

    const connectTimeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Cannot connect to TWS on ${TWS_HOST}:${TWS_PORT}`));
    }, CONNECT_TIMEOUT_MS);

    const requestTimeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout fetching ${symbol} from TWS`));
    }, CONNECT_TIMEOUT_MS + REQUEST_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(connectTimeout);
      clearTimeout(requestTimeout);
      ib.off(EventName.historicalData, onData);
      ib.off(EventName.error, onError);
      ib.off(EventName.connected, onConnected);
      try { ib.disconnect(); } catch { /* ignore */ }
    }

    const onData = (
      id: number,
      time: string,
      open: number,
      _high: number,
      _low: number,
      close: number
    ) => {
      if (id !== 1) return;
      if (typeof time === "string" && time.startsWith("finished")) {
        cleanup();
        resolve(bars.sort((a, b) => a.date.localeCompare(b.date)));
        return;
      }
      const date =
        time.length === 8 && !time.includes("-")
          ? `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`
          : time.split(" ")[0];
      bars.push({ date, open, close });
    };

    const onError = (err: Error, code: number, id: number) => {
      // Codes >= 2000 are warnings (e.g., 2174 = timezone format), not errors
      if (code >= 2000) return;
      if (id === 1 || id === -1) {
        cleanup();
        reject(new Error(`IBKR error ${code} for ${symbol}: ${err.message}`));
      }
    };

    const onConnected = () => {
      connected = true;
      clearTimeout(connectTimeout);
      ib.on(EventName.historicalData, onData);
      ib.on(EventName.error, onError);

      ib.reqHistoricalData(
        1,
        makeContract(symbol),
        endDateTime,
        duration,
        BarSizeSetting.DAYS_ONE,
        WhatToShow.TRADES,
        1, // useRTH = regular trading hours only
        1, // formatDate = YYYYMMDD
        false
      );
    };

    ib.on(EventName.connected, onConnected);
    ib.on(EventName.error, (err: Error, code: number) => {
      if (!connected && (code === 502 || code === 504)) {
        cleanup();
        reject(new Error(`TWS connection refused (code ${code}): ${err.message}`));
      }
    });

    ib.connect();
  });
}

/** Check if US market is currently in regular trading hours (9:30 AM - 4:00 PM ET, weekdays) */
function isMarketOpen(): boolean {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30 AM = 570, 4:00 PM = 960
}

interface PriceResult {
  price: number;
  date: string;
  actualDate?: string;
  priceType: "current" | "close" | "open";
}

/**
 * Try IBKR for a single-ticker price.
 * - Today + market open: current trading price (bar close = last trade)
 * - Today + market closed: last closing price
 * - Past date: opening price for that trading day
 */
async function fetchPriceViaIBKR(
  ticker: string,
  date: string | null
): Promise<PriceResult | null> {
  const today = new Date().toISOString().split("T")[0];
  const isToday = !date || date === today;

  if (isToday) {
    // Fetch latest bar — close = current price (if market open) or last close
    const bars = await fetchBarsFromIBKR(ticker, "", "1 D");
    const lastBar = bars[bars.length - 1];
    if (lastBar && typeof lastBar.close === "number" && isFinite(lastBar.close) && lastBar.close > 0) {
      return {
        price: lastBar.close,
        date: lastBar.date,
        priceType: isMarketOpen() ? "current" : "close",
      };
    }
    return null;
  } else {
    // Historical date: return open price
    const daysFromTarget = Math.ceil((Date.now() - new Date(date).getTime()) / 86400000) + 5;
    const bars = await fetchBarsFromIBKR(ticker, "", `${daysFromTarget} D`);

    const targetBar = bars.find((b) => b.date >= date);
    if (targetBar && typeof targetBar.open === "number" && isFinite(targetBar.open) && targetBar.open > 0) {
      return {
        price: targetBar.open,
        date: targetBar.date,
        actualDate: targetBar.date !== date ? targetBar.date : undefined,
        priceType: "open",
      };
    }
    return null;
  }
}

/**
 * Polygon fallback — same logic as the original route.
 */
async function fetchPriceViaPolygon(
  ticker: string,
  date: string | null,
  polygonApiKey: string
): Promise<PriceResult | null> {
  const today = new Date().toISOString().split("T")[0];

  if (date && date !== today) {
    // Historical date — open price
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const checkDate = new Date(date);
      checkDate.setDate(checkDate.getDate() + dayOffset);
      const dateStr = checkDate.toISOString().split("T")[0];

      const url = `https://api.polygon.io/v1/open-close/${ticker}/${dateStr}?adjusted=true&apiKey=${polygonApiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();

      if (data.status === "OK" && typeof data.open === "number" && isFinite(data.open) && data.open > 0) {
        return {
          price: data.open,
          date: dateStr,
          actualDate: dateStr !== date ? dateStr : undefined,
          priceType: "open",
        };
      }

      if (data.error) {
        throw new Error(`Polygon API: ${data.error}`);
      }

      if (data.status === "NOT_FOUND" || data.status === "ERROR") {
        continue;
      }
    }
    return null;
  } else {
    // Today or no date — previous close (Polygon can't give intraday current price)
    const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polygonApiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();

    if (data.error) {
      throw new Error(`Polygon API: ${data.error}`);
    }

    const closePrice = data.results?.[0]?.c;
    if (typeof closePrice === "number" && isFinite(closePrice) && closePrice > 0) {
      return {
        price: closePrice,
        date: new Date().toISOString().split("T")[0],
        priceType: "close",
      };
    }
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const ticker = searchParams.get("ticker")?.toUpperCase();
  const date = searchParams.get("date");

  if (!ticker) {
    return NextResponse.json({ error: "ticker parameter required" }, { status: 400 });
  }

  // Try IBKR first (no API key needed)
  try {
    const result = await fetchPriceViaIBKR(ticker, date);
    if (result) {
      return NextResponse.json({ ...result, source: "ibkr" });
    }
  } catch {
    // IBKR failed — fall through to Polygon
  }

  // Fall back to Polygon
  const { polygonApiKey } = getContestData();
  if (!polygonApiKey) {
    return NextResponse.json(
      { error: "IBKR TWS unavailable and no Polygon API key configured. Start TWS or add your key in Settings." },
      { status: 503 }
    );
  }

  try {
    const result = await fetchPriceViaPolygon(ticker, date, polygonApiKey);
    if (result) {
      return NextResponse.json({ ...result, source: "polygon" });
    }
    return NextResponse.json(
      { error: `No price data found for ${ticker}${date ? ` near ${date}` : ""}` },
      { status: 404 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch price: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    );
  }
}
