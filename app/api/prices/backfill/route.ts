import { NextResponse } from "next/server";
import { getContestData, saveContestData } from "@/lib/db";
import { type Trade } from "@/lib/contest";

export async function POST() {
  try {
    const contestData = getContestData();
    const { polygonApiKey, contestStartDate } = contestData;
    const trades = contestData.trades as Trade[];

    if (!polygonApiKey) {
      return NextResponse.json(
        { error: "No API key configured. Add your Polygon.io key in Settings." },
        { status: 400 }
      );
    }

    // Collect all unique tickers from trades
    const allTickers = [...new Set(trades.map((t) => t.ticker))].sort();

    if (allTickers.length === 0) {
      return NextResponse.json(
        { error: "No trades found. Add trades first." },
        { status: 400 }
      );
    }

    const from = contestStartDate;
    const to = new Date().toISOString().split("T")[0];
    const priceHistory = { ...contestData.priceHistory };
    let daysAdded = 0;
    const errors: string[] = [];

    // Process in batches of 5 (Polygon free tier: 5 calls/min)
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

    saveContestData({ priceHistory });

    return NextResponse.json({
      ok: true,
      tickers: allTickers.length,
      daysAdded,
      ...(errors.length > 0 && { errors }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to backfill prices: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
