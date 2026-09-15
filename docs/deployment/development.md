# Development deployment

```bash
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm test
pnpm build
```

If Docker is unavailable, point `DATABASE_URL` at a local PostgreSQL 16 database named `verityos_audit`.

Phase 3–10 Core API tests use the mock model adapter and `MockEmbeddingProvider` (`VERITY_EMBEDDING_PROVIDER=mock`). Nova talks to Core; it does not call Anthropic, OpenAI, or Meta. Connector Gateway tests inject fake `fetch` and `META_TEST_TOKEN`.

## Verity Shell

Ports: Shell `3000`, Core `8080`, Nova `8090`. Use `127.0.0.1`, not `localhost` (they are different origins).

```bash
cp .env.example .env
# Postgres: docker compose up -d postgres   OR a local 5432 database
pnpm install
pnpm db:migrate
pnpm build
pnpm seed:dev
# prints:
#   admin@verity.local / verity-dev-admin
#   member@verity.local / verity-dev-member
#   Nova tokens (tmp/verity-dev-seed.json)

# Terminal 1 — Core
NOVA_INTERNAL_URL=http://127.0.0.1:8090 \
NOVA_INTERNAL_TOKEN=<from seed> \
META_GRAPH_BASE=http://127.0.0.1:8099 \
META_PAGE_ACCESS_TOKEN=fake-page-token \
pnpm --filter @verityos/core-api start

# Terminal 2 — Nova (dev/demo, FakeSlack, no production Slack URLs)
NOVA_DEV_MODE=1 \
CORE_API_URL=http://127.0.0.1:8080 \
NOVA_SERVICE_TOKEN=<from seed> \
NOVA_ORGANIZATION_ID=<from seed> \
NOVA_SYSTEM_ACTOR_ID=<from seed> \
NOVA_INTERNAL_TOKEN=<from seed> \
PYTHONPATH=apps/nova/src \
python3 -m uvicorn verityos_nova.app.main:create_dev_app --factory --host 127.0.0.1 --port 8090

# Terminal 3 — optional Meta Graph mock for publishing
node scripts/meta-mock.mjs

# Terminal 4 — Shell
CORE_API_URL=http://127.0.0.1:8080 pnpm --filter @verityos/shell dev
```

Open http://127.0.0.1:3000/login and sign in as `admin@verity.local` / `verity-dev-admin`. Social drafts require a second actor for approval (`member@verity.local` / `verity-dev-member`); self-approval is denied.

Government communications demo (synthetic org, not a ministry):

```bash
VERITY_PROFILE=development VERITY_DEMO_RESET=1 pnpm demo:reset
# director@verity-demo.local / communications@verity-demo.local / analyst@verity-demo.local
# See docs/demo/government-communications.md
```

`pnpm demo:reset` refuses to run unless `VERITY_PROFILE` is `demo` or `development` and `VERITY_DEMO_RESET=1`.

Mock embeddings: keep `VERITY_EMBEDDING_PROVIDER=mock`. Mock model adapter is the seeded `mock-local` row. Nova is locked to a single `NOVA_ORGANIZATION_ID` per process.

Optional Compose stack (after seed, with tokens in the environment):

```bash
docker compose --profile stack up     # development-like
VERITY_PROFILE=demo docker compose --profile demo up
```

Postgres and `VERITY_DATA_DIR` persist in volumes `verityos_pgdata` and `verityos_data`.

Health: Core/Nova/Shell expose `/health/live` and `/health/ready`. Ready checks do not return secrets.

Shell CSP allows `'unsafe-inline'` (and `'unsafe-eval'` in `next dev`) so Next.js can boot. Core API uses `default-src 'none'`. HSTS is set only when `COOKIE_SECURE=true`.

Backup: `scripts/backup.sh` / `scripts/restore.sh` — see [../operations/backup-restore.md](../operations/backup-restore.md).

Browser E2E (Playwright, Chromium):

```bash
pnpm --filter @verityos/shell exec playwright install chromium
pnpm test:e2e
```


## CSRF / Origin (V0.1)

Shell and Core share a known origin (`CORS_ORIGIN`, default `http://127.0.0.1:3000`). Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` requests must send an `Origin` in that allowlist. Bearer service-token calls skip the Origin check. SameSite=Lax cookies and CORS remain in place; this is not a general CSRF framework.

## Embeddings

CI must keep `VERITY_EMBEDDING_PROVIDER=mock` (768-dimensional hashed vectors, not semantic). On Hummingbird, point `VERITY_EMBEDDING_URL` at a local OpenAI-compatible embeddings endpoint (for example a local nomic-embed-text runtime). The V0.1 pgvector slot is `vector(768)`; changing dimension requires a migration and reindex.

Python stubs:

```bash
python3 -m pip install -e apps/nova -e apps/knowledge -e packages/sdk-python
python3 -m pip install pytest pytest-asyncio
pytest apps/nova apps/knowledge packages/sdk-python
ruff check apps/nova apps/knowledge packages/sdk-python
```

Nova (non-production) ASGI:

```bash
# Slack-backed runtime (still non-production; does not cut over Content-Loop)
uvicorn verityos_nova.app.main:create_runtime_app --factory --host 0.0.0.0 --port 8090

# Local Shell / E2E (FakeSlack, no Slack tokens)
NOVA_DEV_MODE=1 uvicorn verityos_nova.app.main:create_dev_app --factory --host 0.0.0.0 --port 8090
```

`create_runtime_app()` requires `DATABASE_URL`, `CORE_API_URL`, `NOVA_SERVICE_TOKEN`, `NOVA_ORGANIZATION_ID`, `NOVA_SYSTEM_ACTOR_ID`, `NOVA_INTERNAL_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CONTENT_CHANNEL`, and `CRON_SECRET`. `create_dev_app()` requires `NOVA_DEV_MODE=1` and the Core/Nova identity variables above, but not Slack tokens. Tests inject `MemoryStore`, `FakeSlackClient`, and a fake Core client instead.
