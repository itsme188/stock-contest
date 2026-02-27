#!/bin/bash
# weekly-email.sh — Refresh prices then send weekly contest email
# Called by launchd every Friday at 4:20 PM

set -euo pipefail

BASE_URL="http://localhost:3001"
LOG_DIR="/Users/Yitzi/Desktop/stock-contest/data/logs"
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

# Check if the server is running
if ! curl -sf --max-time 5 "${BASE_URL}/api/contest" > /dev/null 2>&1; then
  log "ERROR: Server not responding at ${BASE_URL}. Is the app running?"
  log "=== Job failed ==="
  exit 1
fi

log "Server is up at ${BASE_URL}"

# Refresh prices via Polygon with staleness check + retry
log "Refreshing prices via Polygon..."
PRICE_RESPONSE=$(curl -sf --max-time "$PRICE_TIMEOUT" \
  -X POST "${BASE_URL}/api/prices/update" \
  -H "Content-Type: application/json" 2>&1) || {
  log "ERROR: Price update failed or timed out. Response: ${PRICE_RESPONSE:-<empty>}"
  log "=== Job failed ==="
  exit 1
}

log "Price update response: ${PRICE_RESPONSE}"

if echo "$PRICE_RESPONSE" | grep -q '"error"'; then
  log "WARNING: Price update returned an error (continuing anyway): ${PRICE_RESPONSE}"
fi

# Check if prices are fresh (from today's market close)
RETRY_COUNT=0
while ! prices_are_fresh "$PRICE_RESPONSE" && [ "$RETRY_COUNT" -lt "$MAX_RETRIES" ]; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  log "Prices appear stale (not from today). Retry ${RETRY_COUNT}/${MAX_RETRIES} in ${RETRY_DELAY}s..."
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

# If still stale after retries, try IBKR TWS as fallback
if ! prices_are_fresh "$PRICE_RESPONSE"; then
  log "Prices still stale after ${MAX_RETRIES} retries. Trying IBKR TWS fallback..."
  IBKR_RESPONSE=$(curl -sf --max-time 60 \
    -X POST "${BASE_URL}/api/prices/ibkr" \
    -H "Content-Type: application/json" 2>&1) || {
    log "WARNING: IBKR TWS fallback failed (TWS may not be running). Proceeding with best available prices."
    IBKR_RESPONSE=""
  }

  if [ -n "$IBKR_RESPONSE" ]; then
    log "IBKR response: ${IBKR_RESPONSE}"
    if echo "$IBKR_RESPONSE" | grep -q '"ok":true'; then
      log "IBKR TWS prices fetched successfully"
    else
      log "WARNING: IBKR returned unexpected response. Proceeding with Polygon prices."
    fi
  fi
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
  log "ERROR: Email send failed or timed out. Response: ${EMAIL_RESPONSE:-<empty>}"
  log "=== Job failed ==="
  exit 1
}

log "Email response: ${EMAIL_RESPONSE}"

if echo "$EMAIL_RESPONSE" | grep -q '"ok":true'; then
  log "=== Weekly email sent successfully ==="
else
  log "ERROR: Email send returned unexpected response: ${EMAIL_RESPONSE}"
  log "=== Job failed ==="
  exit 1
fi
