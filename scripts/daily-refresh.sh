#!/bin/bash
# daily-refresh.sh — Refresh prices + backfill gaps (IBKR primary, Polygon fallback).
# launchd polls this script frequently (StartInterval, see the .plist); the
# scheduling guard below runs the refresh once per slot per weekday. We do NOT use
# StartCalendarInterval: on this laptop, sleep-deferred calendar fires get
# re-anchored by macOS UserEventAgent and drift to the wrong time (the 09:31 AM /
# 16:20 PM slots had drifted to ~02:31 AM / 09:20 AM). A frequent poll plus a
# script-owned window cannot drift.

set -euo pipefail

BASE_URL="http://localhost:3001"
# Logs live outside ~/Desktop/ because launchd is blocked by macOS TCC from
# touching files there. ~/Library/Application Support/ is non-protected.
LOG_DIR="$HOME/Library/Application Support/stock-contest/logs"
LOG_FILE="${LOG_DIR}/daily-refresh.log"
AM_MARKER="${LOG_DIR}/.daily-refresh-am-last"   # YYYY-MM-DD of last completed morning run
PM_MARKER="${LOG_DIR}/.daily-refresh-pm-last"   # YYYY-MM-DD of last completed afternoon run
HEALTH_TIMEOUT=5
IBKR_TIMEOUT=60
POLYGON_TIMEOUT=300
BACKFILL_TIMEOUT=300

# Slot windows (local time, HHMM): morning refresh after the 09:30 open,
# afternoon refresh after the 16:00 close.
AM_START=0931
PM_START=1620

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Fire an osascript notification at most once per calendar day per key. The
# script is polled every few minutes, so an unthrottled alert on a persistent
# problem would spam Notification Center hundreds of times; this caps it to one.
notify_throttled() {
  local key="$1" title="$2" subtitle="$3" message="$4"
  local stamp="${LOG_DIR}/.notify-${key}"
  local today; today=$(date +%F)
  if [ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$today" ]; then
    return 0  # already alerted today for this key
  fi
  echo "$today" > "$stamp"
  osascript -e "display notification \"$message\" with title \"$title\" subtitle \"$subtitle\"" 2>/dev/null || true
}

# --- Drift-proof scheduling guard ---------------------------------------------
# Run the morning slot once on/after 09:31 and the afternoon slot once on/after
# 16:20, weekdays only, at most once per slot per day. Out-of-window and
# already-done polls exit in milliseconds with no logging or work.
NOW_DOW=$(date +%u)         # 1=Mon .. 7=Sun
NOW_HHMM=$(date +%H%M)       # zero-padded HHMM, e.g. 0931
NOW_DATE=$(date +%F)         # YYYY-MM-DD

if [ "$NOW_DOW" -gt 5 ]; then
  exit 0                     # weekend
fi

if [ "$NOW_HHMM" -ge "$PM_START" ]; then
  SLOT="pm"; SLOT_MARKER="$PM_MARKER"
elif [ "$NOW_HHMM" -ge "$AM_START" ]; then
  SLOT="am"; SLOT_MARKER="$AM_MARKER"
else
  exit 0                     # before the morning window
fi

if [ -f "$SLOT_MARKER" ] && [ "$(cat "$SLOT_MARKER" 2>/dev/null)" = "$NOW_DATE" ]; then
  exit 0                     # this slot already completed today
fi
# --- end scheduling guard -----------------------------------------------------

# Heartbeat: warn (once/day) if the last successful run is suspiciously old —
# catches a launchd-unloaded / machine-off-for-days silent failure. 72h covers a
# normal Fri PM -> Mon AM weekend gap (~65h) without false-alarming.
if [ -f "$LOG_FILE" ]; then
  LAST_RUN=$(stat -f %m "$LOG_FILE" 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  if [ "$(( NOW_EPOCH - LAST_RUN ))" -gt 259200 ]; then
    HOURS=$(( (NOW_EPOCH - LAST_RUN) / 3600 ))
    notify_throttled "daily-refresh-stale" "Stock Contest" "Daily refresh was silent" \
      "Last daily-refresh was ${HOURS}h ago. Check: launchctl print gui/$(id -u)/com.stockcontest.daily-refresh"
  fi
fi

# Health check first: if the app is down, retry on the next poll WITHOUT logging
# or marking the slot, so a prolonged in-window outage cannot spam the log.
if ! curl -sf --max-time "$HEALTH_TIMEOUT" "${BASE_URL}/api/health" > /dev/null 2>&1; then
  exit 0
fi

log "=== Daily refresh started (${SLOT} slot) ==="

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

# Mark this slot done only after a genuine refresh attempt completed (we reached
# here, so the server was up). The health-skip above never marks, so it retries.
echo "$NOW_DATE" > "$SLOT_MARKER"
log "=== Daily refresh finished (${SLOT} slot) ==="
