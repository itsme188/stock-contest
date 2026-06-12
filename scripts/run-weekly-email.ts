#!/usr/bin/env -S npx tsx
// Standalone weekly-email runner — Phase 1 of the reliability overhaul.
//
// This is the new single source of truth for "send the weekly email":
// preview (web), manual `npm run email:send`, and the launchd job all flow
// through `runWeeklyEmail()` in lib/email-flow.ts. No `localhost:3001`
// dependency: the schedule no longer requires `npm run dev` to be up.
//
// Manual invocation:
//   cd ~/Desktop/stock-contest && npx tsx scripts/run-weekly-email.ts [--to=addr] [--force]
//
// Note on launchd: macOS TCC blocks launchd-spawned binaries from reading
// files under ~/Desktop/. To make this script run from launchd, either move
// the project off Desktop or grant Full Disk Access to /opt/homebrew/bin/node
// (System Settings > Privacy & Security > Full Disk Access). Manual
// invocation from Terminal works regardless because Terminal has its own
// consented Desktop access.

// Phase 7 (2026-05-08): runWeeklyEmail() now handles refresh + backfill
// internally with a hard freshness gate. The script's job is reduced to
// benchmark refresh (which lives outside the email flow) + invoking
// runWeeklyEmail. This avoids the previous double-refresh waste.
import { backfillBenchmark } from "../lib/prices";
import { runWeeklyEmail, StalePricesError } from "../lib/email-flow";
import { sendFailureAlert } from "../lib/email-alerts";
import { recordEmailSend } from "../lib/db";

interface CliArgs {
  to?: string;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a.startsWith("--to=")) args.to = a.slice("--to=".length);
    else if (a === "--to" && argv[i + 1]) {
      args.to = argv[i + 1];
      i++;
    }
  }
  return args;
}

function logStep(step: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
}

async function refreshBenchmark(): Promise<boolean> {
  try {
    const r = await backfillBenchmark();
    logStep("benchmark", `daysAdded=${r.daysAdded}, errors=${r.errors.length}`);
    return true;
  } catch (err) {
    logStep("benchmark", `FAILED (non-fatal): ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function failAndAlert(reason: string, details: string): Promise<never> {
  recordEmailSend({ kind: "weekly", status: "error", errorMessage: `${reason}: ${details}`.slice(0, 2000) });
  await sendFailureAlert({ source: "weekly-email", reason, details });
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  logStep("start", `args=${JSON.stringify(args)}`);

  // Benchmark refresh runs first because the email's performance chart
  // needs SPY history; it's outside runWeeklyEmail's scope.
  await refreshBenchmark();

  try {
    const result = await runWeeklyEmail({
      testTo: args.to,
      force: args.force,
    });

    if (result.skipped) {
      logStep("email", `skipped: ${result.reason}`);
      process.exit(0);
    }

    logStep(
      "refresh",
      `source=${result.refresh.source}, fresh=${result.refresh.pricesAreFresh}, retries=${result.refresh.staleRetries}, updated=${result.refresh.tickersUpdated}`
    );
    logStep(
      "email",
      `sent to ${result.recipients} recipient(s); reportDate=${result.reportDate}`
    );
    logStep(
      "email",
      `commentary attempts=${result.violations.attempts}, numeric=${result.violations.numeric}, ranking=${result.violations.ranking}, missedTrades=${result.violations.missedTrades}, unknownTickers=${result.violations.unknownTickers}, verifierErrors=${result.violations.verifierErrors}`
    );
    if (
      result.violations.missedTrades > 0 ||
      result.violations.unknownTickers > 0 ||
      result.violations.verifierErrors > 0
    ) {
      logStep("email", "WARNING: residual violations after retries — see audit row");
      if (result.violations.verifierErrorDetail.length > 0) {
        for (const err of result.violations.verifierErrorDetail) {
          logStep("email", `  verifier: ${err.slice(0, 200)}`);
        }
      }
    }
    const degraded: string[] = [];
    if (result.highlightsWarnings.length > 0) {
      logStep("email", `highlights warnings: ${result.highlightsWarnings.join("; ")}`);
      degraded.push(`Highlights excluded tickers:\n  ${result.highlightsWarnings.join("\n  ")}`);
    }
    if (result.backfillFailed) {
      logStep("email", "WARNING: backfill failed earlier; week deltas may use stale prices");
      degraded.push("Backfill failed — week-over-week deltas may use the most recent available close.");
    }
    if (result.vk.fetchFailed) {
      logStep("email", "WARNING: VK creds configured but fetch returned 0 chars");
      degraded.push("Vital Knowledge market context was unavailable (creds configured, 0 chars returned).");
    }
    if (degraded.length > 0) {
      // Non-fatal: the weekly email DID go out; this tells the operator that it
      // shipped with known data gaps, without requiring an audit-table check.
      // Residual AI-commentary violations are deliberately NOT included here —
      // they have their own audit path (email_sends row + verifier log lines).
      try {
        await sendFailureAlert({
          source: "weekly-email",
          reason: "sent OK but with degraded data",
          subjectLine: "[Stock Contest] weekly-email: sent with degraded data",
          details:
            degraded.join("\n\n") +
            `\n\nreportDate=${result.reportDate}, recipients=${result.recipients}`,
        });
        logStep("email", "degraded-data alert sent to operator");
      } catch (alertErr) {
        // A degraded-data notice must never convert a successful send into a
        // failure (the outer catch would exit 1 and audit-log an error).
        logStep(
          "email",
          `degraded-data alert failed to send (non-fatal): ${alertErr instanceof Error ? alertErr.message : alertErr}`
        );
      }
    }
    if (result.recipients === 0) {
      // Silent-success bug guard: even though the API path returned ok,
      // recipients=0 means no email actually went out.
      logStep("email", "ERROR: 0 recipients sent — failing the run");
      await failAndAlert(
        "Email sent to 0 recipients (silent-success bug)",
        `runWeeklyEmail() returned ok=true but recipients=0. Check Settings > Player Emails. reportDate=${result.reportDate}`
      );
    }

    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? "" : "";
    if (err instanceof StalePricesError) {
      // Specific failure path so the alert subject is clear: data was
      // stale; we refused to ship Thursday-data-as-Friday.
      logStep("email", `REFUSED: ${msg}`);
      await failAndAlert("Refused to send: stale prices", msg);
    }
    logStep("email", `FAILED: ${msg}`);
    if (stack) console.error(stack);
    await failAndAlert(msg, stack || msg);
  }
}

main().catch((err) => {
  console.error("[uncaught]", err);
  process.exit(1);
});
