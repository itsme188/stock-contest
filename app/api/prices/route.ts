import { NextRequest, NextResponse } from "next/server";
import { getContestData } from "@/lib/db";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const ticker = searchParams.get("ticker")?.toUpperCase();
  const date = searchParams.get("date");

  if (!ticker) {
    return NextResponse.json({ error: "ticker parameter required" }, { status: 400 });
  }

  const { polygonApiKey } = getContestData();
  if (!polygonApiKey) {
    return NextResponse.json(
      { error: "No API key configured. Add your Polygon.io key in Settings." },
      { status: 400 }
    );
  }

  try {
    if (date) {
      // Historical price — try up to 7 days forward to find a trading day
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const checkDate = new Date(date);
        checkDate.setDate(checkDate.getDate() + dayOffset);
        const dateStr = checkDate.toISOString().split("T")[0];

        const url = `https://api.polygon.io/v1/open-close/${ticker}/${dateStr}?adjusted=true&apiKey=${polygonApiKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();

        if (data.status === "OK" && typeof data.open === "number") {
          return NextResponse.json({
            price: data.open,
            date: dateStr,
            actualDate: dateStr !== date ? dateStr : undefined,
          });
        }

        if (data.error) {
          return NextResponse.json({ error: `Polygon API: ${data.error}` }, { status: 502 });
        }

        // NOT_FOUND or weekend — try next day
        if (data.status === "NOT_FOUND" || data.status === "ERROR") {
          continue;
        }
      }

      return NextResponse.json(
        { error: `No trading data found for ${ticker} near ${date}` },
        { status: 404 }
      );
    } else {
      // Latest/previous close price
      const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polygonApiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();

      if (data.error) {
        return NextResponse.json({ error: `Polygon API: ${data.error}` }, { status: 502 });
      }

      if (data.results?.[0]?.c) {
        return NextResponse.json({
          price: data.results[0].c,
          date: new Date().toISOString().split("T")[0],
        });
      }

      return NextResponse.json(
        { error: `No price data for ${ticker}` },
        { status: 404 }
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch price: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
