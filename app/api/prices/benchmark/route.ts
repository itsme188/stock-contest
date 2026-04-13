import { NextResponse } from "next/server";
import { getContestData } from "@/lib/db";
import { BENCHMARK_KEY } from "@/lib/contest";
import { backfillBenchmark } from "@/lib/prices";

export async function POST() {
  try {
    const result = await backfillBenchmark();

    if (result.errors.length > 0 && result.daysAdded === 0) {
      return NextResponse.json(
        { error: result.errors.join("; ") },
        { status: 502 }
      );
    }

    // Read back the saved benchmark data
    const contestData = getContestData();
    const prices = contestData.priceHistory?.[BENCHMARK_KEY] || {};

    return NextResponse.json({
      ok: true,
      prices,
      daysLoaded: Object.keys(prices).length,
      source: result.errors.length === 0 ? "IBKR" : "mixed",
      ...(result.errors.length > 0 && { warnings: result.errors }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch benchmark data: ${err instanceof Error ? err.message : err}` },
      { status: 500 }
    );
  }
}
