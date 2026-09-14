# Database migrations

Migrations live in `db/migrations` and are applied with `pnpm db:migrate` (`node-pg-migrate up`).

## Policy

Migrations in this repository are **reversible**. Each file must provide a `down()` that restores the previous schema sufficiently for `down` then `up` testing.

`1750000000002_tenant_fks_embeddings_provenance` originally shipped a partial `down()` that dropped embedding columns without restoring composite-FK predecessors. `down()` now:

- restores single-column foreign keys
- drops composite unique keys added in 0002
- restores `knowledge.chunks.embedding` as `vector(64)`
- **deletes existing chunk rows** because 768-d vectors cannot be converted to 64-d

Do not run `pnpm db:migrate:down` against a database you care about without a backup. Forward-only behavior is not the policy; incomplete `down()` functions are not allowed.

Phase 7 (`1750000000003_execution_graph_v2`) follows the same rule.
