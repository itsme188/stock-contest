import { NextResponse } from "next/server";
import { refreshPolygonPrices, NoOpenPositionsError } from "@/lib/prices-refresh";

export async function POST() {
  try {
    const result = await refreshPolygonPrices();
    return NextResponse.json({
      ok: true,
      updated: result.updated,
      priceDates: result.priceDates,
      date: result.date,
      ...(result.errors.length > 0 && { errors: result.errors }),
    });
  } catch (err) {
    if (err instanceof NoOpenPositionsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Polygon API key")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json(
      { error: `Failed to update prices: ${message}` },
      { status: 500 }
    );
  }
}
