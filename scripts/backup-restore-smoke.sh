#!/usr/bin/env bash
set -euo pipefail
# CI smoke: dump current test DB, restore into a sibling database, check org table exists.

: "${DATABASE_URL:?DATABASE_URL is required}"
export VERITY_DATA_DIR="${VERITY_DATA_DIR:-/tmp/verity-data}"
export WORKDIR
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

RESTORE_NAME="$(python3 - <<'PY'
import os, urllib.parse
url = os.environ["DATABASE_URL"]
parsed = urllib.parse.urlparse(url)
name = parsed.path.lstrip("/")
restore = name + "_restore"
open(os.path.join(os.environ["WORKDIR"], "restore_url"), "w").write(parsed._replace(path="/" + restore).geturl())
admin_path = "/postgres"
open(os.path.join(os.environ["WORKDIR"], "admin_url"), "w").write(parsed._replace(path=admin_path).geturl())
print(restore)
PY
)"
RESTORE_URL="$(cat "${WORKDIR}/restore_url")"
ADMIN_URL="$(cat "${WORKDIR}/admin_url")"

BACKUP_OUT="$(DATABASE_URL="${DATABASE_URL}" VERITY_DATA_DIR="${VERITY_DATA_DIR}" scripts/backup.sh "${WORKDIR}/backups")"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${RESTORE_NAME};"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${RESTORE_NAME};"
DATABASE_URL="${RESTORE_URL}" VERITY_DATA_DIR="${WORKDIR}/restore-data" scripts/restore.sh "${BACKUP_OUT}"
COUNT="$(psql "${RESTORE_URL}" -Atc "SELECT count(*) FROM auth.organizations")"
test "${COUNT}" -ge 0
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${RESTORE_NAME};"
echo "backup-restore smoke ok orgs=${COUNT} dir=${BACKUP_OUT}"
