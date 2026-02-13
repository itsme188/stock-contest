#!/bin/bash
# weekly-email.sh — Refresh prices then send weekly contest email
# Called by launchd every Friday at 4:10 PM

set -euo pipefail

BASE_URL="http://localhost:3001"
LOG_DIR="/Users/Yitzi/code/stock-contest/data/logs"
LOG_FILE="${LOG_DIR}/weekly-email.log"
PRICE_TIMEOUT=300
EMAIL_TIMEOUT=120
SLEEP_AFTER_PRICES=5

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log "=== Weekly email job started ==="

# Check if the server is running
if ! curl -sf --max-time 5 "${BASE_URL}/api/contest" > /dev/null 2>&1; then
  log "ERROR: Server not responding at ${BASE_URL}. Is the app running?"
  log "=== Job failed ==="
  exit 1
fi

log "Server is up at ${BASE_URL}"

# Refresh prices
log "Refreshing prices..."
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
