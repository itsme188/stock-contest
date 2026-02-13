import { NextResponse } from "next/server";
import { getContestData } from "@/lib/db";
import { type Player, type Trade } from "@/lib/contest";
import {
  buildReportData,
  generateCommentary,
  buildEmailHtml,
} from "@/lib/email";

export async function POST() {
  try {
    const contestData = getContestData();
    const players = contestData.players as Player[];
    const trades = contestData.trades as Trade[];
    const { currentPrices, priceHistory, anthropicApiKey } = contestData;

    if (!anthropicApiKey) {
      return NextResponse.json(
        { error: "Anthropic API key not configured. Set it in Settings." },
        { status: 400 }
      );
    }

    const reportData = buildReportData(players, trades, currentPrices, priceHistory);
    const commentary = await generateCommentary(reportData, anthropicApiKey);
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
