# Stock Contest - Lessons Learned

## 2026-02-08: Data Integrity on Port

When porting from an in-memory session to a persistent project:
- **Verify all exported data is wired up on import.** The original export included `priceHistory` but the import function never loaded it, and `getPlayerValueAtDate()` silently fell back to stale trade prices. Always test the full roundtrip.
- **FIFO logic must be consistent everywhere.** `getPlayerStats()` did FIFO correctly for realized P&L, but `getPlayerPositions()` used a naive `totalCost -= shares * sellPrice` which corrupted avgCost. Any function computing cost basis must use the same FIFO lot tracking.
- **Validate cash before allowing buys.** The system allowed $20k position buys even when the player had less cash available, causing negative cash balances. Always check `stats.cashRemaining >= tradeCost` before accepting a buy.
- **Dates matter: no trading on weekends.** Jan 4, 2026 is a Saturday. Trades entered on non-trading days should use the next trading day. Double-check dates when logging historical trades.
- **Best/worst trade colors should reflect actual gain/loss**, not assume best=green and worst=red. A player whose only closed trades are losses will have a "best" trade that's still red.
- **Position sizing should be context-aware.** When rotating out of a position, the new buy should default to using the sale proceeds, not the fixed $20k default. (Future improvement — not yet implemented.)
