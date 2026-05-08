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

# Copy every shell script the launchd agent might call. Previously only the
# named entry-point was copied; weekly-email.sh references backup-db.sh as a
# relative dep, which silently failed every run with "No such file or
# directory" because the dep was never installed.
copy_script() {
  local src="$1"
  local dst="$2"
  if [ ! -f "$src" ]; then
    echo "ERROR: source script missing: $src" >&2
    exit 1
  fi
  cp "$src" "$dst"
  chmod +x "$dst"
  if [ ! -x "$dst" ]; then
    echo "ERROR: failed to install $dst" >&2
    exit 1
  fi
}

for sh in "${REPO_DIR}/scripts/"*.sh; do
  base="$(basename "$sh")"
  copy_script "$sh" "${SCRIPTS_DIR}/${base}"
done

if [ ! -f "${REPO_DIR}/scripts/${PLIST_NAME}" ]; then
  echo "ERROR: plist not found in repo: ${REPO_DIR}/scripts/${PLIST_NAME}" >&2
  exit 1
fi
cp "${REPO_DIR}/scripts/${PLIST_NAME}" "$PLIST_TARGET"

# Reload so updated paths/scripts take effect even if already installed
launchctl unload "$PLIST_TARGET" 2>/dev/null || true
if ! launchctl load "$PLIST_TARGET"; then
  echo "ERROR: launchctl load failed for $PLIST_TARGET" >&2
  exit 1
fi

# Verify the agent actually registered. Previously a silent load failure
# would leave the user thinking the job was installed when it wasn't.
sleep 1
if ! launchctl list | grep -q "$LABEL"; then
  echo "ERROR: ${LABEL} did not register with launchd after load" >&2
  exit 1
fi

echo "Installed ${LABEL}:"
echo "  script:  ${SCRIPTS_DIR}/${SCRIPT_NAME}"
for dep in "${SCRIPTS_DIR}/"*.sh; do
  if [ "$(basename "$dep")" != "$SCRIPT_NAME" ]; then
    echo "  dep:     $dep"
  fi
done
echo "  plist:   ${PLIST_TARGET}"
echo "  logs:    ${LOGS_DIR}/"
