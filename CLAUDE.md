# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stock Picking Contest tracker for 3 players (Daddy, Eli, Yitzi). Each player gets $100k virtual cash, max 5 open positions at a time. Tracks trades, P&L (realized + unrealized via FIFO), leaderboard rankings, and performance over time.

## Commands

```bash
npm run dev        # Start dev server at http://localhost:3000
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

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary.
- **Demand Elegance**: For non-trivial changes, pause and ask "is there a more elegant way?" Skip for simple, obvious fixes.
