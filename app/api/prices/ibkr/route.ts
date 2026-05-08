import { NextResponse } from "next/server";
import { refreshIbkrPrices, NoOpenPositionsError } from "@/lib/prices-refresh";

export async function POST() {
  try {
    const result = await refreshIbkrPrices();
    return NextResponse.json({
      ok: true,
      source: "ibkr-tws",
      updated: result.updated,
      priceDates: result.priceDates,
      date: result.date,
      ...(result.errors.length > 0 && { errors: result.errors }),
    });
  } catch (err) {
    if (err instanceof NoOpenPositionsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: `IBKR TWS failed: ${err instanceof Error ? err.message : err}` },
      { status: 503 }
    );
  }
}
