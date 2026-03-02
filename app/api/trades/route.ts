import { NextResponse } from "next/server";
import { getAllTrades, getContestData, insertTrade } from "@/lib/db";
import { validateTrade } from "@/lib/contest";

export async function GET() {
  try {
    const trades = getAllTrades();
    return NextResponse.json({ trades });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to load trades: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { playerId, type, ticker, shares, price, date } = body;

    // Type validation
    if (!playerId || !type || !ticker || !shares || !price || !date) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    if (type !== "buy" && type !== "sell") {
      return NextResponse.json({ error: "Type must be 'buy' or 'sell'" }, { status: 400 });
    }
    if (typeof shares !== "number" || shares <= 0) {
      return NextResponse.json({ error: "Shares must be a positive number" }, { status: 400 });
    }
    if (typeof price !== "number" || price <= 0) {
      return NextResponse.json({ error: "Price must be a positive number" }, { status: 400 });
    }
    const parsedTimestamp = new Date(date).getTime();
    if (isNaN(parsedTimestamp)) {
      return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
    }

    const upperTicker = ticker.toUpperCase();

    // Business validation using existing contest data as ground truth
    const contestData = getContestData();
    const result = validateTrade(
      { playerId, type, ticker: upperTicker, shares, price },
      contestData.trades,
      contestData.currentPrices
    );
    if (!result.valid) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const trade = insertTrade({
      playerId,
      type,
      ticker: upperTicker,
      shares,
      price,
      date,
      timestamp: parsedTimestamp,
    });

    return NextResponse.json({ ok: true, trade });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to create trade: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
