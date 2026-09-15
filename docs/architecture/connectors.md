# Connector Gateway (Phase 9)

Phase 9 adds the governed external-action layer. Nova may propose and prepare an action. Command decides whether it is allowed and whether approval is required. Connector Gateway performs the outbound call. Nova never calls Facebook, Slack publishing APIs, email, SMS, payments, or government systems directly, and it never receives provider secrets.

```text
Nova -> Core -> Command policy -> approval -> Connector Gateway -> adapter -> external system
```

The first outbound connector is `meta.facebook`. Slack remains a Nova client/approval adapter in this phase. Production Content-Loop, Railway, and Slack request URLs are unchanged.

## Connector contract

Implementations live in `@verityos/connectors` and register by `connector_type` (not scattered `if` branches in orchestration).

```ts
interface Connector {
  id: string;
  type: string;
  version: string;
  capabilities: string[];
  health(input): Promise<ConnectorHealth>;
  execute(context, action): Promise<ConnectorActionResult>;
}
```

Each result includes `connector_id`, `connector_type`, `action`, `external_action_id`, `status`, `occurred_at`, `request_hash`, `response_hash`, and non-secret `metadata`. Future types (`slack`, `email`, `sms`, `government_web`, `database`, `payments`) are reserved in the type union and are not implemented here.

Configured connectors remain in `command.connectors`. Runtime implementations resolve through `ConnectorRegistry`.

## Secrets

Connector secrets stay outside Nova. Core resolves `secret_ref` through an environment-backed resolver (`envSecretResolver`). Encrypted storage / HSM can replace that resolver later without changing the adapter interface. Do not commit tokens. Do not return tokens in metadata, events, or API bodies.

## Command rules

`evaluateConnectorAction` answers allow/deny with machine-readable reason codes only:

| Code | Meaning |
| --- | --- |
| `CONNECTOR_ALLOWED` | Role, skill, connector, classification, and approval all pass |
| `CONNECTOR_DISABLED` | Connector missing or `enabled = false` |
| `CONNECTOR_NOT_ALLOWED_FOR_SKILL` | No `command.skill_connectors` binding for this skill/action |
| `APPROVAL_MISSING` | Required approval is absent, pending, or denied |
| `APPROVAL_ARTIFACT_MISMATCH` | Requested hash is not the approved artifact hash |
| `CLASSIFICATION_BLOCKED` | Data class is not allowed on this connector |
| `ACTOR_NOT_AUTHORIZED` | Actor/role cannot use the skill that owns the connector |

Social publishing defaults to `requires_approval = true`.

## Artifact binding

For social publishing, the Slack draft, the approved artifact, and the Meta message are the same UTF-8 bytes. Core hashes `payload.message` with SHA-256 and compares it to `artifact_hash` and to the approved approval row. Any mutation requires a new hash and a new approval.

## Idempotency and transaction boundary

PostgreSQL and Meta are not one atomic transaction. Do not pretend otherwise.

Required pattern:

1. Authorize the action (Command policy + approval + artifact bind).
2. Persist `command.connector_actions` (`authorized`, unique `(organization_id, idempotency_key)`).
3. Record `tool.requested` / `tool.authorized`.
4. Commit local intent.
5. Call the external provider.
6. Persist the returned result (`external_action_id`, hashes, status).
7. Record `tool.completed` or `tool.failed`.
8. Finalize the same Nova execution (no second execution).

Idempotency key = stable request hash of `{organization_id, execution_id, connector_id, action, artifact_hash, scheduled_for}`.

Statuses: `pending` → `authorized` → `executing` → `succeeded` | `failed` | `needs_review`.

If the remote outcome is ambiguous (timeout, 5xx, 429, non-JSON, missing id): mark `needs_review` and **do not automatically retry**. A later request with the same key returns the existing row (`replayed: true`) without a second Meta call. This preserves the Content-Loop principle that Meta may have succeeded even if the local process did not receive confirmation.

## Connector Gateway APIs

Narrow internal endpoints only. There is no generic HTTP proxy.

- `POST /internal/v1/executions/:id/connectors/actions`
- `GET /internal/v1/executions/:id/connectors/actions/:actionId`
- `POST /internal/v1/connectors/:connectorId/health`

Nova may request a known semantic action (`publish_post`, `schedule_post`) against an already-approved artifact hash.

## Meta adapter

`MetaFacebookConnector` follows Content-Loop Graph `v23.0` behavior conceptually (`/{page-id}/feed`):

- publish now: `message` + page token
- schedule: `published=false`, `scheduled_publish_time` (unix), `unpublished_content_type=SCHEDULED`, window 10 minutes–30 days
- health: `GET ?fields=name`

CI uses injected `fetch`. No production Page ID or access token is used.

Image/two-step photo publish is deferred. Text-only posts are in scope.

## Social status

`social.content_items.status` is driven by the governed action:

`pending_approval` → `approved` → `publishing` / `scheduling` → `posted` / `scheduled` / `needs_review` / `error`

- `posted` only when Connector Gateway has a `succeeded` action row
- `publishing` is not allowed before approval
- Slack after approval shows **Publish Now** / **Schedule**; success replaces status with **Published**; ambiguous outcomes show **Needs review** (never a false “failed” if Meta may have succeeded)

## Audit wording

A successful publish lets an auditor establish organization, actor, skill, brand, artifact, artifact hash, approver, connector, action, policy result, external action id, action hashes, final graph, and final ledger entry.

That proves integrity/provenance of the record. It does **not** prove the content was factually true.

Preserve display language: **Integrity Verified** / **Provenance Verified**. GET record remains `integrity_status: "not_verified"` until `POST /verify` after offline graph+ledger checks.

## Production cutover (not this phase)

Cutover still requires a separate, reviewed change: development/fake Meta credentials only here; do not copy Content-Loop rows; do not point Railway Nova or production Slack URLs at this runtime; do not use the BICCU Page token or production Page ID.
