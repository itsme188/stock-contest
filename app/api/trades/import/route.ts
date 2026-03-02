import { NextResponse } from "next/server";
import { importTrades } from "@/lib/db";
import { type Trade } from "@/lib/contest";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { trades, clear = false } = body;

    if (!Array.isArray(trades)) {
      return NextResponse.json({ error: "trades must be an array" }, { status: 400 });
    }

    // Validate each trade: shape + types + values
    for (const t of trades as Trade[]) {
      if (!t.playerId || !t.type || !t.ticker || t.shares == null || t.price == null || !t.date) {
        return NextResponse.json(
          { error: `Invalid trade: missing fields in ${JSON.stringify(t)}` },
          { status: 400 }
        );
      }
      if (t.type !== "buy" && t.type !== "sell") {
        return NextResponse.json(
          { error: `Invalid trade type: ${t.type}` },
          { status: 400 }
        );
      }
      if (typeof t.shares !== "number" || t.shares <= 0) {
        return NextResponse.json(
          { error: `Invalid shares for ${t.ticker}: must be a positive number` },
          { status: 400 }
        );
      }
      if (typeof t.price !== "number" || t.price <= 0) {
        return NextResponse.json(
          { error: `Invalid price for ${t.ticker}: must be a positive number` },
          { status: 400 }
        );
      }
      if (isNaN(new Date(t.date).getTime())) {
        return NextResponse.json(
          { error: `Invalid date for ${t.ticker}: ${t.date}` },
          { status: 400 }
        );
      }
    }

    importTrades(trades as Trade[], clear);
    return NextResponse.json({ ok: true, count: trades.length });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to import trades: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
