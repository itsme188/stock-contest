import { NextResponse } from "next/server";
import { getContestData } from "@/lib/db";
import { type Player, type Trade } from "@/lib/contest";
import {
  buildReportData,
  generateCommentary,
  buildEmailHtml,
} from "@/lib/email";
import { fetchVitalKnowledge } from "@/lib/vital-knowledge";
import { backfillPrices } from "@/lib/prices";

export async function POST() {
  try {
    // Backfill price history so "this week" calculations are accurate (90s timeout)
    try {
      await Promise.race([
        backfillPrices(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Backfill timed out")), 90_000)),
      ]);
    } catch (err) {
      console.warn(`[Email Preview] Backfill issue: ${err instanceof Error ? err.message : err}. Proceeding with available prices.`);
    }

    const contestData = getContestData();
    const players = contestData.players as Player[];
    const trades = contestData.trades as Trade[];
    const { currentPrices, priceHistory, anthropicApiKey, aiModel, gmailAddress, gmailAppPassword } = contestData;

    if (!anthropicApiKey) {
      return NextResponse.json(
        { error: "Anthropic API key not configured. Set it in Settings." },
        { status: 400 }
      );
    }

    const reportData = buildReportData(players, trades, currentPrices, priceHistory);
    const marketContext = gmailAddress && gmailAppPassword
      ? await fetchVitalKnowledge(gmailAddress, gmailAppPassword)
      : "";
    console.log(`[Email Preview] VK market context: ${marketContext ? `${marketContext.length} chars` : "empty (no credentials or fetch failed)"}`);
    const commentary = await generateCommentary(reportData, anthropicApiKey, aiModel, marketContext);
    const html = buildEmailHtml(reportData, commentary);

    return NextResponse.json({ html, commentary, reportDate: reportData.reportDate });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to generate preview: ${err instanceof Error ? err.message : err}`,
      },
      { status: 500 }
    );
  }
}
