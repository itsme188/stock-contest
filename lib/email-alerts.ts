// Failure-alert email sender — Phase 2 of the reliability overhaul.
//
// When the standalone scheduled scripts hit any failure path (price refresh
// blew up, recipients=0, AI violations residual, backfill timed out twice),
// they call sendFailureAlert() which fires a small plain-text email to the
// operator (isaac@wolfsonfamily.com) using the same Gmail SMTP transport.
//
// Recipient is hardcoded — operator alerts are distinct from contest output
// (`playerEmails`). If Gmail credentials are missing the alert silently
// no-ops (we'd have nowhere to send it anyway), but logs to console so a
// follow-up audit can spot it.

import nodemailer from "nodemailer";
import { getContestData } from "@/lib/db";

const ALERT_RECIPIENT = "isaac@wolfsonfamily.com";

export interface AlertContext {
  /** Where the failure originated, e.g. "weekly-email", "daily-refresh". */
  source: string;
  /** Short reason for the subject line (under ~60 chars). */
  reason: string;
  /** Free-text body — error stack, last log lines, what was tried, etc. */
  details: string;
  /** Full subject-line override. Default: "[Stock Contest] <source> failed: <reason>" —
   *  use this for non-failure notices so the subject doesn't claim "failed". */
  subjectLine?: string;
}

export async function sendFailureAlert(ctx: AlertContext): Promise<{ ok: boolean; reason?: string }> {
  const { gmailAddress, gmailAppPassword } = getContestData();
  if (!gmailAddress || !gmailAppPassword) {
    console.warn(
      `[alert] Gmail credentials not configured — cannot send failure alert. Source: ${ctx.source}, reason: ${ctx.reason}`
    );
    return { ok: false, reason: "no-credentials" };
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailAddress, pass: gmailAppPassword },
  });

  const subject = (ctx.subjectLine ?? `[Stock Contest] ${ctx.source} failed: ${ctx.reason}`).slice(0, 200);
  const body = [
    `Source: ${ctx.source}`,
    `Reason: ${ctx.reason}`,
    `Time:   ${new Date().toISOString()}`,
    "",
    "--- Details ---",
    ctx.details,
  ].join("\n");

  try {
    await transporter.sendMail({
      from: `"Stock Contest Alerts" <${gmailAddress}>`,
      to: ALERT_RECIPIENT,
      subject,
      text: body,
    });
    return { ok: true };
  } catch (err) {
    // Don't throw — we're already in the failure-handling path; failing to
    // alert about a failure should not crash the script. Log and move on.
    console.error(
      `[alert] Failed to send failure alert: ${err instanceof Error ? err.message : err}`
    );
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
