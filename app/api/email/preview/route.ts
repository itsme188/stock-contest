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
import { refreshAllOpenPrices, NoOpenPositionsError } from "@/lib/prices-refresh";

export async function POST() {
  try {
    // Phase 7 (2026-05-08): preview must refresh prices too, otherwise the
    // user reviews stale numbers in the preview's leaderboard/positions and
    // then the actual send (via /api/email/weekly) refreshes and ships
    // different numbers. Doing the same refresh here keeps preview and send
    // visually consistent.
    let priceFreshness: "fresh" | "stale" | "noop" = "noop";
    try {
      // No stale-retry sleeps for previews: off-hours the retries sleep 10
      // minutes for prices that cannot become fresh, and the preview already
      // labels staleness via priceFreshness + the Data Notes footer.
      const refresh = await refreshAllOpenPrices({ maxStaleRetries: 0 });
      priceFreshness = refresh.pricesAreFresh ? "fresh" : "stale";
    } catch (err) {
      if (!(err instanceof NoOpenPositionsError)) {
        console.warn(`[Email Preview] Price refresh failed: ${err instanceof Error ? err.message : err}. Preview may show stale prices.`);
        priceFreshness = "stale";
      }
    }

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

    const reportData = buildReportData(players, trades, currentPrices, priceHistory, undefined, contestData.contestStartDate);
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
    const { text: commentary, violations, factual, verifierErrors, attempts } = await generateCommentary(reportData, anthropicApiKey, aiModel, marketContext);
    const previewNotes: string[] = [];
    if (priceFreshness === "stale") previewNotes.push("Prices were not refreshed to today's close for this preview.");
    const html = buildEmailHtml(reportData, commentary, previewNotes);

    return NextResponse.json({
      html,
      commentary,
      reportDate: reportData.reportDate,
      vk: vkStatus,
      priceFreshness,
      violations: {
        numeric: violations.numericViolations,
        ranking: violations.rankingViolations,
        missedTrades: factual.missedTrades.length,
        unknownTickers: factual.unknownTickers.length,
        verifierErrors: verifierErrors.length,
        missedTradesDetail: factual.missedTrades,
        unknownTickersDetail: factual.unknownTickers.map((u) => u.ticker),
        verifierErrorDetail: verifierErrors,
        attempts,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to generate preview: ${err instanceof Error ? err.message : err}`,
      },
      { status: 500 }
    );
  }
}
