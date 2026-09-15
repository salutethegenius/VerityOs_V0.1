# Backup and restore (V0.1)

Operational backups are **not** Audit Kernel evidence. SHA-256 hashes in the backup manifest prove that the files you restore are the files you took. They do not prove that the Audit chain is the latest chain, and they do not replace `POST /verify`.

## What is in a release backup set

1. Logical Postgres dump (`pg_dump`) of every Verity schema: `auth`, `command`, `knowledge`, `nova`, `social`, `audit`, `system` (if present), plus public extensions such as `vector`.
2. Archive of `VERITY_DATA_DIR` (Knowledge blobs).
3. `manifest.json` with `created_at`, filenames, SHA-256 hashes, application version, git commit, and latest `pgmigrations` id.

A database dump without Knowledge files may restore logins and Audit rows that point at missing blobs. Treat the pair as one set.

## Backup

Credentials come from `DATABASE_URL`. Nothing is hardcoded.

```bash
export DATABASE_URL=postgres://verityos:verityos@127.0.0.1:5432/verityos_audit
export VERITY_DATA_DIR=./data
scripts/backup.sh ./backups
```

Writes `backups/verityos-<UTC>/` containing the SQL dump, `verity-data-*.tar.gz`, and `manifest.json`.

## Restore (fresh environment)

1. New Postgres (pgvector) and empty `VERITY_DATA_DIR`.
2. `CREATE DATABASE` (empty).
3. `DATABASE_URL=<new> VERITY_DATA_DIR=<empty-or-parent> scripts/restore.sh backups/verityos-<stamp>`
4. `pnpm db:status` — migrations should already be present in the dump. Run `pnpm db:migrate` only if status shows pending.
5. Start Core, Nova, Shell.
6. Log in, open a Knowledge source, run a grounded query, `Verify` an existing Verity Record.

Restore verifies SHA-256 before applying files. A mismatch aborts.

CI smoke: `scripts/backup-restore-smoke.sh` dumps the test database, restores into a sibling database, and checks `auth.organizations` is readable.

## Verification after restore

- `pnpm db:status`
- `GET /health/ready` on Core (database true, no connection string)
- Log in
- Knowledge source bytes open
- Grounded retrieve returns hits if blobs were included
- `POST /v1/audit/records/:id/verify` → Integrity Verified + Provenance Verified for a pre-backup record

## Failure cases

| Case | Result |
| --- | --- |
| Hash mismatch | restore aborts |
| DB restored, files omitted | metadata/Audit present; Knowledge open/index may fail |
| Files restored, DB omitted | orphan blobs; logins missing |
| Restore onto a non-empty DB | `pg_dump` SQL may error on existing objects — use a fresh database |
| Older backup | internally consistent history; see unsigned heads below |

## What is and is not protected

Protected: Postgres contents and Knowledge blobs you actually archived, plus integrity of those files via SHA-256.

Not protected:

- Secrets in the environment (`SESSION_SECRET`, Nova tokens, Meta tokens, model keys). Rotate them after a restore into a new host.
- External Meta/Slack state.
- Proof that this chain is the latest chain.

## Unsigned chain heads (known limitation)

Current Audit chain heads are **not** externally signed or anchored. Restoring an older internally-consistent database cannot yet be cryptographically distinguished from rollback using the chain alone. Offline verify still detects tampering of hashed fields inside a bundle. It does not prove freshness or completeness against truncation.

Do not claim Fact Verified or Truth Verified.
