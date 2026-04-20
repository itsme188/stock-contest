import { NextResponse } from "next/server";
import { getContestData, saveContestData } from "@/lib/db";
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
    const body = (await request.json().catch(() => ({}))) as {
      to?: string;
      commentary?: string;
      force?: boolean;
    };

    const testTo = body.to;
    const today = new Date().toISOString().split("T")[0];

    // Idempotency: refuse a second real send on the same day unless explicitly
    // forced. Test sends (body.to) bypass the check so dry-runs can be retried.
    if (!testTo && !body.force) {
      const { lastWeeklyEmailSentDate } = getContestData();
      if (lastWeeklyEmailSentDate === today) {
        return NextResponse.json({
          ok: true,
          skipped: true,
          reason: "already_sent_today",
          reportDate: today,
          lastWeeklyEmailSentDate,
        });
      }
    }

    // Backfill price history so "this week" calculations are accurate (90s timeout)
    try {
      await Promise.race([
        backfillPrices(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Backfill timed out")), 90_000)),
      ]);
    } catch (err) {
      console.warn(`[Weekly Email] Backfill issue: ${err instanceof Error ? err.message : err}. Proceeding with available prices.`);
    }

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
    // Optional "to" override for test sends (testTo declared at top)
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
    if (!preGenerated) {
      console.log(`[Weekly Email] VK market context: ${marketContext ? `${marketContext.length} chars` : "empty (fetch failed)"}`);
    }
    const commentary =
      preGenerated ||
      (await generateCommentary(reportData, anthropicApiKey, aiModel, marketContext));

    await sendWeeklyEmail(
      { gmailAddress, gmailAppPassword, anthropicApiKey, playerEmails: effectiveEmails },
      reportData,
      commentary
    );

    // Only record real sends (not dry-runs to a test address) so the next
    // scheduled or manual call on the same day is treated as a duplicate.
    if (!testTo) {
      saveContestData({ lastWeeklyEmailSentDate: reportData.reportDate });
    }

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
