# Audit Kernel

Kernel freeze: `a18419c66002648224f3def6291b7ed2caa90997`.

V2 lives in `packages/audit-kernel`. V1 sources are kept under `src/v1` for characterization.

## V1 (prototype)

- Global chain ordered by `created_at`
- Hash = SHA-256 of concatenated fields; null previous hash becomes `""`
- Non-transactional `SELECT latest` then `INSERT`
- Merkle parent = SHA-256 of concatenated hex-decoded sibling pair; odd last node duplicated
- `verifyMerklePath` infers order by hex string comparison (`current < sibling`)
- Verify reconstructs `created_at` via `new Date(value).toISOString()`
- OpenAI execute path and dashboard are outside the hardened Kernel

## V2

### Hashing

`entry_hash = SHA256(VCHF-2(payload))`.

VCHF-2 (Verity Canonical Hash Format V2) is a restricted RFC 8785 / JCS domain, not a complete general-purpose RFC 8785 implementation. Non-integer numbers are rejected. See [hash-format-v2.md](hash-format-v2.md). This format is frozen; do not change it without incrementing `hash_format_version`.

Payload keys are always present:

- `hash_format_version` (`"2"`)
- `organization_id`
- `ledger_sequence`
- `execution_id`
- `entry_type`
- `request_hash` (JSON `null` when unavailable)
- `response_hash` (JSON `null` when unavailable)
- `execution_graph_hash` (JSON `null` when unavailable)
- `previous_entry_hash` (JSON `null` for the first org entry)
- `kernel_version`
- `created_at` (the canonical timestamp string)

Unavailable hashes are JSON `null`. Empty strings are not substitutes. Fields are never omitted.

### Canonical timestamps

`created_at` participates in the hash. The Kernel generates one UTC RFC 3339 string (millisecond precision, `Z` suffix), hashes that string, stores it in `created_at_canonical TEXT`, and stores the same instant in `created_at TIMESTAMPTZ`. Verification uses `created_at_canonical` only. It never reconstructs the hashed timestamp through `Date` or database serialization.

### Chain scope and append

Each organization has its own chain in `audit.chain_state`.

`appendLedgerEntry(pool, ...)` is the public write API. It accepts a `pg.Pool` only and always owns `BEGIN`/`COMMIT`/`ROLLBACK`. Passing a `PoolClient` is a runtime error. Callers already inside a transaction must use the explicitly named `appendLedgerEntryInTransaction(client, ...)`.

Non-null SHA-256 fields written into a V2 row (`request_hash`, `response_hash`, `execution_graph_hash`, `previous_entry_hash`, `entry_hash`, `merkle_root`) must be lowercase 64-character hex. Invalid evidence and timestamps that are not exact `Date#toISOString` UTC form are rejected before insert.

First-entry concurrency: `SELECT FOR UPDATE` does not lock a missing row. Append does:

1. `BEGIN`
2. `INSERT INTO audit.chain_state ... ON CONFLICT (organization_id) DO NOTHING`
3. `SELECT ... FOR UPDATE`
4. Compute entry from locked previous hash/sequence
5. `INSERT` ledger row
6. `UPDATE` chain_state
7. `COMMIT`

No release to the caller until commit succeeds.

### Checkpoints

An execution may have multiple ledger entries: `request_opened`, `approval_requested`, `action_completed`, `final`, `failure`. Checkpoint types that do not yet have a response or graph hash store those fields as JSON `null`.

### Merkle odd-leaf rule (duplicate-last)

If a Merkle level has an odd node count, the last node is paired with a copy of itself:

`parent = SHA256(nodeBytes || nodeBytes)`

Tree construction, proof generation, online verification, and offline verification all use this rule.

Proofs are `{ sibling_hash, position: "left" | "right" }[]`. `position` is the side the **sibling** occupies. For a duplicated last node, the proof records `sibling_hash = current` and `position = "right"`. Direction is never inferred from hex string ordering.

Parent hash is SHA-256 of the raw 32-byte digests concatenated (`leftBytes || rightBytes`), hex-encoded lowercase.

### Verification

The library and `verity-verify` CLI can verify:

- a single ledger entry against its canonical payload
- previous-hash links
- a full organization chain
- Merkle proofs and checkpoints
- an exported evidence bundle with no database access

A modified hashed field, swapped sibling, altered `created_at_canonical`, or mutated Execution Graph V2 evidence must fail verification.

V0.2 verification of an exported bundle does not prove that the chain is complete against a later head. Execution Graph V2 (`execution_graph_schema_version = "2"`) commits observable execution events into `execution_graph_hash` on the final ledger entry. That graph schema version is independent of `hash_format_version`. Older V2 rows with `execution_graph_hash = null` remain verifiable. See [execution-graph-v2.md](execution-graph-v2.md) and [threat-model.md](../security/threat-model.md).

### What the Kernel does not do

Slack, Facebook, PDF/RAG, user management, social generation, email/SMS, and model-provider SDKs are not Kernel dependencies. Phase 2 Kernel version is `0.2.0`.
