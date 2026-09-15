# VerityOS

Governed, grounded, auditable AI operating environment created by KGC Inc.

Nova is not VerityOS. Knowledge is not VerityOS. The Audit Kernel is not VerityOS. They are components of the operating environment.

> Your organization's AI, grounded in your data, operating under your rules, with evidence of what happened.

## Current status

Phase 10: Verity Shell over the Phase 9 Connector Gateway and Phase 8 Nova runtime. See [docs/architecture/shell.md](docs/architecture/shell.md). Hash Format V2 and Execution Graph V2 hashing are unchanged. Production Content-Loop is not modified.

Production Nova remains the [Content Loop](https://github.com/salutethegenius/Content-Loop) deployment. This repository does not modify that production system.

## Layout

```text
apps/           core-api, nova runtime, Verity Shell; knowledge Python package
packages/       audit-kernel, identity, command, connectors, model-router, knowledge, contracts, sdks
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
pnpm seed:dev
pnpm --filter @verityos/shell dev
```

Default local login after seed: `admin@verity.local` / `verity-dev-admin` at http://127.0.0.1:3000/login. See [docs/deployment/development.md](docs/deployment/development.md).


Offline verification of an evidence bundle (no database):

```bash
pnpm --filter @verityos/audit-kernel exec node dist/cli.js export path/to/bundle.json
```

See [docs/architecture/system.md](docs/architecture/system.md) and [docs/architecture/audit-kernel.md](docs/architecture/audit-kernel.md).
