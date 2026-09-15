# Verity Shell (Phase 10)

Browser → Shell (Next.js) → Core session APIs → governed internal services.

The browser never calls Nova internal APIs, Connector Gateway internal APIs, or PostgreSQL.

## Existing Core session APIs reused

Login/logout/`GET /v1/auth/me`, users, roles, policies, models, knowledge collections/upload/approve/index/reindex, audit records/graph/verify/export.

## Added session APIs (only gaps)

| Route | Why |
| --- | --- |
| `GET /v1/me` | Profile (email, display name, org) |
| `GET /v1/home/summary` | Home fan-out |
| `GET /v1/nova/skills` | Operator skill catalog |
| `POST /v1/nova/skills/:skillId/execute` | Core → Nova internal token |
| `GET /v1/nova/runs` / `:executionId` | Recent Nova executions |
| `POST /v1/nova/runs/:id/approvals/:approvalId/decide` | Session approval with artifact hash |
| `POST /v1/nova/runs/:id/publish` | Core → Nova publish/schedule |
| `GET /v1/approvals` | Command queue |
| `GET /v1/command/skills` | Skill policies |
| `GET /v1/connectors` | Configured connectors (no secrets) |
| `POST /v1/connectors/:id/health` | Session health |
| `POST /v1/executions/:id/connectors/actions` | Session connector action |
| `GET /v1/knowledge/collections/:id` | Collection + sources |
| `GET /v1/social/brands` | Social brands |
| `GET /v1/system/status` | Safe runtime facts |

Actor and organization are always derived from the session cookie.

The Shell Next.js server proxies `/v1/*` to Core (`CORE_API_URL`). The browser does not call Core, Nova, or Connector Gateway directly. `NOVA_INTERNAL_TOKEN` never leaves Core.

When Nova is unreachable, `GET /v1/nova/skills` returns the implemented skill catalog from Command (`nova.research`, `nova.drafting`, `nova.social.draft`) with `source: "command"`.

## Shell

Next.js 15 App Router, React 19, TypeScript strict, Tailwind CSS variables. Optional `NEXT_PUBLIC_CORE_API_URL` is unused by default (relative `/v1` via the proxy). No `NEXT_PUBLIC_*` secrets.

Dev login after `pnpm seed:dev`: `admin@verity.local` / `verity-dev-admin`. Member (for social approval): `member@verity.local` / `verity-dev-member`. Approval status in the database is `pending` | `approved` | `denied` (the Shell rejected filter reads `denied`). There is no `expired` row status in V0.1.
