#!/usr/bin/env bash
set -euo pipefail
# Logical Postgres + Knowledge file backup. Credentials come from DATABASE_URL.
# Usage: scripts/backup.sh [destination-dir]

DEST="${1:-./backups}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${VERITY_DATA_DIR:=./data}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKDIR="${DEST}/verityos-${STAMP}"
mkdir -p "${WORKDIR}"

DB_FILE="verityos-${STAMP}.sql"
FILES_FILE="verity-data-${STAMP}.tar.gz"
pg_dump --no-owner --no-acl "${DATABASE_URL}" > "${WORKDIR}/${DB_FILE}"
mkdir -p "${VERITY_DATA_DIR}"
tar -czf "${WORKDIR}/${FILES_FILE}" -C "${VERITY_DATA_DIR}" .

DB_HASH="$(sha256sum "${WORKDIR}/${DB_FILE}" | awk '{print $1}')"
FILES_HASH="$(sha256sum "${WORKDIR}/${FILES_FILE}" | awk '{print $1}')"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
MIGRATION="$(psql "${DATABASE_URL}" -Atc "SELECT id FROM pgmigrations ORDER BY run_on DESC LIMIT 1" 2>/dev/null || echo unknown)"

cat > "${WORKDIR}/manifest.json" <<EOF
{
  "created_at": "${STAMP}",
  "kind": "operational_backup",
  "not_audit_evidence": true,
  "application_version": "0.1.0-rc1",
  "git_commit": "${COMMIT}",
  "migration_state": "${MIGRATION}",
  "database_file": "${DB_FILE}",
  "database_sha256": "${DB_HASH}",
  "files_archive": "${FILES_FILE}",
  "files_sha256": "${FILES_HASH}"
}
EOF

echo "${WORKDIR}"
