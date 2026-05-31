// Process-wide serializer for IBKR/Polygon price fetches.
//
// The daily-refresh and weekly-email launchd jobs hit the same Next.js process
// and share two scarce resources: the IBKR API client id (CLIENT_ID = 2 — TWS
// rejects a second concurrent connection with the same id) and the Polygon
// free-tier quota (5 calls/min, shared across every endpoint). If both jobs wake
// at the same minute (e.g. a late wake on a mobile Friday), their fetches would
// collide. withPriceLock chains every fetch leaf so at most one runs at a time.
//
// IMPORTANT: wrap only non-nested leaves. A wrapped function that awaits another
// wrapped function would deadlock (the inner call is queued behind the outer,
// which never completes because it is waiting on the inner). The four wrapped
// leaves — refreshIbkrPrices, refreshPolygonPrices, backfillViaIBKR,
// backfillViaPolygon — never call one another; orchestrators (refreshAllOpenPrices,
// backfillPrices, backfillBenchmark) stay unlocked and call leaves sequentially.

let chain: Promise<unknown> = Promise.resolve();

export function withPriceLock<T>(fn: () => Promise<T>): Promise<T> {
  // Run fn once whatever is currently queued settles (resolved or rejected).
  const run = chain.then(fn, fn);
  // Advance the queue, swallowing this run's outcome so one failure can't reject
  // the next queued operation. The caller still receives `run`'s real result.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
