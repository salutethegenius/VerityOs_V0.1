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

Phase 3–8 Core API tests use the mock model adapter and `MockEmbeddingProvider` (`VERITY_EMBEDDING_PROVIDER=mock`). Nova talks to Core; it does not call Anthropic or OpenAI.

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
