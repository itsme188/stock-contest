import { NextResponse } from "next/server";
import { getContestData } from "@/lib/db";
import { type Player, type Trade } from "@/lib/contest";
import {
  buildReportData,
  generateCommentary,
  sendWeeklyEmail,
} from "@/lib/email";

export async function POST() {
  try {
    const contestData = getContestData();
    const players = contestData.players as Player[];
    const trades = contestData.trades as Trade[];
    const {
      currentPrices,
      gmailAddress,
      gmailAppPassword,
      anthropicApiKey,
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
    const recipients = Object.values(playerEmails).filter(Boolean);
    if (recipients.length === 0) {
      return NextResponse.json(
        { error: "No recipient email addresses configured." },
        { status: 400 }
      );
    }

    const reportData = buildReportData(players, trades, currentPrices);
    const commentary = await generateCommentary(reportData, anthropicApiKey);
    await sendWeeklyEmail(
      { gmailAddress, gmailAppPassword, anthropicApiKey, playerEmails },
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
