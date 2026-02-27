import { NextResponse } from "next/server";
import { backfillPrices } from "@/lib/prices";

export async function POST() {
  try {
    const result = await backfillPrices();

    if (result.tickers === 0 && result.errors.length > 0) {
      return NextResponse.json({ error: result.errors[0] }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      tickers: result.tickers,
      daysAdded: result.daysAdded,
      ...(result.errors.length > 0 && { errors: result.errors }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to backfill prices: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
