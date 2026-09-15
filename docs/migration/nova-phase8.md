# Nova Phase 8 migration

Source inspected: [Content-Loop](https://github.com/salutethegenius/Content-Loop) @ `ba9f5634a33bcf064561cad73966eab72a2cf896` (HANDOFF.md, README.md, schema.sql, and the listed app/core + app/routes modules).

Production Content-Loop, its Railway service, Slack request URLs, secrets, and Postgres were **not modified**. This work lives only in VerityOS.

## Slack cutover strategy (later)

Do not change the live Slack app request URLs in this phase. When cutover is explicitly authorized:

1. Dual-run VerityOS Nova against a non-production Slack app or a copied workspace.
2. Point the production Slack app Events/Interactivity/Commands URLs at VerityOS Nova.
3. Keep Content-Loop Railway process stopped but deployable so URLs can be pointed back in minutes.

## Database migration strategy (later)

`1750000000004_nova_phase8` creates empty `nova`/`social` tables. Production copy is a separate, reviewed ETL of `brands`, `content_items`, and `onboarding_sessions` plus Slack→Verity identity rows. No production Content-Loop tables are written by VerityOS.

## Known limitations

- Image generation is a hashed placeholder, not the Content-Loop SVG/design-system pipeline.
- Meta publish/schedule returns `CONNECTOR_NOT_AVAILABLE`.
- Nova persistence in tests uses an in-memory store; Postgres schemas exist for later wiring.
- Slack account linking is an admin/test `POST /internal/v1/identities` mapping, not OAuth.


## What was reused

| Source | Destination | Notes |
| --- | --- | --- |
| `slack_verify.py` HMAC + 5-minute replay | `verityos_nova.adapters.slack.verify` | Same `v0:{ts}:{body}` construction and `compare_digest` |
| Pillar rotation + platform offsets | `skills/social/generator.py` | Facebook/Instagram/LinkedIn offsets preserved |
| Brand-agnostic plug-in rule | Nova skills + adapters | Forbidden brand names are tested out of core |
| 7-phase onboarding script | `skills/social/onboarding.py` | Synthesis now calls Core, not Anthropic |
| Slack unique `action_id`s, in-place updates, private-channel events | Slack adapter | Fake Slack client in tests |
| DB-first brand + filesystem-seed concept | `social.brands` | Seeds are test fixtures (`acme`), not production folders |

## What was rewritten

- Generation path: Slack/API → Nova skill engine → Verity Core `open` / `retrieve` / `model.execute` / skill events / approval / `finalize`
- Approvals: Command `command.approvals` bound to `artifact_hash`; Slack is UX only
- Service auth: organization-scoped credential with `knowledge.read`, `models.read`, `executions.write`. Never `platform.cross_org`

## What was deferred

| Item | Status |
| --- | --- |
| Live Facebook / Meta Graph publish and schedule | Connector phase (`CONNECTOR_NOT_AVAILABLE`) |
| Design-system SVG image pipeline (cairosvg, brand templates) | Module preserved as mock placeholder |
| Production `content_items` / `brands` data copy | Separate cutover |
| Slack app request URL switch | Explicit later ops step |
| Verity Shell | Phase 9+ |
| OAuth Slack account linking | Admin/test mapping API only |

## Feature parity matrix

| Existing Nova (Content-Loop) | New Nova (VerityOS) | Status |
| --- | --- | --- |
| Interactive generation | `POST /generate/start` and `POST /internal/v1/skills/nova.social.draft/execute` | Migrated through Core |
| Cron generation | `POST /cron/generate` using system actor | Migrated; no publish |
| 7-phase onboarding | `/onboard/start` + Slack thread + Core synthesis | Migrated |
| Brand plug-ins | `social.brands` + fixture brands; core has no hardcoded names | Preserved |
| Slack HMAC + replay window | Adapter `verify_slack_signature` | Preserved |
| Private-channel `message.groups` path | `/slack/events` thread handler | Preserved |
| Approve / Reject in place | Slack UX + Core approval bound to artifact hash | Migrated |
| Image generation | Placeholder hash API | Deferred (non-blocking) |
| Facebook publish/schedule | `CONNECTOR_NOT_AVAILABLE` | Deferred to connector phase |
| Direct Anthropic calls | Forbidden; static guard test | Removed from new runtime |

## Source tables and routes

Content-Loop tables: `content_items`, `brands`, `onboarding_sessions`.

Content-Loop routes: `/`, `/generate/start`, `/cron/generate`, `/onboard/start`, `/slack/events`, `/slack/interactions`, `/slack/commands`, `/publish`, `/meta/verify`.

VerityOS tables: `nova.external_identities`, `nova.skill_runs`, `social.brands`, `social.content_items`, `social.onboarding_sessions`, plus `command.approvals.artifact_hash`.

## Environment variables (Content-Loop vs Phase 8)

| Content-Loop | Phase 8 VerityOS |
| --- | --- |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Unused by Nova. Models go through Core mock/router |
| `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `SLACK_CONTENT_CHANNEL` | Same names; tests use a fake Slack client |
| `DATABASE_URL` | Shared VerityOS Postgres (`nova` + `social` schemas) |
| `CRON_SECRET` | Same header on compatibility routes |
| `META_*` | Not used; publish fails closed |
| (new) `CORE_API_URL` / `NOVA_SERVICE_TOKEN` / `NOVA_ORGANIZATION_ID` / `NOVA_SYSTEM_ACTOR_ID` | Org-scoped Nova runtime |

## Production migration strategy (later, not this PR)

1. Keep Content-Loop live. Do not change Slack URLs.
2. Copy a snapshot of `brands` / `content_items` / `onboarding_sessions` into `social.*` on a non-production VerityOS database.
3. Map Slack users into `nova.external_identities`.
4. Provision an **organization-scoped** Nova credential (never platform/root).
5. Dual-run against the copy until parity is signed off.
6. Cut Slack request URLs in a dedicated ops window with rollback to Content-Loop URLs.

Rollback: leave Railway Nova on Content-Loop; VerityOS Nova is side-by-side until cutover. Slack URLs can be pointed back in minutes. Database copy is additive (`nova`/`social` schemas) and does not write Content-Loop tables.

## Skills

- `nova.social.draft` (approval required for the artifact)
- `nova.research` (Knowledge + governed model; strict insufficient-evidence preserved)
- `nova.drafting` (generic memo/brief/press_release/public_advisory/general)

## Core API extensions

- `POST /internal/v1/executions/:id/skill/start|complete|fail`
- `POST /internal/v1/executions/:id/approval/request`
- `POST /internal/v1/executions/:id/approval/decide`
- `GET /internal/v1/executions/:id/record`
- Service scope `executions.write`
- User permission `social.draft`
