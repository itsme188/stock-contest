#!/bin/bash
# weekly-email.sh — Refresh prices then send weekly contest email
# Called by launchd every Friday at 4:20 PM

set -euo pipefail

BASE_URL="http://localhost:3001"
# Logs live outside ~/Desktop/ because launchd is blocked by macOS TCC from
# touching files there. ~/Library/Application Support/ is non-protected.
LOG_DIR="$HOME/Library/Application Support/stock-contest/logs"
LOG_FILE="${LOG_DIR}/weekly-email.log"
PRICE_TIMEOUT=300
EMAIL_TIMEOUT=120
SLEEP_AFTER_PRICES=5
RETRY_DELAY=300  # 5 minutes between retries
MAX_RETRIES=2

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

notify_failure() {
  local reason="$1"
  log "ERROR: $reason"
  log "=== Job failed ==="
  osascript -e "display notification \"$reason\" with title \"Stock Contest\" subtitle \"Weekly Email Failed\"" 2>/dev/null || true
  exit 1
}

# Check if prices are stale (any barDate < today)
prices_are_fresh() {
  local response="$1"
  local today
  today=$(date '+%Y-%m-%d')

  # Extract priceDates from JSON and check if all match today
  # If priceDates is missing or empty, assume stale
  if ! echo "$response" | grep -q '"priceDates"'; then
    return 1  # No priceDates field → stale
  fi

  # Check if any price date doesn't match today
  # priceDates looks like: "priceDates":{"AAPL":"2026-02-27","GOOG":"2026-02-27"}
  local stale_count
  stale_count=$(echo "$response" | python3 -c "
import json, sys
data = json.load(sys.stdin)
today = '${today}'
dates = data.get('priceDates', {})
if not dates:
    print(1)
else:
    stale = sum(1 for d in dates.values() if d != today)
    print(stale)
" 2>/dev/null || echo "1")

  [ "$stale_count" = "0" ]
}

log "=== Weekly email job started ==="

# Backup database before any operations
log "Running database backup..."
if bash "$(dirname "$0")/backup-db.sh" >> "$LOG_FILE" 2>&1; then
  log "Database backup completed"
else
  log "WARNING: Database backup failed (continuing anyway)"
fi

# Check if the server is running
if ! curl -sf --max-time 5 "${BASE_URL}/api/health" > /dev/null 2>&1; then
  notify_failure "Server not responding at ${BASE_URL}. Is the app running?"
fi

log "Server is up at ${BASE_URL}"

# Refresh prices: IBKR first (fast, no rate limits, handles CAD tickers),
# Polygon fallback with staleness check + retry if IBKR fails or returns stale
log "Refreshing prices via IBKR TWS..."
IBKR_RESPONSE=$(curl -sf --max-time 60 \
  -X POST "${BASE_URL}/api/prices/ibkr" \
  -H "Content-Type: application/json" 2>&1) || IBKR_RESPONSE=""

log "IBKR response: ${IBKR_RESPONSE:-<empty>}"

PRICE_RESPONSE=""
if [ -n "$IBKR_RESPONSE" ] \
  && echo "$IBKR_RESPONSE" | grep -q '"ok":true' \
  && prices_are_fresh "$IBKR_RESPONSE"; then
  log "IBKR TWS returned fresh prices."
  PRICE_RESPONSE="$IBKR_RESPONSE"
else
  log "IBKR unavailable or stale. Falling back to Polygon..."
  PRICE_RESPONSE=$(curl -sf --max-time "$PRICE_TIMEOUT" \
    -X POST "${BASE_URL}/api/prices/update" \
    -H "Content-Type: application/json" 2>&1) || {
    notify_failure "Both IBKR and Polygon price updates failed"
  }
  log "Polygon response: ${PRICE_RESPONSE}"

  if echo "$PRICE_RESPONSE" | grep -q '"error"'; then
    log "WARNING: Polygon returned an error (continuing anyway): ${PRICE_RESPONSE}"
  fi

  # Retry Polygon if prices are stale (Polygon /prev updates ~15 min after close)
  RETRY_COUNT=0
  while ! prices_are_fresh "$PRICE_RESPONSE" && [ "$RETRY_COUNT" -lt "$MAX_RETRIES" ]; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    log "Polygon prices stale. Retry ${RETRY_COUNT}/${MAX_RETRIES} in ${RETRY_DELAY}s..."
    sleep "$RETRY_DELAY"

    log "Retrying Polygon price refresh..."
    PRICE_RESPONSE=$(curl -sf --max-time "$PRICE_TIMEOUT" \
      -X POST "${BASE_URL}/api/prices/update" \
      -H "Content-Type: application/json" 2>&1) || {
      log "WARNING: Polygon retry ${RETRY_COUNT} failed"
      continue
    }
    log "Retry ${RETRY_COUNT} response: ${PRICE_RESPONSE}"
  done

  if ! prices_are_fresh "$PRICE_RESPONSE"; then
    log "WARNING: Polygon still stale after ${MAX_RETRIES} retries. Proceeding with best available prices."
  fi
fi

# Backfill historical daily prices so week-over-week calculations are accurate
log "Running price history backfill..."
BACKFILL_RESPONSE=$(curl -sf --max-time "$PRICE_TIMEOUT" \
  -X POST "${BASE_URL}/api/prices/backfill" \
  -H "Content-Type: application/json" 2>&1) || {
  log "WARNING: Price backfill failed (continuing anyway): ${BACKFILL_RESPONSE:-<empty>}"
}
if [ -n "$BACKFILL_RESPONSE" ]; then
  log "Backfill response: ${BACKFILL_RESPONSE}"
fi

# Refresh S&P 500 benchmark (SPY isn't in anyone's portfolio, so backfill skips it)
log "Refreshing S&P 500 benchmark..."
BENCHMARK_RESPONSE=$(curl -sf --max-time "$PRICE_TIMEOUT" \
  -X POST "${BASE_URL}/api/prices/benchmark" \
  -H "Content-Type: application/json" 2>&1) || {
  log "WARNING: Benchmark refresh failed (continuing anyway): ${BENCHMARK_RESPONSE:-<empty>}"
}
if [ -n "$BENCHMARK_RESPONSE" ]; then
  log "Benchmark response: ${BENCHMARK_RESPONSE}"
fi

# Brief delay to let SQLite settle
log "Waiting ${SLEEP_AFTER_PRICES}s before sending email..."
sleep "$SLEEP_AFTER_PRICES"

# Send weekly email
log "Sending weekly email..."
EMAIL_RESPONSE=$(curl -sf --max-time "$EMAIL_TIMEOUT" \
  -X POST "${BASE_URL}/api/email/weekly" \
  -H "Content-Type: application/json" \
  -d '{}' 2>&1) || {
  notify_failure "Email send failed or timed out"
}

log "Email response: ${EMAIL_RESPONSE}"

if echo "$EMAIL_RESPONSE" | grep -q '"skipped":true'; then
  log "=== Skipped: email already sent today (manual send detected) ==="
elif echo "$EMAIL_RESPONSE" | grep -q '"ok":true'; then
  log "=== Weekly email sent successfully ==="
else
  notify_failure "Email returned unexpected response"
fi
