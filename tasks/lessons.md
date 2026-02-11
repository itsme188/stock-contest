# Stock Contest - Lessons Learned

## 2026-02-08: Data Integrity on Port

When porting from an in-memory session to a persistent project:
- **Verify all exported data is wired up on import.** The original export included `priceHistory` but the import function never loaded it, and `getPlayerValueAtDate()` silently fell back to stale trade prices. Always test the full roundtrip.
- **FIFO logic must be consistent everywhere.** `getPlayerStats()` did FIFO correctly for realized P&L, but `getPlayerPositions()` used a naive `totalCost -= shares * sellPrice` which corrupted avgCost. Any function computing cost basis must use the same FIFO lot tracking.
- **Validate cash before allowing buys.** The system allowed $20k position buys even when the player had less cash available, causing negative cash balances. Always check `stats.cashRemaining >= tradeCost` before accepting a buy.
- **Dates matter: no trading on weekends.** Jan 4, 2026 is a Saturday. Trades entered on non-trading days should use the next trading day. Double-check dates when logging historical trades.
- **Best/worst trade colors should reflect actual gain/loss**, not assume best=green and worst=red. A player whose only closed trades are losses will have a "best" trade that's still red.
- **Position sizing should be context-aware.** When rotating out of a position, the new buy should default to using the sale proceeds, not the fixed $20k default. (Future improvement — not yet implemented.)

## 2026-02-11: AI Commentary Prompt Engineering

- **Pre-compute everything for the AI — never make it do math.** The model confused per-share price with position size because we showed `avg cost $452` without showing total dollars deployed. The model saw a high per-share price and called it the "largest bet" when it was actually a smaller position by total dollars. Fix: show `$19,888 deployed, now worth $20,500 (+3.07%)` — all the math done, no ambiguity.
- **When data can be misinterpreted, add an explicit rule.** Even with better data, we added a strict rule: "Position size = total dollars deployed, NOT per-share price." Belt and suspenders.
- **Trade data should include total dollar amounts**, not just `shares × price`. `BUY 44 AAPL @ $452` requires mental math; `BUY 44 AAPL @ $452 ($19,888 total)` does not.
- **AI writing tells are well-documented — use the research.** Wikipedia's "Signs of AI writing" page and academic papers identify specific words (delve, elevate, resonate, seamless, testament, intricate, etc.) whose usage spiked post-LLM. Ban them explicitly. Also ban rhetorical patterns like "it's not X, it's Y" and glazing words (impressive, incredible, remarkable).
- **Tone instructions need a concrete example.** Telling the model "be dry and matter-of-fact" is vague. Showing a full example paragraph in the desired voice produces much more consistent output.
