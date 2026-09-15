#!/usr/bin/env bash
set -euo pipefail
# Fresh-ish migrate up, optional down/up of the latest reversible migration, then up again.
# Does not drop the database. Safe for CI after the primary migrate step.

: "${DATABASE_URL:?DATABASE_URL is required}"

pnpm db:status

pnpm db:migrate

if [[ "${MIGRATION_SMOKE_DOWN:-0}" == "1" ]]; then
  echo "running one down() then up() for reversibility"
  pnpm db:migrate:down
  pnpm db:migrate
fi

psql "${DATABASE_URL}" -Atc "SELECT id FROM pgmigrations ORDER BY run_on"
echo "migration smoke ok"
