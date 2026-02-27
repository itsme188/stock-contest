import { NextResponse } from "next/server";
import { getContestData, saveContestData } from "@/lib/db";
import { type Player, type Trade, getPlayerPositions } from "@/lib/contest";

export async function POST() {
  try {
    const contestData = getContestData();
    const { polygonApiKey } = contestData;
    const players = contestData.players as Player[];
    const trades = contestData.trades as Trade[];

    if (!polygonApiKey) {
      return NextResponse.json(
        { error: "No API key configured. Add your Polygon.io key in Settings." },
        { status: 400 }
      );
    }

    // Get all unique open tickers across all players
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

    const updated: Record<string, number> = {};
    const priceDates: Record<string, string> = {};
    const errors: string[] = [];
    const today = new Date().toISOString().split("T")[0];

    // Process in batches of 5 (Polygon free tier: 5 calls/min)
    const BATCH_SIZE = 5;
    for (let i = 0; i < openTickers.length; i += BATCH_SIZE) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 61000));
      }

      const batch = openTickers.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (ticker) => {
          try {
            const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polygonApiKey}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
            const data = await res.json();

            if (data.results?.[0]?.c) {
              // Extract bar date from Polygon timestamp (ms → YYYY-MM-DD)
              const barDate = data.results[0].t
                ? new Date(data.results[0].t).toISOString().split("T")[0]
                : undefined;
              return { ticker, price: data.results[0].c, barDate };
            }
            errors.push(`${ticker}: no price data`);
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
      updated,
      priceDates,
      date: today,
      ...(errors.length > 0 && { errors }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to update prices: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
