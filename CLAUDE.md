# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stock Picking Contest tracker for 3 players (Daddy, Eli, Yitzi). Each player gets $100k virtual cash, max 5 open positions at a time. Tracks trades, P&L (realized + unrealized via FIFO), leaderboard rankings, and performance over time.

## Commands

```bash
npm run dev        # Start dev server at http://localhost:3001
npm run build      # Production build
npm run lint       # ESLint check
npm run test       # Run Vitest tests
npm run test:watch # Vitest in watch mode
```

## Tech Stack

- **Framework**: Next.js 16 with React 19, TypeScript 5
- **Styling**: Tailwind CSS 4
- **Charts**: Recharts
- **Storage**: localStorage (client-side)
- **Testing**: Vitest

## Architecture

### Data Flow
1. All data stored in browser localStorage (players, trades, current prices)
2. Client-side computation of positions, P&L, leaderboard
3. Manual price entry or API fetch via Polygon.io (requires free API key)
4. Import/export contest data as JSON files

### Key Directories
- `app/dashboard/` - Main UI (StockContestTracker client component)
- `data/` - Exported contest data snapshots
- `tasks/` - Todo and lessons files

### Contest Rules
- $100,000 starting cash per player
- Maximum 5 open positions at any time
- Default position size: $20,000
- FIFO cost basis tracking for realized P&L

### Import Aliases
Use `@/*` for imports.

## Workflow

### Planning
- Enter plan mode for any non-trivial task (3+ steps or architectural decisions)
- Write plan to `tasks/todo.md` with checkable items before implementing
- If something goes sideways, STOP and re-plan immediately

### Execution
- Use subagents liberally for research, exploration, and parallel analysis
- Mark items complete as you go
- High-level summary at each step

### Verification
- Never mark a task complete without proving it works
- Run tests, check logs, demonstrate correctness

### After Corrections
- Update `tasks/lessons.md` with the pattern after any user correction
- Write rules that prevent the same mistake

## Project History

This project was originally built as a single-file React app (`stock-contest-tracker.jsx`) inside a Claude local agent session in VSCode on January 14, 2026. It also had a standalone HTML version. Both lived in `~/Library/Application Support/Claude/local-agent-mode-sessions/` with no git repo or proper project structure.

On February 8, 2026, the app was ported into this organized Next.js project:
1. Scaffolded with `create-next-app` (Next.js 16, TypeScript, Tailwind 4, ESLint)
2. Added Recharts and Vitest as dependencies
3. Ported the ~1,300-line JSX component to TypeScript (`app/dashboard/StockContestTracker.tsx`)
4. Created project guidance (`CLAUDE.md`), task tracking (`tasks/`), and seeded contest data (`data/`)
5. Configured dev server on port 3001 (port 3000 is used by the vanguard-skin portfolio dashboard)
6. All data remains in localStorage — SQLite migration is a future improvement

The existing contest data (3 players, 17 trades, price history through Jan 30) can be loaded via Settings > Import from `data/stock-contest-2026-01-30.json`.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary.
- **Demand Elegance**: For non-trivial changes, pause and ask "is there a more elegant way?" Skip for simple, obvious fixes.
