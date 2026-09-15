# Environment variables (V0.1)

This table is the operator reference for VerityOS V0.1. Values shown are **safe examples**, not secrets.

No secret may be exposed as `NEXT_PUBLIC_*`. Browser-safe variables are labeled. Everything else is server-only.

Profiles: `development` | `demo` | `sovereign` via `VERITY_PROFILE` (alias `VERITY_DEPLOYMENT_PROFILE`).

Mock providers are implied **only** in `development`. `demo` and `sovereign` fail fast if required values are missing. Sovereign forbids mock embeddings unless `VERITY_ALLOW_MOCK=1` is set explicitly.

| Name | Service | Required | Profiles | Secret | Safe example | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `VERITY_PROFILE` | all | demo/sovereign | all | no | `development` | Deployment profile. Invalid values abort startup. |
| `VERITY_DEPLOYMENT_PROFILE` | core | optional alias | all | no | `demo` | Accepted alias for `VERITY_PROFILE`. |
| `DATABASE_URL` | core, nova, migrate, backup | yes outside development | all | yes | `postgres://verityos:verityos@127.0.0.1:5432/verityos_audit` | Postgres 16 + pgvector. Never put this in `NEXT_PUBLIC_*`. |
| `VERITY_DATA_DIR` | core, knowledge, backup | yes outside development | all | no | `./data` | Knowledge blob root. Must be on the backup set with the database. |
| `PORT` | core | optional | all | no | `8080` | Core listen port. |
| `CORS_ORIGIN` | core, shell proxy | yes outside development | all | no | `http://127.0.0.1:3000` | Comma-separated allowed origins. Cookie-auth unsafe methods require this Origin. |
| `COOKIE_SECURE` | core, shell | optional | all | no | `false` | `true` enables Secure cookies and HSTS. Cannot be `false` when CORS uses HTTPS outside development. |
| `TRUST_PROXY` | core | optional | all | no | `false` | Trust `X-Forwarded-*` when Core sits behind a TLS proxy. |
| `SESSION_SECRET` | core | yes outside development | all | yes | *(32+ random bytes)* | Cookie plugin secret. Must not be the development default outside development. Rotating it does not by itself invalidate hashed DB sessions; log everyone out by deleting `auth.sessions`. |
| `VERITY_RATE_LIMIT` | core | optional | all | no | unset | `1` force on (including tests). `0` force off. Default: on except Vitest. In-process only. |
| `VERITY_DEMO_RESET` | core seed | demo reset | demo, development | no | `1` | Fail-safe for `pnpm demo:reset` / `seed:demo`. |
| `VERITY_EMBEDDING_PROVIDER` | core/knowledge | yes outside development | all | no | `mock` | `mock` or `openai-compatible`. Not implied in demo/sovereign. |
| `VERITY_EMBEDDING_URL` | core/knowledge | if openai-compatible | sovereign | no | `http://127.0.0.1:11434/v1/embeddings` | Local/private embeddings endpoint. |
| `VERITY_EMBEDDING_MODEL` | core/knowledge | optional | sovereign | no | `nomic-embed-text` | Embedding model name. |
| `VERITY_EMBEDDING_DIMENSIONS` | core/knowledge | optional | all | no | `768` | Must be 768 in V0.1. |
| `VERITY_EMBEDDING_API_KEY` | core/knowledge | optional | sovereign | yes | unset | Embeddings endpoint key if the local runtime requires one. |
| `VERITY_ALLOW_MOCK` | core | sovereign+mock only | sovereign | no | `1` | Explicit override to allow mock embeddings in sovereign. |
| `OPENAI_API_KEY` | core/model-router | if that provider is used | demo/sovereign | yes | unset | Cloud OpenAI. Not required for mock/local. |
| `ANTHROPIC_API_KEY` | core/model-router | if that provider is used | demo/sovereign | yes | unset | Cloud Anthropic. Not required for mock/local. |
| `OPENAI_COMPATIBLE_API_KEY` | core/model-router | optional | sovereign | yes | unset | Local OpenAI-compatible router key. |
| `AUDIT_KERNEL_VERSION` | core | optional | all | no | `0.2.0` | Reported kernel version. Hash format remains 2. |
| `AUDIT_MERKLE_INTERVAL` | audit-kernel | optional | all | no | `10` | Merkle checkpoint interval. |
| `NOVA_INTERNAL_URL` | core | for Shell/Nova | all | no | `http://127.0.0.1:8090` | Core→Nova internal base. |
| `NOVA_INTERNAL_TOKEN` | core, nova | for Nova | all | yes | unset | Shared internal bearer. |
| `CORE_API_URL` | nova, shell | yes for those services | all | no | `http://127.0.0.1:8080` | Server-side Core URL. Shell proxy uses this; it is **not** a browser secret. |
| `NOVA_SERVICE_TOKEN` | nova | yes for Nova | all | yes | unset | Org-scoped Core service credential. |
| `NOVA_ORGANIZATION_ID` | nova | yes for Nova | all | no | UUID | Nova is single-org per process in V0.1. |
| `NOVA_SYSTEM_ACTOR_ID` | nova | yes for Nova | all | no | UUID | System actor used by Nova runtime jobs. |
| `NOVA_DEV_MODE` | nova | for `create_dev_app` | development, demo | no | `1` | FakeSlack; no production Slack URLs. |
| `SLACK_BOT_TOKEN` | nova runtime | runtime app only | non-prod runtime | yes | unset | Not used by Shell demo (`create_dev_app`). |
| `SLACK_SIGNING_SECRET` | nova runtime | runtime app only | non-prod runtime | yes | unset | Slack signature verification. |
| `SLACK_CONTENT_CHANNEL` | nova runtime | runtime app only | non-prod runtime | no | `C-demo` | Channel id. |
| `CRON_SECRET` | nova runtime | runtime app only | non-prod runtime | yes | unset | Protects `/cron/generate`. |
| `META_GRAPH_BASE` | core/connectors | optional | all | no | `http://127.0.0.1:8099` | Meta Graph base. Point at the mock for demo. |
| `META_PAGE_ACCESS_TOKEN` | core/connectors | if Meta enabled | demo | yes | unset | Resolved from connector `secret_ref`. Mock accepts any non-empty token. |
| `META_API_VERSION` | connectors | optional | all | no | `v23.0` | Graph API version. |
| `META_MOCK_HOST` / `META_MOCK_PORT` | meta-mock | optional | development, demo | no | `127.0.0.1` / `8099` | Local Graph mock. Use `0.0.0.0` in Compose. |
| `DEMO_*_EMAIL` / `DEMO_*_PASSWORD` | seed-demo | optional | demo, development | yes (passwords) | `director@verity-demo.local` | Override synthetic demo users. Passwords print once during seed. |
| `NEXT_PUBLIC_VERITY_ENV` | shell | optional | all | **no — must not be a secret** | `demo` | Optional UI label only. |
| `NEXT_PUBLIC_CORE_API_URL` | shell | unused in V0.1 | — | **forbidden for secrets** | unset | Do not set. The browser talks to Shell, never to Core internals. |
| `SHELL_URL` | e2e | optional | development | no | `http://127.0.0.1:3000` | Playwright base URL. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | seed-dev | optional | development | yes (passwords) | `admin@verity.local` | Developer seed only. Not used in demo profile unless you set them. |

## Browser-safe vs server-only

- **Browser-safe:** `NEXT_PUBLIC_VERITY_ENV` (label). Session cookies are HttpOnly and are not readable by JavaScript.
- **Server-only:** everything else, including `CORE_API_URL` on the Shell server, Nova tokens, Meta tokens, model keys, and `DATABASE_URL`.

## Fail-fast rules

Core `assertStartupConfig()` aborts on invalid profile, missing `DATABASE_URL` / `CORS_ORIGIN` / `SESSION_SECRET` / `VERITY_DATA_DIR` outside development, HTTPS without Secure cookies, embedding dimensions other than 768, and mock embeddings implied in demo/sovereign.

Nova `create_runtime_app()` still requires Slack variables. `create_dev_app()` requires `NOVA_DEV_MODE=1` and Core identity variables, not Slack.

See [development.md](./development.md) for boot commands and [../operations/backup-restore.md](../operations/backup-restore.md) for backup env.
