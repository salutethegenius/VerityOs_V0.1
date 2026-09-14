# Nova (Content Loop) behavior freeze

Source: [Content-Loop](https://github.com/salutethegenius/Content-Loop) @ `ba9f5634` (2026-09-14).

This document records production behavior so VerityOS can reach feature parity later. It is not a license to modify the live system.

## Product rule

Brands are plug-ins. Nothing in `app/core/` or `app/routes/` references a brand name directly. Adding a brand means a folder under `app/brands/{id}/` (`config.json` + `voice.md`) and/or a row in `brands`.

## Runtime

- FastAPI on Railway
- Railway Postgres (`schema.sql`)
- Claude (`ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL`, default `claude-sonnet-4-6`)
- Slack control surface with HMAC verification
- Meta Graph API Facebook publish/schedule

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/` | none | health |
| POST | `/generate/start` | `X-Cron-Secret` | interactive Slack brand/platform picker then generate |
| POST | `/cron/generate` | `X-Cron-Secret` | scheduled drafts for due active brand/platform pairs |
| POST | `/onboard/start` | `X-Cron-Secret` | start 7-phase Slack onboarding thread |
| POST | `/slack/events` | Slack HMAC | Events API; private channels need `message.groups` |
| POST | `/slack/interactions` | Slack HMAC | Approve/Reject, Publish/Schedule, onboarding, generation |
| POST | `/slack/commands` | Slack HMAC | `/nova` slash command |
| POST | `/publish` | `X-Cron-Secret` | publish or schedule an approved item |
| GET | `/meta/verify` | `X-Cron-Secret` | token/page check |

## Slack security (must preserve)

- HMAC-SHA256 over `v0:{timestamp}:{body}` using `SLACK_SIGNING_SECRET`
- Replay window: 5 minutes (`REPLAY_TOLERANCE_SECONDS = 300`)
- Compare with `hmac.compare_digest`
- Every button in a message needs a unique `action_id` (Slack rejects duplicate ids)
- Private channel `nova-agent` requires `groups:history`, `groups:read`, and `message.groups`

## Onboarding

Seven phases: identity → voice → content territory → compliance → platform behavior → cadence → visual identity. Human replies in-thread, types `next` to advance. Claude synthesizes `voice.md` + `config.json`. Approve persists to `brands` and the brand is live without a git commit.

## Content status machine

`content_items.status` includes:

- `pending_approval`
- `approved` / `rejected`
- `publishing` / `scheduling` (atomic claim via `claimed_at`)
- `posted`
- `needs_review` (stale claim recovery; no automatic Meta retry)
- `error` (orphan drafts parked rather than blocking cadence)

Approved Facebook drafts get Publish now / Schedule / optional Generate image. Non-Facebook platforms are posted manually.

## Publishing constraints

- Per-brand `meta_page_id` + `meta_token_env`; no silent fallback to another brand's page
- Meta scheduled posts: roughly 10 minutes to 30 days
- Image posts schedule via two-step upload then `/feed` with `attached_media` so Meta Planner sees them
- Design templates exist only for some brands; others are text-only with a friendly no-template Slack message

## Tables

- `content_items` — drafts, approval, Meta ids, image provenance, claim timestamp
- `brands` — `brand_id`, `config` JSONB, `voice_md`; DB overrides filesystem seeds
- `onboarding_sessions` — one row per brand being onboarded; keyed by Slack `thread_ts`

## Later VerityOS mapping

Do not perform production schema migration until social behavior is proven against a copy of current data. Target schema: `social`. Slack becomes a Nova client adapter. Facebook becomes a connector. Nova must not call Meta directly once the connector gateway exists (Phase 10).
