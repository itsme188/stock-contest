#!/bin/bash
# backup-db.sh — SQLite online backup to timestamped file
# Safe to run while the app is serving requests (respects WAL)

set -euo pipefail

PROJECT_DIR="/Users/Yitzi/Desktop/stock-contest"
DB_PATH="${PROJECT_DIR}/data/contest.db"
BACKUP_DIR="${PROJECT_DIR}/data/backups"
MAX_BACKUPS=30  # Keep last 30 backups

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: Database not found at ${DB_PATH}"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date '+%Y-%m-%d_%H%M%S')
BACKUP_FILE="${BACKUP_DIR}/contest-${TIMESTAMP}.db"

# SQLite .backup command is safe for online backups (handles WAL correctly)
sqlite3 "$DB_PATH" ".backup '${BACKUP_FILE}'"

echo "Backup created: ${BACKUP_FILE} ($(du -h "$BACKUP_FILE" | cut -f1))"

# Prune old backups, keep the most recent MAX_BACKUPS
ls -t "${BACKUP_DIR}"/contest-*.db 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f 2>/dev/null || true
