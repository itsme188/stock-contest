import { NextResponse } from "next/server";
import { getContestData } from "@/lib/db";
import { type Player, type Trade } from "@/lib/contest";
import {
  buildReportData,
  generateCommentary,
  sendWeeklyEmail,
} from "@/lib/email";
import { fetchVitalKnowledge } from "@/lib/vital-knowledge";
import { backfillPrices } from "@/lib/prices";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    // Backfill price history so "this week" calculations are accurate
    await backfillPrices();

    const contestData = getContestData();
    const players = contestData.players as Player[];
    const trades = contestData.trades as Trade[];
    const {
      currentPrices,
      priceHistory,
      gmailAddress,
      gmailAppPassword,
      anthropicApiKey,
      aiModel,
      playerEmails,
    } = contestData;

    if (!gmailAddress || !gmailAppPassword) {
      return NextResponse.json(
        { error: "Gmail credentials not configured. Set them in Settings." },
        { status: 400 }
      );
    }
    if (!anthropicApiKey) {
      return NextResponse.json(
        { error: "Anthropic API key not configured. Set it in Settings." },
        { status: 400 }
      );
    }
    // Optional "to" override for test sends
    const testTo = (body as { to?: string }).to;
    const effectiveEmails = testTo
      ? { _test: testTo }
      : playerEmails;
    const recipients = Object.values(effectiveEmails).filter(Boolean);
    if (recipients.length === 0) {
      return NextResponse.json(
        { error: "No recipient email addresses configured." },
        { status: 400 }
      );
    }

    const reportData = buildReportData(players, trades, currentPrices, priceHistory);

    // Use pre-generated commentary from preview page, or generate fresh
    const preGenerated = (body as { commentary?: string }).commentary;
    const marketContext = preGenerated
      ? "" // VK context already baked into pre-generated commentary
      : await fetchVitalKnowledge(gmailAddress, gmailAppPassword);
    const commentary =
      preGenerated ||
      (await generateCommentary(reportData, anthropicApiKey, aiModel, marketContext));

    await sendWeeklyEmail(
      { gmailAddress, gmailAppPassword, anthropicApiKey, playerEmails: effectiveEmails },
      reportData,
      commentary
    );

    return NextResponse.json({
      ok: true,
      reportDate: reportData.reportDate,
      recipients: recipients.length,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to send weekly email: ${err instanceof Error ? err.message : err}`,
      },
      { status: 500 }
    );
  }
}
