import nodemailer from "nodemailer";
import Anthropic from "@anthropic-ai/sdk";
import {
  type Player,
  type Trade,
  type LeaderboardEntry,
  getLeaderboard,
  getPlayerStats,
  getPlayerValueAtDate,
  getCurrentPrice,
  getPriceAtDate,
  formatCurrency,
  formatPercent,
} from "@/lib/contest";
import {
  formatDateDisplay,
  formatLocalYMD,
  localToday,
  parseLocalDate,
} from "@/lib/dates";

// ---------- Types ----------

export interface EmailConfig {
  gmailAddress: string;
  gmailAppPassword: string;
  anthropicApiKey: string;
  playerEmails: Record<string, string>;
}

export interface PlayerWeekDelta {
  playerId: string;
  name: string;
  weekChange: number;
  weekChangePct: number;
  rankChange: number; // positive = moved up
  realizedGains: number;
  unrealizedGains: number;
  winRate: number;
}

export interface WeeklyReportData {
  leaderboard: LeaderboardEntry[];
  weeklyTrades: Trade[];
  weekDeltas: PlayerWeekDelta[];
  players: Player[];
  trades: Trade[];
  currentPrices: Record<string, number>;
  priceHistory: Record<string, Record<string, number>>;
  reportDate: string;
}

// ---------- Data Assembly ----------

// Returns the UNIX millisecond timestamp for 4:00 PM America/New_York (NYSE
// market close) on the given YYYY-MM-DD. The weekly email window closes at
// market close, so trades executed after 4:00 PM ET on Friday roll into the
// following week rather than getting double-counted across two emails.
export function getMarketCloseTimestamp(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  // 4:00 PM EDT = 20:00 UTC; 4:00 PM EST = 21:00 UTC. Guess EDT, then check.
  const edtGuess = Date.UTC(y, m - 1, d, 20, 0, 0);
  const tzName =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "short",
    })
      .formatToParts(new Date(edtGuess))
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return tzName === "EDT" ? edtGuess : edtGuess + 3600 * 1000;
}

export function getWeeklyTrades(trades: Trade[], asOfDate?: string): Trade[] {
  const reportDate = asOfDate || localToday();
  const endTs = getMarketCloseTimestamp(reportDate);
  const startTs = endTs - 7 * 24 * 60 * 60 * 1000;
  // Half-open window (startTs, endTs]: a trade at the start cutoff belongs to
  // the previous week's email, not this one.
  return trades
    .filter((t) => t.timestamp > startTs && t.timestamp <= endTs)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function buildReportData(
  players: Player[],
  trades: Trade[],
  currentPrices: Record<string, number>,
  priceHistory: Record<string, Record<string, number>> = {},
  asOfDate?: string
): WeeklyReportData {
  const reportDate = asOfDate || localToday();
  const endTs = getMarketCloseTimestamp(reportDate);
  const startTs = endTs - 7 * 24 * 60 * 60 * 1000;
  const oneWeekAgo = parseLocalDate(reportDate);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const cutoffDate = formatLocalYMD(oneWeekAgo);

  const currentLeaderboard = getLeaderboard(players, trades, currentPrices);

  // Previous week's rankings use trades executed at or before the start cutoff
  // (last Friday 4:00 PM ET). Used only for rank-change detection.
  const previousTrades = trades.filter((t) => t.timestamp <= startTs);
  const previousLeaderboard = getLeaderboard(players, previousTrades, currentPrices);

  const weekDeltas: PlayerWeekDelta[] = currentLeaderboard.map((current, currentRank) => {
    const previous = previousLeaderboard.find((p) => p.id === current.id);
    const previousRank = previous
      ? previousLeaderboard.indexOf(previous)
      : currentRank;
    // Feed the timestamp-filtered trade set to getPlayerValueAtDate so its
    // internal date filter can't silently re-add same-day-after-close trades.
    const prevValue = getPlayerValueAtDate(current.id, cutoffDate, previousTrades, priceHistory);
    const weekChange = current.totalValue - prevValue;
    return {
      playerId: current.id,
      name: current.name,
      weekChange,
      weekChangePct: prevValue !== 0 ? (weekChange / prevValue) * 100 : 0,
      rankChange: previousRank - currentRank, // positive = moved up
      realizedGains: current.realizedGains,
      unrealizedGains: current.unrealizedGains,
      winRate: current.winRate,
    };
  });

  return {
    leaderboard: currentLeaderboard,
    weeklyTrades: getWeeklyTrades(trades, asOfDate),
    weekDeltas,
    players,
    trades,
    currentPrices,
    priceHistory,
    reportDate,
  };
}

// ---------- AI Commentary ----------

const BANNED_WORDS = [
  // Original list
  "delve", "landscape", "paradigm", "tapestry", "multifaceted",
  "in terms of", "it's important to note", "it's worth noting",
  "notably", "noteworthy", "navigate", "leverage", "robust",
  "comprehensive", "cutting-edge", "synergy", "game-changer",
  "deep dive", "at the end of the day", "moving forward",
  "circle back", "touch base", "low-hanging fruit", "underscore",
  "underscores", "realm", "foster", "pivotal", "crucial",
  "arguably", "essentially", "fundamentally",
  // AI tells from Wikipedia/research
  "elevate", "elevated", "resonate", "resonates", "dynamic",
  "seamless", "seamlessly", "nuanced", "testament", "unprecedented",
  "moreover", "embark", "intricate", "captivate", "captivating",
  "ever-evolving", "harness", "unlock", "streamline",
  "proactive", "proactively",
  // Rhetorical patterns / glazing
  "it's not just", "not just", "let's be clear", "I have to say",
  "impressive", "exciting", "fantastic", "incredible", "remarkable",
];

// ---------- Deterministic Weekly Highlights ----------
//
// The AI prompt historically asked the model to identify the biggest gainer,
// best/worst position per player, and attribute weekly % changes — and it
// routinely got these wrong (leading with narratively-convenient tickers
// instead of the actual top mover, assigning weekly % to positions that
// didn't exist at week-start, fabricating values). These are deterministic
// computations; code does them and the email renders the result directly.
// The AI then writes prose ABOVE/AROUND these facts, not IN PLACE of them.

export interface PlayerHighlight {
  playerId: string;
  name: string;
  best: { ticker: string; pct: number } | null;
  worst: { ticker: string; pct: number } | null;
  newThisWeek: string[];
  tradeCount: number;
}

export interface WeeklyHighlights {
  contestTop: { ticker: string; pct: number; player: string } | null;
  contestBottom: { ticker: string; pct: number; player: string } | null;
  perPlayer: PlayerHighlight[];
  // Tickers excluded from rankings because their weekly price-change couldn't
  // be computed (missing priceHistory entry for the week-ago cutoff date).
  // Surfaced to the caller so a partial-data send can be flagged in the audit
  // log and trigger a failure-alert email rather than silently shipping
  // incomplete highlights.
  warnings: string[];
}

export function buildWeeklyHighlights(data: WeeklyReportData): WeeklyHighlights {
  const { leaderboard, weeklyTrades, currentPrices, priceHistory, trades, reportDate } = data;

  const now = parseLocalDate(reportDate);
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const cutoffDate = formatLocalYMD(oneWeekAgo);

  const isNewThisWeek = (pos: { ticker: string; trades: Trade[] }) =>
    pos.trades.length > 0 && pos.trades.every((t) => t.date >= cutoffDate);

  const warnings: string[] = [];
  const perPlayer: PlayerHighlight[] = leaderboard.map((p) => {
    const moves = p.positions
      .filter((pos) => !isNewThisWeek(pos))
      .map((pos) => {
        const curPrice = getCurrentPrice(pos.ticker, currentPrices, trades);
        const weekAgoPrice = getPriceAtDate(pos.ticker, cutoffDate, priceHistory);
        if (!weekAgoPrice || weekAgoPrice <= 0) {
          warnings.push(
            `${pos.ticker} (${p.name}): excluded from highlights — no priceHistory for ${cutoffDate}`
          );
          return null;
        }
        const pct = ((curPrice - weekAgoPrice) / weekAgoPrice) * 100;
        return { ticker: pos.ticker, pct };
      })
      .filter((x): x is { ticker: string; pct: number } => x !== null);
    const sorted = [...moves].sort((a, b) => b.pct - a.pct);
    const best = sorted[0] ?? null;
    const worst = sorted.length > 1 ? sorted[sorted.length - 1] : null;
    const newThisWeek = p.positions.filter(isNewThisWeek).map((pos) => pos.ticker);
    const tradeCount = weeklyTrades.filter((t) => t.playerId === p.id).length;
    return { playerId: p.id, name: p.name, best, worst, newThisWeek, tradeCount };
  });

  const allMoves = perPlayer.flatMap((ph) => {
    const picks: Array<{ ticker: string; pct: number; player: string }> = [];
    if (ph.best) picks.push({ ...ph.best, player: ph.name });
    if (ph.worst) picks.push({ ...ph.worst, player: ph.name });
    return picks;
  });
  const sortedAll = [...allMoves].sort((a, b) => b.pct - a.pct);
  const contestTop = sortedAll[0] ?? null;
  const contestBottom = sortedAll.length > 1 ? sortedAll[sortedAll.length - 1] : null;

  return { contestTop, contestBottom, perPlayer, warnings };
}

export function renderHighlightsHtml(h: WeeklyHighlights): string {
  const fmtMove = (m: { ticker: string; pct: number; player?: string }) =>
    `<strong>${m.ticker}</strong> ${formatPercent(m.pct)}${m.player ? ` <span style="color: #6B7280;">(${m.player})</span>` : ""}`;
  // Labels say "7-day move" rather than "top mover" / "best" so the reader
  // (and any downstream LLM eyeballing it) doesn't mistake a price-change
  // ranking for a "best trade" claim. A position opened mid-week is
  // excluded from this ranking precisely because the ticker's 7-day move is
  // not the player's return on that position.
  const contestLines: string[] = [];
  if (h.contestTop) contestLines.push(`<div style="margin: 4px 0;"><span style="color: #6B7280;">Best 7-day move:</span> ${fmtMove(h.contestTop)}</div>`);
  if (h.contestBottom && h.contestBottom.ticker !== h.contestTop?.ticker) {
    contestLines.push(`<div style="margin: 4px 0;"><span style="color: #6B7280;">Worst 7-day move:</span> ${fmtMove(h.contestBottom)}</div>`);
  }
  const playerLines = h.perPlayer.map((ph) => {
    const parts: string[] = [];
    if (ph.best) parts.push(`best 7-day ${fmtMove(ph.best)}`);
    if (ph.worst && ph.worst.ticker !== ph.best?.ticker) parts.push(`worst 7-day ${fmtMove(ph.worst)}`);
    if (ph.newThisWeek.length > 0) parts.push(`new: <strong>${ph.newThisWeek.join(", ")}</strong>`);
    parts.push(`${ph.tradeCount} trade${ph.tradeCount === 1 ? "" : "s"}`);
    return `<div style="margin: 6px 0; font-size: 13px;"><strong style="color: #111827;">${ph.name}:</strong> <span style="color: #4B5563;">${parts.join(" · ")}</span></div>`;
  }).join("");
  return `<div style="padding: 20px 24px; border-bottom: 1px solid #E5E7EB; background: #FAFAFA;">
    <h2 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 700; color: #111827; text-transform: uppercase; letter-spacing: 0.05em;">7-Day Price Moves (open positions only)</h2>
    <div style="font-size: 14px; color: #111827; margin-bottom: 10px;">${contestLines.join("")}</div>
    <div>${playerLines}</div>
  </div>`;
}

export function buildCommentaryPrompt(data: WeeklyReportData, marketContext?: string): string {
  const { leaderboard, weeklyTrades, weekDeltas, players, currentPrices, priceHistory, trades, reportDate } = data;

  const now = parseLocalDate(reportDate);
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const cutoffDate = formatLocalYMD(oneWeekAgo);

  // A position is "new this week" if the player did not hold any shares of
  // it at the start of the week — in that case the ticker's 7-day price
  // change is NOT this player's position return and should be excluded.
  const isPositionNewThisWeek = (pos: { ticker: string; trades: Trade[] }) =>
    pos.trades.length > 0 && pos.trades.every((t) => t.date >= cutoffDate);

  const standingsSummary = leaderboard
    .map((p, i) => {
      const delta = weekDeltas.find((d) => d.playerId === p.id);
      const positionList = p.positions
        .map((pos) => {
          const curPrice = getCurrentPrice(pos.ticker, currentPrices, trades);
          const deployed = pos.totalCost;
          const currentValue = pos.shares * curPrice;
          const gain = currentValue - deployed;
          const gainPct = deployed !== 0 ? (gain / deployed) * 100 : 0;
          // Weekly price change — ONLY for positions held at week-start.
          // New-this-week positions get no "% this week" because the ticker's
          // 7-day move is not the player's position return.
          let weekStr = "";
          if (isPositionNewThisWeek(pos)) {
            weekStr = `, NEW THIS WEEK (no weekly return)`;
          } else {
            const weekAgoPrice = getPriceAtDate(pos.ticker, cutoffDate, priceHistory);
            const weekPriceChange = weekAgoPrice && weekAgoPrice > 0
              ? ((curPrice - weekAgoPrice) / weekAgoPrice) * 100
              : null;
            if (weekPriceChange !== null) {
              weekStr = `, ${weekPriceChange >= 0 ? "+" : ""}${formatPercent(weekPriceChange)} this week`;
            }
          }
          return `${pos.ticker}: ${pos.shares} shares, ${formatCurrency(deployed)} deployed, now worth ${formatCurrency(currentValue)} (${gain >= 0 ? "+" : ""}${formatPercent(gainPct)} total${weekStr})`;
        })
        .join("; ");
      const weekChangeStr = delta
        ? ` | Week: ${delta.weekChange >= 0 ? "+" : ""}${formatCurrency(delta.weekChange)} (${formatPercent(delta.weekChangePct)})`
        : "";
      const rankStr = delta && delta.rankChange !== 0
        ? ` | Rank: ${delta.rankChange > 0 ? `up ${delta.rankChange}` : `down ${Math.abs(delta.rankChange)}`}`
        : "";
      const realizedStr = ` | Realized P&L: ${formatCurrency(p.realizedGains)} | Win rate: ${p.closedTrades.length > 0 ? `${p.winningTrades}/${p.closedTrades.length}` : "n/a"}`;
      return `${i + 1}. ${p.name}: ${formatCurrency(p.totalValue)} (${formatPercent(p.returnPct)}) | Cash: ${formatCurrency(p.cashRemaining)}${weekChangeStr}${rankStr}${realizedStr} | Positions: ${positionList || "none"}`;
    })
    .join("\n");

  // Pre-compute which players hold each ticker so the AI doesn't have to
  // derive cross-portfolio attribution from the standings table (it was
  // getting this wrong — claimed LFMD was held "across all portfolios" when
  // only two of three held it).
  const tickerToHolders = new Map<string, string[]>();
  leaderboard.forEach((p) => {
    p.positions.forEach((pos) => {
      const list = tickerToHolders.get(pos.ticker) ?? [];
      list.push(p.name);
      tickerToHolders.set(pos.ticker, list);
    });
  });
  const crossHoldingsSummary =
    tickerToHolders.size > 0
      ? Array.from(tickerToHolders.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([ticker, holders]) =>
            holders.length === 1
              ? `- ${ticker}: held by ${holders[0]} only`
              : `- ${ticker}: held by ${holders.join(", ")}`
          )
          .join("\n")
      : "- (no open positions)";

  // Enrich weekly trades with partial/full-close status and realized P&L so
  // the AI doesn't mistake a trim for a full exit (Eli's WLTH sell on Apr 17
  // was a partial, but the prompt didn't say so).
  const tradeAnnotations = new Map<string, string>();
  for (const player of players) {
    const pTrades = trades
      .filter((t) => t.playerId === player.id)
      .sort((a, b) => a.timestamp - b.timestamp);
    const lots: Record<string, Array<{ shares: number; price: number }>> = {};
    const totalShares: Record<string, number> = {};
    const weeklyIds = new Set(weeklyTrades.map((w) => w.id));
    for (const t of pTrades) {
      lots[t.ticker] ??= [];
      totalShares[t.ticker] ??= 0;
      if (t.type === "buy") {
        const hadAny = totalShares[t.ticker] > 0;
        lots[t.ticker].push({ shares: t.shares, price: t.price });
        totalShares[t.ticker] += t.shares;
        if (weeklyIds.has(t.id)) {
          tradeAnnotations.set(
            t.id,
            hadAny
              ? `adds to existing position (now ${totalShares[t.ticker]} shares)`
              : "new position"
          );
        }
      } else {
        const sharesBefore = totalShares[t.ticker];
        let toSell = t.shares;
        let costBasis = 0;
        while (toSell > 0 && lots[t.ticker].length > 0) {
          const lot = lots[t.ticker][0];
          const use = Math.min(toSell, lot.shares);
          costBasis += use * lot.price;
          toSell -= use;
          lot.shares -= use;
          if (lot.shares === 0) lots[t.ticker].shift();
        }
        totalShares[t.ticker] -= t.shares;
        const realized = t.shares * t.price - costBasis;
        if (weeklyIds.has(t.id)) {
          const remaining = totalShares[t.ticker];
          // Show the before → after transition so the AI can't confuse the
          // sell count with the remaining-shares count (e.g., sold 1194 of a
          // 2389-share position, leaving 1195).
          const closeType =
            remaining <= 0
              ? "FULL CLOSE (position exited)"
              : `PARTIAL TRIM (position: ${sharesBefore} shares -> ${remaining} remaining)`;
          const realizedStr = `realized ${realized >= 0 ? "+" : ""}${formatCurrency(realized)}`;
          tradeAnnotations.set(t.id, `${closeType}, ${realizedStr}`);
        }
      }
    }
  }

  // Per-player → per-ticker trade blocks (Phase 6+X, 2026-05-08).
  //
  // Earlier iterations had two failure modes:
  //   1. Flat list intermingled players → wrong-attribution ("Eli sold INTC"
  //      when only Yitzi did).
  //   2. Per-trade list grouped by player only → AI couldn't summarize
  //      counts or days correctly ("three tranches on May 6" when it was
  //      two; "APP opened Friday" when it was Thursday).
  //
  // Per-ticker grouping with a header summary (counts + intent +
  // partial/full-close indicator) gives the AI structure to copy verbatim:
  // the count is in the header, days are explicit on each line, and the
  // "FULL CLOSE" annotation is on the row that closes. The AI doesn't have
  // to derive anything.
  //
  // Day-of-week is pre-computed (`Wed` not "Wednesday") because the AI gets
  // calendar arithmetic wrong (claimed 5/6/2026 was a Tuesday when it's a
  // Wednesday). Same lesson as the rest of the codebase.
  const dayOfWeekShort = (yyyymmdd: string): string => {
    const [y, m, d] = yyyymmdd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-US", {
      weekday: "short",
      timeZone: "UTC",
    });
  };
  const recentTradesSummary = (() => {
    if (weeklyTrades.length === 0) return "No trades this week.";
    const blocks: string[] = [];
    for (const player of players) {
      const playerTrades = weeklyTrades.filter((t) => t.playerId === player.id);
      if (playerTrades.length === 0) {
        blocks.push(`${player.name.toUpperCase()} (0 trades this week)`);
        continue;
      }

      // Group player's trades by ticker.
      const byTicker = new Map<string, Trade[]>();
      for (const t of playerTrades) {
        const list = byTicker.get(t.ticker) ?? [];
        list.push(t);
        byTicker.set(t.ticker, list);
      }

      const tickerBlocks: string[] = [];
      for (const [ticker, tTrades] of byTicker) {
        const buys = tTrades.filter((t) => t.type === "buy");
        const sells = tTrades.filter((t) => t.type === "sell");
        // Header summary: "2 sells, full exit" / "2 buys, adds to existing"
        const direction =
          buys.length > 0 && sells.length === 0
            ? `${buys.length} buy${buys.length === 1 ? "" : "s"}`
            : sells.length > 0 && buys.length === 0
            ? `${sells.length} sell${sells.length === 1 ? "" : "s"}`
            : `${buys.length} buy${buys.length === 1 ? "" : "s"} + ${sells.length} sell${sells.length === 1 ? "" : "s"}`;
        // Detect full-close from annotations (already computed above).
        const hasFullClose = tTrades.some((t) => {
          const ann = tradeAnnotations.get(t.id);
          return ann?.includes("FULL CLOSE");
        });
        const hasNewOpen = tTrades.some((t) => {
          const ann = tradeAnnotations.get(t.id);
          return ann === "new position";
        });
        const intentParts: string[] = [];
        if (hasFullClose) intentParts.push("full exit");
        if (hasNewOpen) intentParts.push("new position");
        if (!hasFullClose && !hasNewOpen) {
          if (sells.length > 0) intentParts.push("partial trims");
          if (buys.length > 0) intentParts.push("adds to existing");
        }
        const header = `  ${ticker} (${direction}${intentParts.length > 0 ? ", " + intentParts.join(" + ") : ""}):`;

        const rows = tTrades.map((t) => {
          const annotation = tradeAnnotations.get(t.id);
          const annStr = annotation ? ` — ${annotation}` : "";
          return `    - ${t.date} (${dayOfWeekShort(t.date)}): ${t.type.toUpperCase()} ${t.shares} @ ${formatCurrency(t.price)}${annStr}`;
        });

        tickerBlocks.push([header, ...rows].join("\n"));
      }

      blocks.push(
        `${player.name.toUpperCase()} (${playerTrades.length} trade${playerTrades.length === 1 ? "" : "s"}):\n${tickerBlocks.join("\n")}`
      );
    }
    return blocks.join("\n\n");
  })();

  // Required-topics checklist. The AI's prose MUST mention every (player,
  // ticker) tuple here at least once — coverage is enforced post-hoc by
  // detectFactualViolations() and triggers regeneration if the prose drops
  // a trade. Daddy's "(none)" entry is informational; if a player has no
  // trades the AI may briefly mention they stood pat (or omit if no trades
  // at all).
  const requiredTopics = (() => {
    if (weeklyTrades.length === 0) return "(no trades this week — write only the market-context paragraph)";
    const lines: string[] = [];
    for (const player of players) {
      const tickers = Array.from(
        new Set(weeklyTrades.filter((t) => t.playerId === player.id).map((t) => t.ticker))
      ).sort();
      if (tickers.length === 0) {
        lines.push(`- ${player.name}: no trades (mention briefly, e.g. "Daddy stood pat")`);
      } else {
        lines.push(`- ${player.name}: ${tickers.join(", ")}`);
      }
    }
    return lines.join("\n");
  })();

  return `You are a portfolio analyst writing the narrative section of a weekly investor letter for a family stock picking contest between three participants: Daddy, Eli, and Yitzi. Each started with $100,000 in virtual capital. Today's report date is ${reportDate}.

YOUR SCOPE IS INTENTIONALLY NARROW. All rankings, dollar amounts, percentages, and biggest-mover attributions are ALREADY rendered deterministically above your commentary in the email. The reader will see those facts separately. Your job is ONLY:

1. Market context — in one short paragraph (2-4 sentences), tie the week's activity to the broader market narrative using the MARKET CONTEXT below if provided. If no market context is available, skip this paragraph entirely.
2. Activity rationale — in one short paragraph (2-4 sentences), describe what was bought or sold this week and the likely reasoning. Each trade in "Trades this week" must be addressed by name or via a deliberate grouping (e.g., "Eli made two adds and a trim on the 21st"). Do not silently skip any trade.

HARD RULES — violations will be flagged:
- DO NOT quote any dollar amount. Not a position size, not a realized P&L, not a total value. No "$18,203", no "$100,000", no "$3,896 gain" — none.
- DO NOT quote any percentage. Not weekly, not total, not cost-basis. No "+20.50%", no "13.45%", no "-6.66%".
- DO NOT name a "best trade", "best performer", "biggest winner/loser", or "biggest gainer/laggard". DO NOT use ranking language: no "standout", "top pick", "led the charge", "clear winner", "dominated", "crushed". The deterministic highlights block above the commentary handles all rankings; your prose should focus on RATIONALE (why a trade was made, what context drove it), not on naming winners or losers.
- DO NOT list standings.
- Refer to tickers by name only (INTC, HOOD, etc.).
- Do NOT use the word "week" plus a percentage. Do NOT describe the portfolio's total move in dollar or percent terms.

PARTIAL vs FULL CLOSE: respect the annotation on each trade. "PARTIAL TRIM (position: N -> M remaining)" means the position is NOT closed. "FULL CLOSE" means exited. Never describe a partial as a full exit.

CROSS-PORTFOLIO CLAIMS: when mentioning which players hold a ticker, use the "Cross-portfolio holdings" list below verbatim. If only one player holds it, attribute to that one. If multiple hold it, name them. Never say "across all portfolios" / "by every player" unless that ticker is literally listed as held by all three.

NEW-THIS-WEEK POSITIONS — examples of correct phrasing:
✓ "Yitzi opened a HOOD stake in two tranches."
✓ "Eli initiated a new position in MDI.TO."
✗ "Yitzi opened HOOD as semiconductor strength returned." (ties a new open to a market move — implies a return that wasn't earned over the week)
✗ "Eli's new MDI.TO position has rallied since." (assigns a return to a position whose entry was mid-week — you don't have basis to compute it)
A new open may be MENTIONED but its performance MUST NOT be characterized.

EDGE CASES:
- If "Trades this week" says "No trades this week.": write only the market-context paragraph; omit the activity paragraph entirely. Do not invent activity.
- If only one trade occurred: address it specifically in 1-2 sentences within the activity paragraph; do not pad with generic narrative.

ATTRIBUTION DISCIPLINE (violations cause automatic regeneration):
- A player can ONLY be associated with the tickers in their block in "Trades this week" below. If you write "Eli ... INTC", Eli must have an INTC trade in this week's list. If you write "Both harvested INTC gains," BOTH players you're referring to must have INTC trades.
- Every (player, ticker) pair listed under "MUST mention" must appear together in your prose — adjacent or in the same sentence. Skipping a trade (or grouping it away vaguely) counts as a coverage violation.
- Do not invent tickers. Use only ticker symbols that appear in "Trades this week" or "Cross-portfolio holdings".

DATES & DAYS-OF-WEEK: each trade row has a parenthetical day-of-week ("2026-05-06 (Wed)"). USE THE PARENTHETICAL VERBATIM if you want to name a day; do NOT compute days yourself. If you write "on Wednesday", it must match a (Wed) row in the data. Equivalent: "on May 6" is always safe.

TONE: Dry, confident, matter-of-fact. Think Buffett's shareholder letters — plain English, short sentences, no jargon. Occasional dry wit about poor decisions is fine. Never flatter anyone.

BANNED: do not use these words/phrases: ${BANNED_WORDS.map((w) => `"${w}"`).join(", ")}. Never use "it's not X, it's Y" constructions. No glazing.

LENGTH: strictly 2 paragraphs, each 2-4 sentences (or 1 paragraph if no trades — see EDGE CASES). Do not write a "performance summary" — that's above your commentary already.

EXAMPLE (good — notice zero numbers, no ranking language, focus on WHY):
"Semiconductor strength defined the week, with the SOX index up strongly on renewed AI-capex guidance from hyperscalers. That lifted INTC across the portfolios that held it, more than offsetting softer reads from the small-cap consumer-facing names.

Eli was the most active, adding to four existing positions in the morning session and trimming HYDTF on Friday for a realized gain. Yitzi rotated out of CRCL at a loss and built a fresh HOOD stake in two tranches, trimming INTC later in the week to free up capital. Daddy stood pat, letting his existing holdings do the work."

REFERENCE DATA YOU MAY USE (for rationale narrative only — DO NOT quote numbers):

MUST mention (every (player, ticker) below must appear together in your prose):
${requiredTopics}

Trades this week (grouped by player — only these players traded these tickers this week):
${recentTradesSummary}

Cross-portfolio holdings (use these verbatim for attribution):
${crossHoldingsSummary}${marketContext ? `

MARKET CONTEXT (from Vital Knowledge newsletter digests this week):
${marketContext}` : ""}`;
}

export interface ViolationReport {
  numericViolations: number;
  rankingViolations: number;
  numericSnippets: string[];
  rankingSnippets: string[];
}

// Phrases that indicate the AI is asserting a ranking ("X was the best trade",
// "Y dominated the week"). The deterministic highlights block above the
// commentary already shows the rankings; the AI's prose should focus on
// rationale, not on naming winners and losers. Each pattern is matched
// case-insensitively against the commentary text. Word boundaries on either
// side prevent partial matches inside other words.
const RANKING_PATTERNS: RegExp[] = [
  /\bbest\s+(?:trade|performer|pick|mover|position|name|winner)\b/i,
  /\bworst\s+(?:trade|performer|pick|mover|position|name|loser)\b/i,
  /\bbiggest\s+(?:gainer|loser|winner|laggard|move|mover|trade)\b/i,
  /\btop\s+(?:pick|performer|mover|trade|name)\b/i,
  /\bclear\s+(?:winner|loser)\b/i,
  /\bstandout\b/i,
  /\bled\s+the\s+(?:charge|pack|way)\b/i,
  /\bdominated\s+(?:the\s+week|the\s+portfolio|the\s+contest)\b/i,
  /\b(?:crushed|outshone)\s+(?:the\s+others|the\s+rest|everyone|the\s+field)\b/i,
];

export function detectCommentaryViolations(text: string): ViolationReport {
  const numericSnippets = [
    ...(text.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? []),
    ...(text.match(/[-+]?\d+(?:\.\d+)?\s?%/g) ?? []),
  ];
  const rankingSnippets: string[] = [];
  for (const pattern of RANKING_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags + (pattern.flags.includes("g") ? "" : "g")));
    if (matches) rankingSnippets.push(...matches);
  }
  return {
    numericViolations: numericSnippets.length,
    rankingViolations: rankingSnippets.length,
    numericSnippets,
    rankingSnippets,
  };
}

// ---------- Phase 6: Factual validator ----------
//
// `detectCommentaryViolations` (above) catches paraphrase patterns
// ("standout", "$5,000", "+5%"). It does NOT catch factual hallucinations:
// the AI claiming Eli sold INTC when only Yitzi did, the AI making up a
// ticker that nobody trades, or the AI dropping a trade entirely. Those
// are the errors that landed in the user's 2026-05-08 email.
//
// `detectFactualViolations` cross-checks the prose against the actual
// trade log:
//   - coverage:   every (player, ticker) tuple in weeklyTrades must
//                 co-occur in the prose (player name AND ticker within
//                 the same ~250-char window).
//   - unknownTickers: any ALL-CAPS 2-5-letter token that looks like a
//                 ticker but doesn't appear in the contest's known set
//                 (current + historical) is flagged as a hallucination.
//
// Coverage failures retry; unknownTickers always retry.

export interface FactualViolationReport {
  missedTrades: Array<{ player: string; ticker: string }>;
  unknownTickers: Array<{ ticker: string; quote: string }>;
}

// Common false-positive ALL-CAPS tokens that look like tickers but are
// market/finance abbreviations. Add as needed.
const TICKER_FALSE_POSITIVES = new Set([
  "AI", "US", "EU", "ETF", "ET", "AH", "PT", "IPO", "CEO", "CFO", "GDP",
  "PMI", "CPI", "PPI", "EPS", "NYSE", "NASDAQ", "SOX", "SPX", "DJIA", "WTI",
  "AM", "PM", "HQ", "Q1", "Q2", "Q3", "Q4", "YTD", "YOY", "QOQ", "OK",
  "FED", "FOMC", "BLS", "DOJ", "FTC", "SEC", "WSJ", "FT", "NYT", "I",
  "NEW", "THIS", "WEEK", "ALL", "USD", "CAD", "GBP", "EUR", "JPY",
]);

export function detectFactualViolations(
  text: string,
  weeklyTrades: Trade[],
  players: Player[],
  knownTickers: Set<string>
): FactualViolationReport {
  // Coverage: each (player, ticker) tuple in weeklyTrades must appear
  // together in the prose. Paragraph-level co-occurrence is the right
  // granularity — a long paragraph like "Yitzi: trimmed X, bought Y, sold
  // Z, added W on Friday" attributes everything to Yitzi as the established
  // subject, even when individual tokens are 300+ chars apart. We also
  // accept the looser sentence-level co-occurrence (player and ticker in
  // the same sentence) for short prose.
  const playerIdToName = new Map(players.map((p) => [p.id, p.name]));
  const requiredPairs = new Map<string, { player: string; ticker: string }>();
  for (const t of weeklyTrades) {
    const playerName = playerIdToName.get(t.playerId);
    if (!playerName) continue;
    requiredPairs.set(`${playerName}|${t.ticker}`, { player: playerName, ticker: t.ticker });
  }

  // Split into paragraphs (and sentences within) so coverage = "appears in
  // the same paragraph" rather than a fragile char-distance check.
  const paragraphs = text.split(/\n\s*\n/);

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missedTrades: Array<{ player: string; ticker: string }> = [];
  for (const { player, ticker } of requiredPairs.values()) {
    const playerRe = new RegExp(`\\b${escape(player)}\\b`, "i");
    const tickerRe = new RegExp(`\\b${escape(ticker)}\\b`);
    const found = paragraphs.some(
      (para) => playerRe.test(para) && tickerRe.test(para)
    );
    if (!found) missedTrades.push({ player, ticker });
  }

  // Unknown ticker check: any ALL-CAPS 2-5-letter standalone token that's
  // not in knownTickers (and not a finance abbreviation false-positive).
  const unknownTickers: Array<{ ticker: string; quote: string }> = [];
  const seenUnknown = new Set<string>();
  const tokenRe = /\b[A-Z]{2,5}(?:\.[A-Z]{1,3})?\b/g;
  for (const m of text.matchAll(tokenRe)) {
    const tok = m[0];
    if (knownTickers.has(tok)) continue;
    if (TICKER_FALSE_POSITIVES.has(tok)) continue;
    if (seenUnknown.has(tok)) continue;
    seenUnknown.add(tok);
    const start = Math.max(0, m.index! - 30);
    const end = Math.min(text.length, m.index! + tok.length + 30);
    unknownTickers.push({ ticker: tok, quote: text.slice(start, end) });
  }

  return { missedTrades, unknownTickers };
}

export interface CommentaryResult {
  text: string;
  violations: ViolationReport;
  factual: FactualViolationReport;
  /** Phase 6+Y: verifier pass — second Claude call that grades the prose
   *  against the trade log. `errors` is empty when the verifier accepted
   *  the prose; populated with one short reason per error otherwise. */
  verifierErrors: string[];
  attempts: number;
}

const MAX_COMMENTARY_ATTEMPTS = 3; // initial + 2 retries

function knownTickersFromData(data: WeeklyReportData): Set<string> {
  const tickers = new Set<string>();
  for (const t of data.trades) tickers.add(t.ticker);
  for (const p of data.leaderboard) {
    for (const pos of p.positions) tickers.add(pos.ticker);
  }
  for (const t of Object.keys(data.currentPrices)) tickers.add(t);
  return tickers;
}

// Phase 6 / Option Y: verifier pass. The regex validators
// (`detectCommentaryViolations`, `detectFactualViolations`) catch concrete
// patterns: numbers, ranking phrases, ticker hallucinations, missed
// (player, ticker) coverage. They DON'T catch subtler factual errors:
// "three tranches on May 6" when there were two; "APP opened on Friday"
// when it was Thursday; "Eli sold INTC" by inference within otherwise
// well-formed prose. A second Claude call with a tight fact-checker prompt
// catches what the regexes miss.
//
// Cost ~$0.005-$0.01 per call. Budget approved by user (2026-05-08).

const VERIFIER_PROMPT = (tradeTable: string, prose: string) => `You are an
exacting fact-checker for a stock-picking-contest weekly email. You will see
the canonical TRADE LOG (ground truth) and a CANDIDATE PROSE paragraph.

Identify FACTUAL ERRORS in the prose. Be strict and literal.

ERROR TYPES (use these exact labels):
- WRONG_DAY      — prose names a day-of-week or date that disagrees with the log (e.g. prose says "Friday" but log shows Thursday)
- WRONG_COUNT    — prose claims a count that disagrees with the log (e.g. "three tranches" when there were two)
- WRONG_PLAYER   — prose attributes a trade to a player who didn't make it
- WRONG_DIRECTION — prose says buy when log shows sell (or vice versa)
- WRONG_CLOSE    — prose says "closed entirely" / "fully exited" but log shows partial trim (or vice versa)
- MADE_UP_TICKER — prose names a ticker not in the log
- MISSED_TRADE   — prose drops a trade entirely (every (player, ticker) pair in the log must appear in the prose)
- WRONG_RATIONALE — prose claims a fact about market context or rationale that isn't supported by either the log or the broader market reality (be conservative; only flag clear factual claims)

OUTPUT FORMAT — one error per line:
ERROR: <TYPE> | <quote 6-12 word snippet from prose> | <what is actually true per the log>

If there are zero errors, output the literal string:
NO_ERRORS_FOUND

Do not write anything else. Do not add commentary. Do not flag stylistic
issues, banned words, or numeric quotes — those are checked elsewhere. Be
strict on factual claims; lenient on tone.

TRADE LOG (ground truth):
${tradeTable}

CANDIDATE PROSE:
${prose}`.trim();

function buildVerifierTradeTable(data: WeeklyReportData): string {
  if (data.weeklyTrades.length === 0) return "(no trades this week)";
  const lines: string[] = [];
  for (const player of data.players) {
    const playerTrades = data.weeklyTrades.filter((t) => t.playerId === player.id);
    if (playerTrades.length === 0) {
      lines.push(`${player.name}: 0 trades`);
      continue;
    }
    lines.push(`${player.name}:`);
    const sorted = [...playerTrades].sort((a, b) => a.timestamp - b.timestamp);
    for (const t of sorted) {
      const [y, m, d] = t.date.split("-").map(Number);
      const dow = new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-US", {
        weekday: "short",
        timeZone: "UTC",
      });
      lines.push(`  ${t.date} (${dow}): ${t.type.toUpperCase()} ${t.shares} ${t.ticker} @ $${t.price.toFixed(2)}`);
    }
  }
  return lines.join("\n");
}

async function runVerifierPass(
  prose: string,
  data: WeeklyReportData,
  anthropicApiKey: string,
  model: string
): Promise<{ ok: boolean; errors: string[] }> {
  const client = new Anthropic({ apiKey: anthropicApiKey });
  const tradeTable = buildVerifierTradeTable(data);
  const prompt = VERIFIER_PROMPT(tradeTable, prose);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    const text = block.type === "text" ? block.text.trim() : "";

    if (text === "NO_ERRORS_FOUND" || /^NO_ERRORS_FOUND/m.test(text)) {
      return { ok: true, errors: [] };
    }

    const errors = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("ERROR:"))
      .map((l) => l.slice("ERROR:".length).trim());

    if (errors.length === 0) {
      // Verifier returned something but no parseable ERROR lines — treat as
      // ambiguous-pass to avoid endless retry on a flaky verifier.
      console.warn(`[Verifier] Unparseable response, accepting prose. Response: ${text.slice(0, 200)}`);
      return { ok: true, errors: [] };
    }

    return { ok: false, errors };
  } catch (err) {
    // Verifier hard-failure (network, API quota, etc.) — fall through and
    // accept the prose. The regex validators already passed; we don't want
    // a flaky verifier to block sending entirely.
    console.warn(
      `[Verifier] Pass failed (${err instanceof Error ? err.message : err}); accepting prose without verification.`
    );
    return { ok: true, errors: [] };
  }
}

// Generates AI commentary with three-layered post-hoc validation:
//   1. Style violations (numbers, ranking-paraphrase) — Phase 4c regex
//   2. Factual violations (missed trades, unknown tickers) — Phase 6 regex
//   3. Verifier pass (subtle factual errors: counts, days, attribution by
//      inference) — Phase 6/Y, second Claude call
//
// If any layer trips, regenerates up to MAX_COMMENTARY_ATTEMPTS times.
// Returns the lowest-total-violation pass. Empty/imperfect commentary beats
// silent retries that hide the model is drifting, so residual violation
// counts return to the caller (and land in the email_sends audit row).
export async function generateCommentary(
  data: WeeklyReportData,
  anthropicApiKey: string,
  model: string = "claude-sonnet-4-5-20250929",
  marketContext?: string
): Promise<CommentaryResult> {
  const client = new Anthropic({ apiKey: anthropicApiKey });
  const prompt = buildCommentaryPrompt(data, marketContext);
  const knownTickers = knownTickersFromData(data);
  let best: CommentaryResult | null = null;

  const score = (r: CommentaryResult) =>
    r.violations.numericViolations +
    r.violations.rankingViolations +
    r.factual.missedTrades.length +
    r.factual.unknownTickers.length +
    r.verifierErrors.length;

  for (let attempt = 1; attempt <= MAX_COMMENTARY_ATTEMPTS; attempt++) {
    const message = await client.messages.create({
      model,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content[0];
    const text = block.type === "text" ? block.text : "";
    const violations = detectCommentaryViolations(text);
    const factual = detectFactualViolations(text, data.weeklyTrades, data.players, knownTickers);

    // Only run the (more expensive) verifier pass when the regex layers
    // pass — no point fact-checking prose that already has style/coverage
    // violations and will retry anyway.
    const regexClean =
      violations.numericViolations === 0 &&
      violations.rankingViolations === 0 &&
      factual.missedTrades.length === 0 &&
      factual.unknownTickers.length === 0;

    let verifierErrors: string[] = [];
    if (regexClean) {
      const verifyResult = await runVerifierPass(text, data, anthropicApiKey, model);
      verifierErrors = verifyResult.errors;
    }

    const result: CommentaryResult = { text, violations, factual, verifierErrors, attempts: attempt };
    if (score(result) === 0) return result;
    if (!best || score(result) < score(best)) best = result;
    console.warn(
      `[Commentary] Attempt ${attempt} — style: num=${violations.numericViolations} rank=${violations.rankingViolations}; ` +
        `facts: missed=${factual.missedTrades.length} (${factual.missedTrades.slice(0, 3).map((m) => `${m.player}/${m.ticker}`).join(",")}) ` +
        `unknownTickers=${factual.unknownTickers.length} (${factual.unknownTickers.slice(0, 3).map((u) => u.ticker).join(",")}); ` +
        `verifier: errors=${verifierErrors.length}${verifierErrors.length > 0 ? " — " + verifierErrors.slice(0, 3).map((e) => e.slice(0, 100)).join(" / ") : ""}`
    );
  }
  return best!;
}

// ---------- HTML Email Template ----------

export function formatCommentary(text: string): string {
  return text
    .split("\n\n")
    .map((p) => {
      const html = p
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>");
      return `<p style="margin: 0 0 12px 0; color: #1f2937; font-size: 15px; line-height: 1.6;">${html}</p>`;
    })
    .join("");
}

export function buildEmailHtml(
  data: WeeklyReportData,
  commentary: string
): string {
  const { leaderboard, weeklyTrades, weekDeltas, players, trades, currentPrices, reportDate } = data;

  const commentaryHtml = formatCommentary(commentary);
  const highlightsHtml = renderHighlightsHtml(buildWeeklyHighlights(data));

  const rankColors = ["#EAB308", "#9CA3AF", "#D97706", "#D1D5DB"];

  const leaderboardRows = leaderboard
    .map((p, i) => {
      const bg = i % 2 === 0 ? "#F9FAFB" : "#FFFFFF";
      const rankBg = rankColors[i] || rankColors[3];
      const returnColor = p.returnPct >= 0 ? "#059669" : "#DC2626";
      const delta = weekDeltas.find((d) => d.playerId === p.id);
      const weekChangeColor = delta && delta.weekChange >= 0 ? "#059669" : "#DC2626";
      const weekArrow = delta && delta.weekChange >= 0 ? "&#9650;" : "&#9660;";
      const weekChangeStr = delta
        ? `<span style="color: ${weekChangeColor}; font-size: 12px;">${weekArrow} ${delta.weekChange >= 0 ? "+" : ""}${formatCurrency(delta.weekChange)}</span>`
        : "";
      const rankChangeHtml = delta && delta.rankChange !== 0
        ? `<span style="display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 9999px; font-size: 10px; font-weight: 600; background: ${delta.rankChange > 0 ? "#DCFCE7" : "#FEE2E2"}; color: ${delta.rankChange > 0 ? "#15803D" : "#DC2626"};">${delta.rankChange > 0 ? `&#9650;${delta.rankChange}` : `&#9660;${Math.abs(delta.rankChange)}`}</span>`
        : "";
      return `<tr style="background: ${bg};">
        <td style="padding: 12px 16px; text-align: center;">
          <span style="display: inline-block; width: 28px; height: 28px; border-radius: 50%; background: ${rankBg}; color: white; font-weight: bold; line-height: 28px; text-align: center; font-size: 14px;">${i + 1}</span>${rankChangeHtml}
        </td>
        <td style="padding: 12px 16px;">
          <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${p.color}; margin-right: 8px; vertical-align: middle;"></span>
          <span style="font-weight: 600; color: #111827;">${p.name}</span>
        </td>
        <td style="padding: 12px 16px; text-align: right; font-weight: 600; color: #111827;">${formatCurrency(p.totalValue)}</td>
        <td style="padding: 12px 16px; text-align: right; font-weight: 600; color: ${returnColor};">${formatPercent(p.returnPct)}</td>
        <td style="padding: 12px 16px; text-align: right;">${weekChangeStr}</td>
      </tr>`;
    })
    .join("");

  let tradesHtml: string;
  if (weeklyTrades.length === 0) {
    tradesHtml = `<tr><td colspan="7" style="padding: 24px; text-align: center; color: #6B7280;">No trades this week.</td></tr>`;
  } else {
    tradesHtml = weeklyTrades
      .map((t) => {
        const player = players.find((p) => p.id === t.playerId);
        const typeBg = t.type === "buy" ? "#DCFCE7" : "#FEE2E2";
        const typeColor = t.type === "buy" ? "#15803D" : "#DC2626";
        return `<tr style="border-bottom: 1px solid #F3F4F6;">
          <td style="padding: 10px 12px; font-size: 13px; color: #4B5563;">${formatDateDisplay(t.date)}</td>
          <td style="padding: 10px 12px; font-size: 13px; font-weight: 500; color: #111827;">${player?.name}</td>
          <td style="padding: 10px 12px;">
            <span style="display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; background: ${typeBg}; color: ${typeColor};">${t.type.toUpperCase()}</span>
          </td>
          <td style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #111827;">${t.ticker}</td>
          <td style="padding: 10px 12px; font-size: 13px; color: #4B5563; text-align: right;">${t.shares}</td>
          <td style="padding: 10px 12px; font-size: 13px; color: #4B5563; text-align: right;">${formatCurrency(t.price)}</td>
          <td style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #111827; text-align: right;">${formatCurrency(t.shares * t.price)}</td>
        </tr>`;
      })
      .join("");
  }

  const playerDetailsHtml = leaderboard
    .map((p) => {
      const stats = getPlayerStats(p.id, trades, currentPrices);
      const positionsHtml =
        stats.positions.length > 0
          ? stats.positions
              .map((pos) => {
                const price = getCurrentPrice(pos.ticker, currentPrices, trades);
                const currentValue = pos.shares * price;
                const gain = currentValue - pos.totalCost;
                const gainPct = pos.totalCost !== 0 ? (gain / pos.totalCost) * 100 : 0;
                const gainColor = gain >= 0 ? "#059669" : "#DC2626";
                const barWidth = Math.min(Math.abs(gainPct), 100);
                return `<tr style="border-bottom: 1px solid #F3F4F6;">
                  <td style="padding: 6px 10px; font-size: 13px; font-weight: 600; color: #111827;">${pos.ticker}</td>
                  <td style="padding: 6px 10px; font-size: 13px; color: #4B5563;">${pos.shares}</td>
                  <td style="padding: 6px 10px; font-size: 13px; color: #4B5563;">${formatCurrency(pos.avgCost)}</td>
                  <td style="padding: 6px 10px; font-size: 13px; color: #4B5563;">${formatCurrency(price)}</td>
                  <td style="padding: 6px 10px; font-size: 13px; font-weight: 600; color: ${gainColor}; text-align: right;">${formatCurrency(gain)}</td>
                  <td style="padding: 6px 10px; text-align: right;">
                    <span style="font-size: 13px; font-weight: 600; color: ${gainColor};">${formatPercent(gainPct)}</span>
                    <div style="width: 60px; height: 4px; background: #E5E7EB; border-radius: 2px; overflow: hidden; margin-top: 2px; margin-left: auto;">
                      <div style="width: ${barWidth}%; height: 100%; background: ${gainColor}; border-radius: 2px;"></div>
                    </div>
                  </td>
                </tr>`;
              })
              .join("")
          : `<tr><td colspan="6" style="padding: 12px; text-align: center; color: #9CA3AF; font-size: 13px;">No open positions</td></tr>`;

      const closedTradesHtml = stats.closedTrades.length > 0
        ? `
        <h3 style="margin: 20px 0 8px 0; font-size: 13px; font-weight: 600; color: #374151; text-transform: uppercase; letter-spacing: 0.04em;">Closed Trades to Date</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #F9FAFB;">
              <th style="padding: 6px 10px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Ticker</th>
              <th style="padding: 6px 10px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Shares</th>
              <th style="padding: 6px 10px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Avg Buy</th>
              <th style="padding: 6px 10px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Avg Sell</th>
              <th style="padding: 6px 10px; text-align: right; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Gain/Loss</th>
              <th style="padding: 6px 10px; text-align: right; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">%</th>
            </tr>
          </thead>
          <tbody>${stats.closedTrades
            .map((ct) => {
              const avgBuy = ct.shares !== 0 ? ct.costBasis / ct.shares : 0;
              const avgSell = ct.shares !== 0 ? ct.proceeds / ct.shares : 0;
              const color = ct.gain >= 0 ? "#059669" : "#DC2626";
              return `<tr style="border-bottom: 1px solid #F3F4F6;">
                  <td style="padding: 6px 10px; font-size: 13px; font-weight: 600; color: #111827;">${ct.ticker}</td>
                  <td style="padding: 6px 10px; font-size: 13px; color: #4B5563;">${ct.shares}</td>
                  <td style="padding: 6px 10px; font-size: 13px; color: #4B5563;">${formatCurrency(avgBuy)}</td>
                  <td style="padding: 6px 10px; font-size: 13px; color: #4B5563;">${formatCurrency(avgSell)}</td>
                  <td style="padding: 6px 10px; font-size: 13px; font-weight: 600; color: ${color}; text-align: right;">${ct.gain >= 0 ? "+" : ""}${formatCurrency(ct.gain)}</td>
                  <td style="padding: 6px 10px; font-size: 13px; font-weight: 600; color: ${color}; text-align: right;">${formatPercent(ct.gainPct)}</td>
                </tr>`;
            })
            .join("")}</tbody>
        </table>`
        : "";

      const returnColor = stats.returnPct >= 0 ? "#059669" : "#DC2626";
      const realizedLabel = stats.closedTrades.length > 0
        ? `Net Realized P&amp;L (${stats.winningTrades} win${stats.winningTrades === 1 ? "" : "s"} / ${stats.losingTrades} loss${stats.losingTrades === 1 ? "" : "es"})`
        : "Realized P&amp;L";

      return `<div style="background: white; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
          <span style="display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: ${p.color}; margin-right: 8px;"></span>
          <span style="font-weight: 700; font-size: 16px; color: #111827;">${p.name}</span>
          <span style="margin-left: 12px; font-weight: 600; color: ${returnColor}; font-size: 14px;">${formatPercent(stats.returnPct)}</span>
        </div>
        <div style="display: flex; gap: 24px; margin-bottom: 12px; font-size: 13px; color: #4B5563; flex-wrap: wrap;">
          <span>Cash: <strong>${formatCurrency(stats.cashRemaining)}</strong></span>
          <span>Portfolio: <strong>${formatCurrency(stats.portfolioValue)}</strong></span>
          <span>${realizedLabel}: <strong style="color: ${stats.realizedGains >= 0 ? "#059669" : "#DC2626"};">${formatCurrency(stats.realizedGains)}</strong></span>
        </div>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #F9FAFB;">
              <th style="padding: 6px 10px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Ticker</th>
              <th style="padding: 6px 10px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Shares</th>
              <th style="padding: 6px 10px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Avg Cost</th>
              <th style="padding: 6px 10px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Current</th>
              <th style="padding: 6px 10px; text-align: right; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Gain/Loss</th>
              <th style="padding: 6px 10px; text-align: right; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">%</th>
            </tr>
          </thead>
          <tbody>${positionsHtml}</tbody>
        </table>${closedTradesHtml}
      </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background: #F3F4F6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 640px; margin: 0 auto; padding: 24px;">

    <!-- Header -->
    <div style="background: #2563EB; background: linear-gradient(135deg, #2563EB, #1D4ED8); border-radius: 12px 12px 0 0; padding: 24px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 22px; font-weight: 700;">&#x1F4C8; Stock Picking Contest</h1>
      <p style="margin: 6px 0 0 0; color: #BFDBFE; font-size: 14px;">Weekly Report &mdash; ${reportDate}</p>
    </div>

    <div style="background: white; border-radius: 0 0 12px 12px; border: 1px solid #E5E7EB; border-top: none;">

      <!-- 7-Day Price Moves (deterministic) -->
      ${highlightsHtml}

      <!-- Commentary (AI narrative) -->
      <div id="commentary" style="padding: 24px; border-bottom: 1px solid #E5E7EB; border-left: 4px solid #2563EB;">
        ${commentaryHtml}
      </div>

      <!-- Leaderboard -->
      <div style="padding: 24px; border-bottom: 1px solid #E5E7EB;">
        <h2 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #111827;">&#x1F3C6; Leaderboard</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #F9FAFB;">
              <th style="padding: 10px 16px; text-align: center; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Rank</th>
              <th style="padding: 10px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Player</th>
              <th style="padding: 10px 16px; text-align: right; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Total Value</th>
              <th style="padding: 10px 16px; text-align: right; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Return</th>
              <th style="padding: 10px 16px; text-align: right; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase;">This Week</th>
            </tr>
          </thead>
          <tbody>${leaderboardRows}</tbody>
        </table>
      </div>

      <!-- Weekly Trades -->
      <div style="padding: 24px; border-bottom: 1px solid #E5E7EB;">
        <h2 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #111827;">&#x1F4CA; This Week's Trades</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #F9FAFB;">
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Date</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Player</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Type</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Ticker</th>
              <th style="padding: 8px 12px; text-align: right; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Shares</th>
              <th style="padding: 8px 12px; text-align: right; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Price</th>
              <th style="padding: 8px 12px; text-align: right; font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Total</th>
            </tr>
          </thead>
          <tbody>${tradesHtml}</tbody>
        </table>
      </div>

      <!-- Portfolio Details -->
      <div style="padding: 24px;">
        <h2 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #111827;">&#x1F4BC; Portfolio Details</h2>
        ${playerDetailsHtml}
      </div>

    </div>

    <!-- Footer -->
    <div style="text-align: center; margin-top: 16px;">
      <p style="color: #9CA3AF; font-size: 12px; margin: 0;">
        Report for ${reportDate} &middot; Powered by Stock Contest Tracker
      </p>
    </div>

  </div>
</body>
</html>`;
}

// ---------- Plain Text Fallback ----------

export function buildPlainText(
  data: WeeklyReportData,
  commentary: string
): string {
  const { leaderboard, weeklyTrades, weekDeltas, players, trades, currentPrices, reportDate } = data;

  // Strip markdown formatting
  const cleanCommentary = commentary
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1");

  const lines: string[] = [
    "STOCK PICKING CONTEST",
    `Weekly Report - ${reportDate}`,
    "",
    cleanCommentary,
    "",
    "LEADERBOARD",
    "-".repeat(60),
  ];

  leaderboard.forEach((p, i) => {
    const delta = weekDeltas.find((d) => d.playerId === p.id);
    const weekStr = delta
      ? ` (${delta.weekChange >= 0 ? "+" : ""}${formatCurrency(delta.weekChange)} this week)`
      : "";
    lines.push(
      `${i + 1}. ${p.name}: ${formatCurrency(p.totalValue)} ${formatPercent(p.returnPct)}${weekStr}`
    );
  });

  lines.push("", "THIS WEEK'S TRADES", "-".repeat(60));

  if (weeklyTrades.length === 0) {
    lines.push("No trades this week.");
  } else {
    weeklyTrades.forEach((t) => {
      const player = players.find((p) => p.id === t.playerId);
      lines.push(
        `${t.date}: ${player?.name} ${t.type.toUpperCase()} ${t.shares} ${t.ticker} @ ${formatCurrency(t.price)} (${formatCurrency(t.shares * t.price)})`
      );
    });
  }

  lines.push("", "PORTFOLIO DETAILS", "-".repeat(60));

  leaderboard.forEach((p) => {
    const stats = getPlayerStats(p.id, trades, currentPrices);
    const realizedLabel = stats.closedTrades.length > 0
      ? `Net Realized P&L (${stats.winningTrades} win${stats.winningTrades === 1 ? "" : "s"} / ${stats.losingTrades} loss${stats.losingTrades === 1 ? "" : "es"})`
      : "Realized P&L";
    lines.push(`\n${p.name} (${formatPercent(stats.returnPct)})`);
    lines.push(`  Cash: ${formatCurrency(stats.cashRemaining)} | Portfolio: ${formatCurrency(stats.portfolioValue)} | ${realizedLabel}: ${formatCurrency(stats.realizedGains)}`);
    if (stats.positions.length > 0) {
      stats.positions.forEach((pos) => {
        const price = getCurrentPrice(pos.ticker, currentPrices, trades);
        const gain = pos.shares * price - pos.totalCost;
        const gainPct = pos.totalCost !== 0 ? (gain / pos.totalCost) * 100 : 0;
        lines.push(
          `  ${pos.ticker}: ${pos.shares} shares @ ${formatCurrency(pos.avgCost)} now ${formatCurrency(price)} (${gain >= 0 ? "+" : ""}${formatCurrency(gain)}, ${formatPercent(gainPct)})`
        );
      });
    } else {
      lines.push("  No open positions");
    }
    if (stats.closedTrades.length > 0) {
      lines.push("  Closed trades to date:");
      stats.closedTrades.forEach((ct) => {
        const avgBuy = ct.shares !== 0 ? ct.costBasis / ct.shares : 0;
        const avgSell = ct.shares !== 0 ? ct.proceeds / ct.shares : 0;
        lines.push(
          `    ${ct.ticker}: ${ct.shares} shares, ${formatCurrency(avgBuy)} buy -> ${formatCurrency(avgSell)} sell (${ct.gain >= 0 ? "+" : ""}${formatCurrency(ct.gain)}, ${formatPercent(ct.gainPct)})`
        );
      });
    }
  });

  lines.push("", "---", "Powered by Stock Contest Tracker");

  return lines.join("\n");
}

// ---------- Email Sending ----------

export async function sendWeeklyEmail(
  config: EmailConfig,
  data: WeeklyReportData,
  commentary: string
): Promise<void> {
  const html = buildEmailHtml(data, commentary);
  const text = buildPlainText(data, commentary);
  const recipients = Object.values(config.playerEmails).filter(Boolean);

  if (recipients.length === 0) {
    throw new Error("No recipient email addresses configured");
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: config.gmailAddress,
      pass: config.gmailAppPassword,
    },
  });

  await transporter.sendMail({
    from: `"Stock Contest" <${config.gmailAddress}>`,
    to: recipients.join(", "),
    subject: `Stock Contest Weekly Report - ${data.reportDate}`,
    html,
    text,
  });
}
