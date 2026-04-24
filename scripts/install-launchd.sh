#!/bin/bash
# install-launchd.sh — Install/uninstall a launchd agent for the stock-contest app.
# Scripts are copied from the repo to ~/Library/Application Support/stock-contest/
# because macOS TCC blocks launchd from executing anything under ~/Desktop/.

set -euo pipefail

UNINSTALL=0
if [ "${1:-}" = "--uninstall" ]; then
  UNINSTALL=1
  shift
fi

JOB="${1:-}"
if [ -z "$JOB" ]; then
  echo "Usage: install-launchd.sh [--uninstall] <daily-refresh|weekly-email>"
  exit 1
fi

case "$JOB" in
  daily-refresh) SCRIPT_NAME="daily-refresh.sh"; LABEL="com.stockcontest.daily-refresh" ;;
  weekly-email)  SCRIPT_NAME="weekly-email.sh";  LABEL="com.stockcontest.weekly-email"  ;;
  *) echo "Unknown job: $JOB (expected daily-refresh or weekly-email)"; exit 1 ;;
esac

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="$HOME/Library/Application Support/stock-contest"
SCRIPTS_DIR="$INSTALL_DIR/scripts"
LOGS_DIR="$INSTALL_DIR/logs"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_NAME="${LABEL}.plist"
PLIST_TARGET="${LAUNCH_AGENTS_DIR}/${PLIST_NAME}"

if [ "$UNINSTALL" -eq 1 ]; then
  launchctl unload "$PLIST_TARGET" 2>/dev/null || true
  rm -f "$PLIST_TARGET"
  rm -f "${SCRIPTS_DIR}/${SCRIPT_NAME}"
  echo "Uninstalled ${LABEL}."
  exit 0
fi

mkdir -p "$SCRIPTS_DIR" "$LOGS_DIR" "$LAUNCH_AGENTS_DIR"

cp "${REPO_DIR}/scripts/${SCRIPT_NAME}" "${SCRIPTS_DIR}/${SCRIPT_NAME}"
chmod +x "${SCRIPTS_DIR}/${SCRIPT_NAME}"
cp "${REPO_DIR}/scripts/${PLIST_NAME}" "$PLIST_TARGET"

# Reload so updated paths/scripts take effect even if already installed
launchctl unload "$PLIST_TARGET" 2>/dev/null || true
launchctl load "$PLIST_TARGET"

echo "Installed ${LABEL}:"
echo "  script:  ${SCRIPTS_DIR}/${SCRIPT_NAME}"
echo "  plist:   ${PLIST_TARGET}"
echo "  logs:    ${LOGS_DIR}/"
