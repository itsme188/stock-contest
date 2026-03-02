import { NextResponse } from "next/server";
import { getContestData, checkDbIntegrity } from "@/lib/db";

export async function GET() {
  try {
    const data = getContestData();
    const dbHealthy = checkDbIntegrity();

    return NextResponse.json({
      ok: dbHealthy,
      dbHealthy,
      players: (data.players as unknown[]).length,
      trades: data.trades.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
