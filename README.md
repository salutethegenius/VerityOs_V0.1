# VerityOS

Governed, grounded, auditable AI operating environment created by KGC Inc.

Nova is not VerityOS. Knowledge is not VerityOS. The Audit Kernel is not VerityOS. They are components of the operating environment.

> Your organization's AI, grounded in your data, operating under your rules, with evidence of what happened.

## Current status

Phase 0–2: monorepo skeleton and **Audit Kernel V2**. Identity, Knowledge, Nova migration, and Verity Shell are not in this pass.

Production Nova remains the [Content Loop](https://github.com/salutethegenius/Content-Loop) deployment. This repository does not modify that production system.

## Layout

```text
apps/           core-api, shell stubs; nova/knowledge Python stubs
packages/       audit-kernel, contracts, sdk-ts, sdk-python
db/migrations   single node-pg-migrate history
tests/          audit tests and Nova behavior fixtures
docs/           architecture, security, deployment, migration inventory
```

## Development

```bash
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm test
pnpm --filter @verityos/audit-kernel exec vitest run
pnpm build
```

Offline verification of an evidence bundle (no database):

```bash
pnpm --filter @verityos/audit-kernel exec node dist/cli.js export path/to/bundle.json
```

See [docs/architecture/system.md](docs/architecture/system.md) and [docs/architecture/audit-kernel.md](docs/architecture/audit-kernel.md).
