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
    const vkStatus: { chars: number; credsConfigured: boolean; preview: string } = {
      chars: 0,
      credsConfigured: Boolean(gmailAddress && gmailAppPassword),
      preview: "",
    };
    const marketContext = vkStatus.credsConfigured
      ? await fetchVitalKnowledge(gmailAddress, gmailAppPassword)
      : "";
    vkStatus.chars = marketContext?.length ?? 0;
    vkStatus.preview = marketContext ? marketContext.slice(0, 160) : "";
    console.log(`[Email Preview] VK market context: ${vkStatus.chars ? `${vkStatus.chars} chars` : vkStatus.credsConfigured ? "empty (fetch failed)" : "empty (no credentials)"}`);
    const commentary = await generateCommentary(reportData, anthropicApiKey, aiModel, marketContext);
    const html = buildEmailHtml(reportData, commentary);

    return NextResponse.json({ html, commentary, reportDate: reportData.reportDate, vk: vkStatus });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to generate preview: ${err instanceof Error ? err.message : err}`,
      },
      { status: 500 }
    );
  }
}
