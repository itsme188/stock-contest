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
  const reportDate = asOfDate || new Date().toISOString().split("T")[0];
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
  const reportDate = asOfDate || new Date().toISOString().split("T")[0];
  const endTs = getMarketCloseTimestamp(reportDate);
  const startTs = endTs - 7 * 24 * 60 * 60 * 1000;
  const oneWeekAgo = new Date(reportDate);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const cutoffDate = oneWeekAgo.toISOString().split("T")[0];

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

export function buildCommentaryPrompt(data: WeeklyReportData, marketContext?: string): string {
  const { leaderboard, weeklyTrades, weekDeltas, players, currentPrices, priceHistory, trades, reportDate } = data;

  const now = new Date(reportDate);
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const cutoffDate = oneWeekAgo.toISOString().split("T")[0];

  // Per-player, per-position weekly % price change (used twice below).
  const weeklyMovesByPlayer = leaderboard.map((p) => {
    const moves = p.positions
      .map((pos) => {
        const curPrice = getCurrentPrice(pos.ticker, currentPrices, trades);
        const weekAgoPrice = getPriceAtDate(pos.ticker, cutoffDate, priceHistory);
        const pct =
          weekAgoPrice && weekAgoPrice > 0
            ? ((curPrice - weekAgoPrice) / weekAgoPrice) * 100
            : null;
        return pct !== null ? { ticker: pos.ticker, pct } : null;
      })
      .filter((x): x is { ticker: string; pct: number } => x !== null);
    return { player: p, moves };
  });

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
          // Weekly price change from historical prices
          const weekAgoPrice = getPriceAtDate(pos.ticker, cutoffDate, priceHistory);
          const weekPriceChange = weekAgoPrice && weekAgoPrice > 0
            ? ((curPrice - weekAgoPrice) / weekAgoPrice) * 100
            : null;
          const weekStr = weekPriceChange !== null
            ? `, ${weekPriceChange >= 0 ? "+" : ""}${formatPercent(weekPriceChange)} this week`
            : "";
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

  // Pre-ranked biggest weekly movers per player so the AI doesn't have to
  // sort the position list itself (it was getting this wrong).
  const fmtMove = (m: { ticker: string; pct: number }) =>
    `${m.ticker} ${m.pct >= 0 ? "+" : ""}${formatPercent(m.pct)}`;
  const weeklyMoversSummary = weeklyMovesByPlayer
    .map(({ player, moves }) => {
      if (moves.length === 0) return `${player.name}: no weekly price data available`;
      const sorted = [...moves].sort((a, b) => b.pct - a.pct);
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      const parts = [`biggest gainer ${fmtMove(best)}`];
      if (sorted.length > 1 && worst.ticker !== best.ticker) {
        parts.push(`biggest laggard ${fmtMove(worst)}`);
      }
      return `${player.name}: ${parts.join(", ")}`;
    })
    .join("\n");

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

  const recentTradesSummary =
    weeklyTrades.length > 0
      ? weeklyTrades
          .map((t) => {
            const player = players.find((p) => p.id === t.playerId);
            const total = t.shares * t.price;
            const annotation = tradeAnnotations.get(t.id);
            const annStr = annotation ? ` — ${annotation}` : "";
            return `${t.date}: ${player?.name} ${t.type.toUpperCase()} ${t.shares} ${t.ticker} @ ${formatCurrency(t.price)} (${formatCurrency(total)} total)${annStr}`;
          })
          .join("\n")
      : "No trades this week.";

  const allTickers = [
    ...new Set(
      leaderboard.flatMap((p) => p.positions.map((pos) => pos.ticker))
    ),
  ];

  return `You are a portfolio analyst writing a weekly investor letter for a family stock picking contest between three participants: Daddy, Eli, and Yitzi. Each started with $100,000 in virtual capital.

Write 2-3 short paragraphs (150-200 words) covering:
1. Performance summary: who leads, by how much, and week-over-week changes. State the numbers plainly.
2. Activity: what was bought or sold this week and the rationale behind each move, if apparent.
3. Holdings review: how the current positions (${allTickers.join(", ") || "none yet"}) performed. Flag anything that moved more than a few percent.

TONE: Dry, confident, matter-of-fact. Think Buffett's shareholder letters -- plain English, short sentences, no jargon. Occasional dry wit is fine. You can be wry about poor decisions or large cash positions, but don't editorialize excessively. Let the numbers speak. Never flatter anyone.

EXAMPLE:
"The portfolio returned +2.3% this week, bringing Daddy's total to $102,300. The gain came from his AAPL position, which added $1,800 after a strong earnings print. He remains fully allocated across five names.

Eli opened a GOOG position at $180, putting $18,000 to work from his $82,000 cash reserve. Time will tell. Yitzi sits at $100,000 in cash, having made no trades since the contest began. We note this without further comment."

STRICT RULES:
- Use specific numbers from the data (dollar amounts, percentages, share counts)
- Position size = total dollars deployed, NOT per-share price. A 100-share position at $50/share ($5,000 deployed) is smaller than a 10-share position at $1,000/share ($10,000 deployed). The "deployed" amounts in the data are authoritative.
- CRITICAL: "% total" is the gain since purchase. "% this week" is the actual price movement over the past 7 days. When discussing weekly performance, ONLY use the "this week" numbers. Never present total return as a weekly move.
- SCOPE: "This week" is the window from last Friday's market close (4:00 PM ET) through this Friday's market close. Only reference trades in the "Trades this week" list below. Do NOT invent or recall trades from prior weeks — any ticker that appears only in a Positions line (not in the Trades list) is a pre-existing holding, not a recent trade.
- BIGGEST WEEKLY MOVER: when naming a player's best- or worst-performing position of the week, use the pre-ranked values in the "Biggest weekly moves" section. Do not eyeball the standings list.
- PARTIAL vs FULL CLOSE: respect the annotation on each sell. "partial trim, N shares still held" means the position is NOT closed. "full close" means exited. Never describe a partial as a full exit.
- ACTIVITY COVERAGE: every trade in "Trades this week" must be addressed — either by name or via a deliberate grouping (e.g., "Yitzi made two trims and two adds on the 10th"). Do not silently skip any.
- Do NOT use any of these words/phrases: ${BANNED_WORDS.map((w) => `"${w}"`).join(", ")}
- Never use the "it's not X, it's Y" rhetorical construction
- No flattery, no superlatives, no glazing -- just state what happened
- NEVER claim a ticker is held by all players or use phrases like "across all portfolios" / "across all three" / "every player" unless the ticker literally appears in all three players' Positions lists above. If only two players hold it, name them explicitly ("both Daddy and Eli hold HYDTF"). If only one holds it, attribute to that player only.
- POSITION COUNTS: the standings list shows holdings as of the report date (AFTER all trades this week). When describing a trim, take the "remaining" count from the trade annotation (which shows "position: N shares -> M remaining"). Do NOT subtract sold shares from the standings number — the standings already reflect the post-trade total.
- Keep it under 200 words

Current standings as of ${reportDate}:
${standingsSummary}

Biggest weekly moves per player (pre-ranked — use these verbatim):
${weeklyMoversSummary}

Trades this week:
${recentTradesSummary}${marketContext ? `

MARKET CONTEXT (from Vital Knowledge newsletter digests this week):
${marketContext}

Use the market context to add color when relevant (e.g., "AAPL's +2% outpaced a rough week for tech"). Weave it in naturally — 1-2 sentences max. Do NOT summarize the newsletter or quote it directly. Contest data is still the primary focus.` : ""}`;
}

export async function generateCommentary(
  data: WeeklyReportData,
  anthropicApiKey: string,
  model: string = "claude-sonnet-4-5-20250929",
  marketContext?: string
): Promise<string> {
  const client = new Anthropic({ apiKey: anthropicApiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 500,
    messages: [{ role: "user", content: buildCommentaryPrompt(data, marketContext) }],
  });
  const block = message.content[0];
  return block.type === "text" ? block.text : "";
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
          <td style="padding: 10px 12px; font-size: 13px; color: #4B5563;">${new Date(t.date).toLocaleDateString()}</td>
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

      <!-- Commentary -->
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
