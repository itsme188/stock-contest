# Stock Picking Contest

Track stock picks and performance for Daddy, Eli, and Yitzi. Each player starts with $100k virtual cash, max 5 open positions at a time. FIFO cost basis tracking for realized P&L.

## Quick Start

Double-click **Stock Contest.app** on the Desktop — it starts the server and opens Safari automatically.

Or from the terminal:

```bash
./scripts/start.sh
```

Then open http://localhost:3001.

## Features

- Leaderboard with total value, P&L %, and performance chart
- Trade logging (buy/sell) with Polygon.io price fetching
- Weekly email reports with AI commentary (Claude Sonnet)
- Historical price backfill
- Data import/export (JSON)

## Tech Stack

Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, SQLite, Recharts, Polygon.io API, nodemailer, Anthropic SDK.
