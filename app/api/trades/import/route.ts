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

    // Basic shape validation for each trade
    for (const t of trades as Trade[]) {
      if (!t.playerId || !t.type || !t.ticker || !t.shares || !t.price || !t.date) {
        return NextResponse.json(
          { error: `Invalid trade: missing fields in ${JSON.stringify(t)}` },
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
