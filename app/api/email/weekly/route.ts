import { NextResponse } from "next/server";
import { runWeeklyEmail, WeeklyEmailConfigError, StalePricesError } from "@/lib/email-flow";
import { recordEmailSend } from "@/lib/db";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      to?: string;
      commentary?: string;
      force?: boolean;
    };

    const result = await runWeeklyEmail({
      testTo: body.to,
      force: body.force,
      preGeneratedCommentary: body.commentary,
    });

    if (result.skipped) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: result.reason,
        reportDate: result.reportDate,
      });
    }

    return NextResponse.json({
      ok: true,
      reportDate: result.reportDate,
      recipients: result.recipients,
      violations: result.violations,
      backfillFailed: result.backfillFailed,
      vk: result.vk,
      highlightsWarnings: result.highlightsWarnings,
    });
  } catch (err) {
    if (err instanceof WeeklyEmailConfigError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof StalePricesError) {
      // Record the stale-price refusal so the dashboard surfaces it and the
      // user knows why the send didn't go through.
      recordEmailSend({
        kind: "weekly",
        status: "error",
        errorMessage: err.message.slice(0, 2000),
      });
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      {
        error: `Failed to send weekly email: ${err instanceof Error ? err.message : err}`,
      },
      { status: 500 }
    );
  }
}
