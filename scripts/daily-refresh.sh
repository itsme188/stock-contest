#!/bin/bash
# daily-refresh.sh — Refresh prices + backfill gaps (IBKR primary, Polygon fallback).
# Called by launchd Mon-Fri at 9:31 AM and 4:20 PM.

set -euo pipefail

BASE_URL="http://localhost:3001"
LOG_DIR="/Users/Yitzi/Desktop/stock-contest/data/logs"
LOG_FILE="${LOG_DIR}/daily-refresh.log"
HEALTH_TIMEOUT=5
IBKR_TIMEOUT=60
POLYGON_TIMEOUT=300
BACKFILL_TIMEOUT=300

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

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
