import nodemailer from "nodemailer";
import Anthropic from "@anthropic-ai/sdk";
import {
  type Player,
  type Trade,
  type LeaderboardEntry,
  getLeaderboard,
  getPlayerStats,
  getCurrentPrice,
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

export interface WeeklyReportData {
  leaderboard: LeaderboardEntry[];
  weeklyTrades: Trade[];
  players: Player[];
  trades: Trade[];
  currentPrices: Record<string, number>;
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
  asOfDate?: string
): WeeklyReportData {
  return {
    leaderboard: getLeaderboard(players, trades, currentPrices),
    weeklyTrades: getWeeklyTrades(trades, asOfDate),
    players,
    trades,
    currentPrices,
    reportDate: asOfDate || new Date().toISOString().split("T")[0],
  };
}

// ---------- AI Commentary ----------

const BANNED_WORDS = [
  "delve", "landscape", "paradigm", "tapestry", "multifaceted",
  "in terms of", "it's important to note", "it's worth noting",
  "notably", "noteworthy", "navigate", "leverage", "robust",
  "comprehensive", "cutting-edge", "synergy", "game-changer",
  "deep dive", "at the end of the day", "moving forward",
  "circle back", "touch base", "low-hanging fruit", "underscore",
  "underscores", "realm", "foster", "pivotal", "crucial",
  "arguably", "essentially", "fundamentally",
];

export function buildCommentaryPrompt(data: WeeklyReportData): string {
  const { leaderboard, weeklyTrades, players, reportDate } = data;

  const standingsSummary = leaderboard
    .map((p, i) => {
      const positionList = p.positions
        .map(
          (pos) =>
            `${pos.ticker} (${pos.shares} shares, avg cost ${formatCurrency(pos.avgCost)})`
        )
        .join(", ");
      return `${i + 1}. ${p.name}: ${formatCurrency(p.totalValue)} (${formatPercent(p.returnPct)}) | Cash: ${formatCurrency(p.cashRemaining)} | Positions: ${positionList || "none"}`;
    })
    .join("\n");

  const recentTradesSummary =
    weeklyTrades.length > 0
      ? weeklyTrades
          .map((t) => {
            const player = players.find((p) => p.id === t.playerId);
            return `${t.date}: ${player?.name} ${t.type.toUpperCase()} ${t.shares} ${t.ticker} @ ${formatCurrency(t.price)}`;
          })
          .join("\n")
      : "No trades this week.";

  const allTickers = [
    ...new Set(
      leaderboard.flatMap((p) => p.positions.map((pos) => pos.ticker))
    ),
  ];

  return `You are writing a weekly email update for a friendly stock picking contest between three family members (Daddy, Eli, and Yitzi). Each started with $100,000 in virtual cash.

Write 2-3 short paragraphs (total ~150-200 words) covering:
1. Who's leading and by how much. Note any rank changes or tightening/widening gaps.
2. Any trades this week and what they signal about each player's strategy.
3. Brief commentary on how the held stocks (${allTickers.join(", ")}) have been doing. Mention any big movers.

Keep the tone casual and fun -- like a group chat among family, not a financial report. Use specific numbers from the data below. Be direct and concise.

STRICT WRITING RULES -- do NOT use any of these words or phrases: ${BANNED_WORDS.map((w) => `"${w}"`).join(", ")}. Write like a real person talking to family.

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
    max_tokens: 1024,
    messages: [{ role: "user", content: buildCommentaryPrompt(data) }],
  });
  const block = message.content[0];
  return block.type === "text" ? block.text : "";
}

// ---------- HTML Email Template ----------

export function buildEmailHtml(
  data: WeeklyReportData,
  commentary: string
): string {
  const { leaderboard, weeklyTrades, players, trades, currentPrices, reportDate } = data;

  const commentaryHtml = commentary
    .split("\n\n")
    .map((p) => `<p style="margin: 0 0 12px 0; color: #1f2937; font-size: 15px; line-height: 1.6;">${p}</p>`)
    .join("");

  const rankColors = ["#EAB308", "#9CA3AF", "#D97706", "#D1D5DB"];

  const leaderboardRows = leaderboard
    .map((p, i) => {
      const bg = i % 2 === 0 ? "#F9FAFB" : "#FFFFFF";
      const rankBg = rankColors[i] || rankColors[3];
      const returnColor = p.returnPct >= 0 ? "#059669" : "#DC2626";
      return `<tr style="background: ${bg};">
        <td style="padding: 12px 16px; text-align: center;">
          <span style="display: inline-block; width: 28px; height: 28px; border-radius: 50%; background: ${rankBg}; color: white; font-weight: bold; line-height: 28px; text-align: center; font-size: 14px;">${i + 1}</span>
        </td>
        <td style="padding: 12px 16px;">
          <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${p.color}; margin-right: 8px; vertical-align: middle;"></span>
          <span style="font-weight: 600; color: #111827;">${p.name}</span>
        </td>
        <td style="padding: 12px 16px; text-align: right; font-weight: 600; color: #111827;">${formatCurrency(p.totalValue)}</td>
        <td style="padding: 12px 16px; text-align: right; font-weight: 600; color: ${returnColor};">${formatPercent(p.returnPct)}</td>
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
                return `<tr style="border-bottom: 1px solid #F3F4F6;">
                  <td style="padding: 6px 10px; font-size: 13px; font-weight: 600; color: #111827;">${pos.ticker}</td>
                  <td style="padding: 6px 10px; font-size: 13px; color: #4B5563;">${pos.shares}</td>
                  <td style="padding: 6px 10px; font-size: 13px; color: #4B5563;">${formatCurrency(pos.avgCost)}</td>
                  <td style="padding: 6px 10px; font-size: 13px; color: #4B5563;">${formatCurrency(price)}</td>
                  <td style="padding: 6px 10px; font-size: 13px; font-weight: 600; color: ${gainColor}; text-align: right;">${formatCurrency(gain)}</td>
                  <td style="padding: 6px 10px; font-size: 13px; font-weight: 600; color: ${gainColor}; text-align: right;">${formatPercent(gainPct)}</td>
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
    <div style="background: #2563EB; border-radius: 12px 12px 0 0; padding: 24px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 22px; font-weight: 700;">Stock Picking Contest</h1>
      <p style="margin: 6px 0 0 0; color: #BFDBFE; font-size: 14px;">Weekly Report &mdash; ${reportDate}</p>
    </div>

    <div style="background: white; border-radius: 0 0 12px 12px; border: 1px solid #E5E7EB; border-top: none;">

      <!-- Commentary -->
      <div style="padding: 24px; border-bottom: 1px solid #E5E7EB;">
        ${commentaryHtml}
      </div>

      <!-- Leaderboard -->
      <div style="padding: 24px; border-bottom: 1px solid #E5E7EB;">
        <h2 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #111827;">Leaderboard</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #F9FAFB;">
              <th style="padding: 10px 16px; text-align: center; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Rank</th>
              <th style="padding: 10px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Player</th>
              <th style="padding: 10px 16px; text-align: right; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Total Value</th>
              <th style="padding: 10px 16px; text-align: right; font-size: 12px; font-weight: 600; color: #6B7280; text-transform: uppercase;">Return</th>
            </tr>
          </thead>
          <tbody>${leaderboardRows}</tbody>
        </table>
      </div>

      <!-- Weekly Trades -->
      <div style="padding: 24px; border-bottom: 1px solid #E5E7EB;">
        <h2 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #111827;">This Week's Trades</h2>
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
        <h2 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #111827;">Portfolio Details</h2>
        ${playerDetailsHtml}
      </div>

    </div>

    <!-- Footer -->
    <p style="text-align: center; color: #9CA3AF; font-size: 12px; margin-top: 16px;">
      Sent from Stock Contest Tracker
    </p>

  </div>
</body>
</html>`;
}

// ---------- Email Sending ----------

export async function sendWeeklyEmail(
  config: EmailConfig,
  data: WeeklyReportData,
  commentary: string
): Promise<void> {
  const html = buildEmailHtml(data, commentary);
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
  });
}
