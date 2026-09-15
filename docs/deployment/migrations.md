# Database migrations

Migrations live in `db/migrations` and are applied with `pnpm db:migrate` (`node-pg-migrate up`).

## Policy

Migrations in this repository are **reversible**. Each file must provide a `down()` that restores the previous schema sufficiently for `down` then `up` testing.

`1750000000002_tenant_fks_embeddings_provenance` originally shipped a partial `down()` that dropped embedding columns without restoring composite-FK predecessors. `down()` now:

- restores single-column foreign keys
- drops composite unique keys added in 0002
- restores `knowledge.chunks.embedding` as `vector(64)`
- **deletes existing chunk rows** because 768-d vectors cannot be converted to 64-d

Do not run `pnpm db:migrate:down` against a database you care about without a backup. Forward-only is the **operational** policy for demo/sovereign: restore from backup instead of down-migrating. In the repository, every migration still provides `down()` so CI can test reversibility (`MIGRATION_SMOKE_DOWN=1 scripts/migration-smoke.sh`). Incomplete `down()` functions are not allowed.

`pnpm db:status` prints pending/applied migrations.

Phase 7 (`1750000000003_execution_graph_v2`) follows the same rule. Phase 8 (`1750000000004_nova_phase8`) adds `nova`/`social` schemas, `social.draft`, and `command.approvals.artifact_hash`. It does not copy Content-Loop production rows. Phase 8 hardening (`1750000000005_nova_tenant_integrity`) adds composite organization FKs and `proposed_config_version`. Phase 9 (`1750000000006_connector_gateway`) adds connector type/secret-ref columns, `command.skill_connectors`, `command.connector_actions` (idempotency ledger), and social `connector_action_id` / `scheduled_for` / `external_action_id`. It does not copy production Meta credentials or Content-Loop rows.
