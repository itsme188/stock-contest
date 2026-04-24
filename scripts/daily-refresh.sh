#!/bin/bash
# daily-refresh.sh — Refresh prices + backfill gaps (IBKR primary, Polygon fallback).
# Called by launchd Mon-Fri at 9:31 AM and 4:20 PM.

set -euo pipefail

BASE_URL="http://localhost:3001"
# Logs live outside ~/Desktop/ because launchd is blocked by macOS TCC from
# touching files there. ~/Library/Application Support/ is non-protected.
LOG_DIR="$HOME/Library/Application Support/stock-contest/logs"
LOG_FILE="${LOG_DIR}/daily-refresh.log"
HEALTH_TIMEOUT=5
IBKR_TIMEOUT=60
POLYGON_TIMEOUT=300
BACKFILL_TIMEOUT=300

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Self-check: warn if the previous run is suspiciously old. 72h covers a normal
# Fri 16:20 -> Mon 9:31 weekend gap (~65h) and a one-off weekday miss without
# false-alarming, while still catching a launchd-unloaded / machine-off-for-days
# silent failure.
if [ -f "$LOG_FILE" ]; then
  LAST_RUN=$(stat -f %m "$LOG_FILE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  GAP=$(( NOW - LAST_RUN ))
  if [ "$GAP" -gt 259200 ]; then
    HOURS=$(( GAP / 3600 ))
    osascript -e "display notification \"Last daily-refresh was ${HOURS}h ago. Check: launchctl list com.stockcontest.daily-refresh\" with title \"Stock Contest\" subtitle \"Daily refresh was silent\"" 2>/dev/null || true
  fi
fi

log "=== Daily refresh started ==="

if ! curl -sf --max-time "$HEALTH_TIMEOUT" "${BASE_URL}/api/health" > /dev/null 2>&1; then
  log "Server not responding at ${BASE_URL}. Skipping this run."
  log "=== Daily refresh skipped ==="
  exit 0
fi

# Try IBKR first (live quotes, no rate limits, handles CAD tickers)
log "Trying IBKR TWS..."
IBKR_RESPONSE=$(curl -s --max-time "$IBKR_TIMEOUT" \
  -X POST "${BASE_URL}/api/prices/ibkr" \
  -H "Content-Type: application/json" 2>&1) || IBKR_RESPONSE=""

IBKR_OK=0
if [ -n "$IBKR_RESPONSE" ] && echo "$IBKR_RESPONSE" | grep -q '"ok":true'; then
  IBKR_OK=1
  log "IBKR ok: ${IBKR_RESPONSE}"
else
  log "IBKR failed or unavailable. Response: ${IBKR_RESPONSE:-<empty>}"
fi

# Polygon /prev fallback only if IBKR failed
if [ "$IBKR_OK" -eq 0 ]; then
  log "Falling back to Polygon..."
  POLY_RESPONSE=$(curl -s --max-time "$POLYGON_TIMEOUT" \
    -X POST "${BASE_URL}/api/prices/update" \
    -H "Content-Type: application/json" 2>&1) || POLY_RESPONSE=""
  log "Polygon response: ${POLY_RESPONSE:-<empty>}"
fi

# Always backfill so any prior-day gaps get filled
log "Running backfill..."
BACKFILL_RESPONSE=$(curl -s --max-time "$BACKFILL_TIMEOUT" \
  -X POST "${BASE_URL}/api/prices/backfill" \
  -H "Content-Type: application/json" 2>&1) || BACKFILL_RESPONSE=""
log "Backfill response: ${BACKFILL_RESPONSE:-<empty>}"

log "=== Daily refresh finished ==="
