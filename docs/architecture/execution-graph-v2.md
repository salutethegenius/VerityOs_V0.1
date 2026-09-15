# Execution Graph V2

Phase 7 execution contract. Hash Format V2 (`hash_format_version = "2"`, VCHF-2) is unchanged. Graph hashing uses a separate identifier:

`execution_graph_schema_version: "2"`

Changing future graph structure must increment the graph schema version. It must not imply a VCHF change.

## Unified lifecycle

One user task has one `execution_id`, one `verity_record_id`, one ordered execution event history, one derived Execution Graph V2, and one final `execution_graph_hash`.

```text
REQUEST
  -> IDENTITY
  -> AUTHORIZATION
  -> RISK CLASSIFICATION
  -> KNOWLEDGE RETRIEVAL
  -> MODEL ROUTING
  -> MODEL EXECUTION
  -> VALIDATION
  -> APPROVAL when required
  -> ACTION / RELEASE
  -> FINAL AUDIT SEAL
```

Subsystems (Knowledge retrieve, model routing, model execution) reuse the open execution. They must not open a new execution merely because they performed work. Standalone public operations that are not part of a larger execution open a short-lived execution, perform the action, finalize it, and return `verity_record_id`.

## Event store

`audit.execution_events` is append-only (UPDATE/DELETE rejected). Sequence allocation locks the execution row. Composite `(organization_id, execution_id)` prevents cross-tenant event attachment.

Event families (contract names; later phases must not invent incompatible names):

- `execution.created`
- `identity.authenticated`
- `authorization.started` / `authorization.allowed` / `authorization.denied`
- `risk.classified`
- `knowledge.retrieval.started` / `knowledge.retrieval.completed` / `knowledge.retrieval.insufficient`
- `model.routing.started` / `model.selected` / `model.routing.failed`
- `model.execution.started` / `model.execution.completed` / `model.execution.failed`
- `nova.skill.started` / `nova.skill.completed` / `nova.skill.failed`
- `validation.started` / `validation.passed` / `validation.failed`
- `approval.requested` / `approval.approved` / `approval.rejected` / `approval.expired`
- `tool.requested` / `tool.authorized` / `tool.denied` / `tool.completed` / `tool.failed`
- `release.started` / `release.completed` / `release.blocked`
- `execution.failed` / `execution.blocked` / `execution.completed`
- `audit.checkpoint.sealed`

Events record observable system behavior only: policy IDs, reason codes, role IDs, retrieval/source/chunk IDs, model/provider/deployment, prompt/output hashes, tool names, approval decisions, integer latency, token usage, artifact hashes, status, timestamps.

Forbidden: hidden reasoning, chain-of-thought, private model reasoning tokens, document plaintext, prompts, secrets.

## Graph

```json
{
  "schema_version": "2",
  "execution_id": "...",
  "verity_record_id": "...",
  "organization_id": "...",
  "status": "...",
  "nodes": [],
  "edges": []
}
```

Nodes are ordered by `event_sequence`. Edges derive from `parent_event_ids`. `execution_graph_hash = SHA256(VCHF-2({ execution_graph_schema_version: "2", graph }))`. Reconstruction from the same immutable event set is deterministic.

## Execution state machine

```text
created -> running | blocked | failed | cancelled
running -> waiting_approval | completed | blocked | failed | cancelled
waiting_approval -> running | completed | blocked | failed | cancelled
completed | failed | blocked | cancelled -> (none)
```

Same-status writes are allowed. Invalid transitions fail. Every user-facing read is organization-scoped (`getExecution(pool, organizationId, executionId)`). There is no public `getExecution(id)` path.

## Finalization

`sealExecution` runs in one database transaction:

1. Append validation / terminal / release events (prelude)
2. Append `audit.checkpoint.sealed`
3. Canonicalize Graph V2 and compute `execution_graph_hash`
4. `appendLedgerEntryInTransaction` with a non-null `execution_graph_hash`
5. Update execution `final_entry_id` / status / `completed_at`
6. COMMIT

If ledger append or an injected failure occurs before commit, the execution must not become completed and release must not occur. Older V2 ledger rows with `execution_graph_hash = null` remain readable and verifiable under existing Hash Format V2 semantics.

## APIs

Internal (service credential, org-scoped):

- `POST /internal/v1/executions`
- `POST /internal/v1/executions/:executionId/knowledge/retrieve`
- `POST /internal/v1/executions/:executionId/model/execute`
- `POST /internal/v1/executions/:executionId/finalize`

Authenticated organization-scoped Verity Record:

- `GET /v1/audit/records`
- `GET /v1/audit/records/:verityRecordId`
- `GET /v1/audit/records/:verityRecordId/graph`
- `POST /v1/audit/records/:verityRecordId/verify`

Record GET responses use `integrity_status: "not_verified"` and `provenance_status: "linked" | "unlinked" | "absent"`. A graph merely existing is not provenance. `linked` means the reconstructed graph hash matches the final ledger `execution_graph_hash`.

`POST /v1/audit/records/:id/verify` returns `integrity_verified` / `provenance_verified` only after offline bundle verification succeeds. Provenance is verified only when that check passes and the graph is cryptographically linked to the final ledger entry. Do not claim factual truth.

Final/failure ledger rows reuse `request_opened.request_hash`. `response_hash` is the hash of the released response/artifact, or JSON `null`. It is never `SHA256(execution_graph_hash)` and `request_hash` is never `SHA256(execution_id)`.

## Service credentials

Organization-less service credentials are **platform/root** credentials. With `platform.cross_org` they can address executions across organizations. Nova in Phase 8 must use an **organization-scoped** service credential, not a platform credential.

## Event append API

`appendExecutionEvent(pool, ...)` accepts a `pg.Pool` only and owns BEGIN/COMMIT/ROLLBACK. Callers already inside a transaction must use `appendExecutionEventInTransaction(client, ...)`.

Parent `parent_event_ids` must exist in the same organization and execution, with a lower `event_sequence`. Duplicates are normalized by unique sort. Graph reconstruction does not silently drop unresolved parents.

Knowledge retrieve inside an execution loads organization and actor from the execution. `knowledge.retrieval_runs.execution_id` equals the unified execution ID. `included_in_context` stays false until Core constructs the governed model prompt from verified `returned_to_caller` chunks of the supplied `retrieval_run_id`.

Strict Knowledge with `insufficient_evidence = true` must not execute the model as though institutional grounding exists.
