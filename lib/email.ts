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

export function getWeeklyTrades(trades: Trade[], asOfDate?: string): Trade[] {
  const now = asOfDate ? new Date(asOfDate) : new Date();
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const cutoff = oneWeekAgo.toISOString().split("T")[0];
  const end = now.toISOString().split("T")[0];
  return trades
    .filter((t) => t.date >= cutoff && t.date <= end)
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
  const now = new Date(reportDate);
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const cutoff = oneWeekAgo.toISOString().split("T")[0];

  const currentLeaderboard = getLeaderboard(players, trades, currentPrices);

  // Compute previous week's rankings using trades before cutoff, valued at current prices
  // (used only for rank change detection — rank is relative ordering, not dollar values)
  const previousTrades = trades.filter((t) => t.date < cutoff);
  const previousLeaderboard = getLeaderboard(players, previousTrades, currentPrices);

  const weekDeltas: PlayerWeekDelta[] = currentLeaderboard.map((current, currentRank) => {
    const previous = previousLeaderboard.find((p) => p.id === current.id);
    const previousRank = previous
      ? previousLeaderboard.indexOf(previous)
      : currentRank;
    // Use getPlayerValueAtDate for true historical portfolio value
    const prevValue = getPlayerValueAtDate(current.id, cutoff, trades, priceHistory);
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

export function buildCommentaryPrompt(data: WeeklyReportData): string {
  const { leaderboard, weeklyTrades, weekDeltas, players, currentPrices, priceHistory, trades, reportDate } = data;

  const now = new Date(reportDate);
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const cutoffDate = oneWeekAgo.toISOString().split("T")[0];

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

  const recentTradesSummary =
    weeklyTrades.length > 0
      ? weeklyTrades
          .map((t) => {
            const player = players.find((p) => p.id === t.playerId);
            const total = t.shares * t.price;
            return `${t.date}: ${player?.name} ${t.type.toUpperCase()} ${t.shares} ${t.ticker} @ ${formatCurrency(t.price)} (${formatCurrency(total)} total)`;
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
- Do NOT use any of these words/phrases: ${BANNED_WORDS.map((w) => `"${w}"`).join(", ")}
- Never use the "it's not X, it's Y" rhetorical construction
- No flattery, no superlatives, no glazing -- just state what happened
- Keep it under 200 words

Current standings as of ${reportDate}:
${standingsSummary}

Trades this week:
${recentTradesSummary}`;
}

export async function generateCommentary(
  data: WeeklyReportData,
  anthropicApiKey: string
): Promise<string> {
  const client = new Anthropic({ apiKey: anthropicApiKey });
  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [{ role: "user", content: buildCommentaryPrompt(data) }],
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
                const gainPct = (gain / pos.totalCost) * 100;
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

      const returnColor = stats.returnPct >= 0 ? "#059669" : "#DC2626";

      return `<div style="background: white; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
          <span style="display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: ${p.color}; margin-right: 8px;"></span>
          <span style="font-weight: 700; font-size: 16px; color: #111827;">${p.name}</span>
          <span style="margin-left: 12px; font-weight: 600; color: ${returnColor}; font-size: 14px;">${formatPercent(stats.returnPct)}</span>
        </div>
        <div style="display: flex; gap: 24px; margin-bottom: 12px; font-size: 13px; color: #4B5563;">
          <span>Cash: <strong>${formatCurrency(stats.cashRemaining)}</strong></span>
          <span>Portfolio: <strong>${formatCurrency(stats.portfolioValue)}</strong></span>
          <span>Realized P&L: <strong style="color: ${stats.realizedGains >= 0 ? "#059669" : "#DC2626"};">${formatCurrency(stats.realizedGains)}</strong></span>
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
        </table>
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
      <div style="padding: 24px; border-bottom: 1px solid #E5E7EB; border-left: 4px solid #2563EB;">
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
    lines.push(`\n${p.name} (${formatPercent(stats.returnPct)})`);
    lines.push(`  Cash: ${formatCurrency(stats.cashRemaining)} | Portfolio: ${formatCurrency(stats.portfolioValue)} | Realized P&L: ${formatCurrency(stats.realizedGains)}`);
    if (stats.positions.length > 0) {
      stats.positions.forEach((pos) => {
        const price = getCurrentPrice(pos.ticker, currentPrices, trades);
        const gain = pos.shares * price - pos.totalCost;
        const gainPct = (gain / pos.totalCost) * 100;
        lines.push(
          `  ${pos.ticker}: ${pos.shares} shares @ ${formatCurrency(pos.avgCost)} now ${formatCurrency(price)} (${gain >= 0 ? "+" : ""}${formatCurrency(gain)}, ${formatPercent(gainPct)})`
        );
      });
    } else {
      lines.push("  No open positions");
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
