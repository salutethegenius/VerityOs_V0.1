# VerityOS migration inventory

Freeze date: 2026-09-14.

This repository (`salutethegenius/VerityOs_V0.1`) is the primary VerityOS monorepo. The name `salutethegenius/VerityOS` was unavailable. The two source systems remain intact and are not modified by this work.

## Freeze SHAs

| System | Repository | Commit | Date |
| --- | --- | --- | --- |
| Audit Kernel prototype | [VerityOS-Sovereign-Audit-Kernel](https://github.com/salutethegenius/VerityOS-Sovereign-Audit-Kernel) | `a18419c66002648224f3def6291b7ed2caa90997` | 2026-02-27 |
| Nova (Content Loop) | [Content-Loop](https://github.com/salutethegenius/Content-Loop) | `ba9f5634a33bcf064561cad73966eab72a2cf896` | 2026-09-14 |

Neither upstream repository had git tags at freeze time. This agent cannot write tags into those remotes. The SHAs above are the freeze points. Kernel source is vendored from that SHA into `packages/audit-kernel/src/v1`. Nova is **not** imported in Phase 0–2.

## Production Nova — do not touch

The live Content Loop deployment (`nova` on Railway project `verityos-agents`) must remain operational. Phase 0–2 does not change that repository, its schema, or its production environment.

## Kernel freeze map (`a18419c6`)

Reused in `packages/audit-kernel`:

- `kernel/ledger/hash.ts` — SHA-256 helpers (V1 concatenation hasher kept as characterization)
- `kernel/ledger/append.ts` — V1 non-transactional append (characterization only)
- `kernel/ledger/merkle.ts` — tree construction (odd-leaf duplicate-last already present; proof verification is incorrect)
- `kernel/execution-graph/*` — graph payload types and builder
- `verifier/cli.ts`, `verifier/verify-export.ts` — independent verification idea
- `db/migrations/1730000000000_create_audit_tables.js` — append-only trigger pattern
- Fastify, Node 20+, TypeScript strict, `node-pg-migrate`, `@noble/hashes`

Not reused as Kernel responsibilities:

- `kernel/model-contract/openai-adapter.ts` and the `openai` dependency (Phase 5)
- `api/routes/execute.ts` OpenAI execute path
- `api/rate-limiter.ts` in-memory limiter
- `api/server.ts` open CORS (`origin: true`)
- Next.js `dashboard/` (future Verity Shell, Phase 11)

## Confirmed Kernel defects (Phase 2)

- Non-transactional ledger append; concurrent requests can share `previous_entry_hash` and fork the chain.
- `SELECT ... FOR UPDATE` cannot lock a missing `chain_state` row; first-ever org append needs `INSERT ... ON CONFLICT DO NOTHING` then lock.
- V1 hash concatenates fields with no delimiters; null previous hash becomes `""`.
- `created_at` is hashed as `Date.toISOString()` then stored as `timestamp` (no TZ); verify reconstructs through `new Date(...).toISOString()`.
- Verify recomputes one entry in a 10k-row window; no full-chain walk, no stored previous-hash check, no Merkle proof check.
- Merkle `verifyMerklePath` infers left/right by hex string comparison instead of recorded direction.
- Global (not organization-scoped) chain.
- No authentication; open CORS; stub validation (`rulesApplied: ["policy-1"]`); zero automated tests; no CI.

## Nova freeze map (`ba9f5634`) — document and fixture only

See [nova-behavior.md](nova-behavior.md) and `tests/fixtures/nova/`.

Conceptual later mapping (not implemented in Phase 0–2):

- `app/core/generator.py` → `apps/nova/skills/social/`
- `app/core/onboarding.py` → `apps/nova/skills/social/onboarding/`
- `app/core/brand_loader.py` → `apps/nova/skills/social/brand_profile/`
- `app/core/slack_client.py` / `slack_verify.py` → `apps/nova/adapters/slack/`
- `app/core/meta_publisher.py` → connector implementation
- `content_items` / `brands` / `onboarding_sessions` → `social` schema

## Phase boundary

Phase 0–2 stops after Audit Kernel V2 integrity is proven. Do not begin Identity, Command, Knowledge, Nova migration, connectors, or Verity Shell.
