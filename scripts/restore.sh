#!/usr/bin/env bash
set -euo pipefail
# Restore a backup produced by scripts/backup.sh into a fresh DATABASE_URL and VERITY_DATA_DIR.
# Usage: scripts/restore.sh /path/to/verityos-STAMP

BACKUP_DIR="${1:?backup directory required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${VERITY_DATA_DIR:?VERITY_DATA_DIR is required}"

MANIFEST="${BACKUP_DIR}/manifest.json"
test -f "${MANIFEST}"

DB_FILE="$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['database_file'])")"
FILES_FILE="$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['files_archive'])")"
EXPECT_DB="$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['database_sha256'])")"
EXPECT_FILES="$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['files_sha256'])")"

DB_HASH="$(sha256sum "${BACKUP_DIR}/${DB_FILE}" | awk '{print $1}')"
FILES_HASH="$(sha256sum "${BACKUP_DIR}/${FILES_FILE}" | awk '{print $1}')"
if [[ "${DB_HASH}" != "${EXPECT_DB}" || "${FILES_HASH}" != "${EXPECT_FILES}" ]]; then
  echo "backup hash mismatch" >&2
  exit 1
fi

psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null || true
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${BACKUP_DIR}/${DB_FILE}"
mkdir -p "${VERITY_DATA_DIR}"
tar -xzf "${BACKUP_DIR}/${FILES_FILE}" -C "${VERITY_DATA_DIR}"
echo "restored ${BACKUP_DIR}"
