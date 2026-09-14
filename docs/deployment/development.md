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

Phase 0–2 does not require a local LLM. Kernel tests use no model provider.

Python stubs:

```bash
python3 -m pip install -e apps/nova -e apps/knowledge -e packages/sdk-python
pytest apps/nova apps/knowledge
ruff check apps/nova apps/knowledge packages/sdk-python
```
