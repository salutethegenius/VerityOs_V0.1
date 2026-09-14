# Threat model (Phase 2 scope)

## In scope for the Audit Kernel

- Tampering with ledger rows (UPDATE/DELETE must be rejected; hash mismatch must fail verify)
- Chain forks under concurrent append, including the first two appends for a new organization
- Timestamp rewriting via Date/database round-trip
- Merkle proof confusion from inferred sibling order
- Cross-organization chain mixing
- Offline export that includes confidential plaintext by default (V2 export is hashes and metadata only)

## Explicitly deferred

- Authentication, RBAC, CSRF, session theft (Phase 3+)
- Cross-tenant Knowledge/Nova access
- Model-provider exfiltration policy
- Slack/Meta connector abuse
- Supply-chain / dependency scanning beyond CI install

Anonymous management APIs for organizations, Knowledge, models, users, policies, or connectors must not ship. Phase 2 exposes Kernel as a library and CLI, not a public management plane.

## Trust boundary of V0.2 offline verification

V0.2 offline verification proves **chain/internal integrity**: a verifier that holds an evidence bundle can detect modification of hashed fields, broken previous-hash links, and invalid Merkle proofs for the entries in that bundle.

V0.2 does **not** prove freshness or completeness against rollback or truncation. The organization chain head is not externally signed or anchored. An exporter who omits suffix entries, or a database restored to an earlier chain_state, can produce a bundle that still verifies internally. Signing and external anchoring are out of scope for this pass.

Execution metadata on `audit.executions` (actor, skill, risk tier, policy version, status) is **contextual** until Execution Graph V2 cryptographically commits identity, policy, Knowledge retrieval, approvals, and action evidence. Those commitments are Phase 7+ and are not implied by a sealed V2 ledger row today.
