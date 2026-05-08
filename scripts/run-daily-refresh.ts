#!/usr/bin/env -S npx tsx
// Standalone daily price-refresh runner — Phase 1 of the reliability overhaul.
// Decoupled from `npm run dev`: launchd jobs no longer require localhost:3001.
//
// Manual invocation:
//   cd ~/Desktop/stock-contest && npx tsx scripts/run-daily-refresh.ts
//
// See run-weekly-email.ts for the launchd/TCC consideration.

import { refreshAllOpenPrices, NoOpenPositionsError } from "../lib/prices-refresh";
import { backfillPrices } from "../lib/prices";
import { sendFailureAlert } from "../lib/email-alerts";
import { recordEmailSend } from "../lib/db";

function logStep(step: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
}

async function failAndAlert(reason: string, details: string): Promise<never> {
  recordEmailSend({
    kind: "daily-refresh",
    status: "error",
    errorMessage: `${reason}: ${details}`.slice(0, 2000),
  });
  await sendFailureAlert({ source: "daily-refresh", reason, details });
  process.exit(1);
}

async function main() {
  logStep("start", "daily refresh");

  try {
    const refresh = await refreshAllOpenPrices();
    logStep(
      "refresh",
      `source=${refresh.source}, fresh=${refresh.pricesAreFresh}, retries=${refresh.staleRetries}, updated=${Object.keys(refresh.updated).length}, errors=${refresh.errors.length}`
    );
    if (refresh.errors.length > 0) {
      logStep("refresh", `errors: ${refresh.errors.slice(0, 5).join("; ")}`);
    }
  } catch (err) {
    if (err instanceof NoOpenPositionsError) {
      logStep("refresh", "no open positions — exiting cleanly");
      recordEmailSend({ kind: "daily-refresh", status: "ok" });
      process.exit(0);
    }
    const msg = err instanceof Error ? err.message : String(err);
    logStep("refresh", `FAILED: ${msg}`);
    await failAndAlert("Price refresh failed", msg);
  }

  try {
    const r = await backfillPrices();
    logStep("backfill", `tickers=${r.tickers}, daysAdded=${r.daysAdded}, errors=${r.errors.length}`);
  } catch (err) {
    logStep("backfill", `FAILED (non-fatal): ${err instanceof Error ? err.message : err}`);
    // Don't exit 1 — the refresh succeeded; backfill is best-effort.
  }

  recordEmailSend({ kind: "daily-refresh", status: "ok" });
  logStep("end", "ok");
  process.exit(0);
}

main().catch((err) => {
  console.error("[uncaught]", err);
  process.exit(1);
});
