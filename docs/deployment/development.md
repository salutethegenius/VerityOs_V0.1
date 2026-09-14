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

Phase 3–6 Core API tests use the mock model adapter. A local LLM is optional. Kernel tests still use no model provider. Enable the `vector` extension (Compose `pgvector/pgvector:pg16` already includes it).

Python stubs:

```bash
python3 -m pip install -e apps/nova -e apps/knowledge -e packages/sdk-python
pytest apps/nova apps/knowledge
ruff check apps/nova apps/knowledge packages/sdk-python
```
