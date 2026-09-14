# Threat model (Phase 3–6 scope)

## In scope for the Audit Kernel

- Tampering with ledger rows (UPDATE/DELETE must be rejected; hash mismatch must fail verify)
- Chain forks under concurrent append, including the first two appends for a new organization
- Timestamp rewriting via Date/database round-trip
- Merkle proof confusion from inferred sibling order
- Cross-organization chain mixing
- Offline export that includes confidential plaintext by default (V2 export is hashes and metadata only)

## In scope for identity, Command, models, and Knowledge

- Cross-organization isolation of users, roles, models, policies, collections, sources, retrieval runs, and audit exports
- Forged `organization_id` / `actor_id` on client or internal retrieve requests
- Unauthenticated management APIs
- Invalid service credentials
- Classification leaving the device / cloud model use
- Knowledge ACL and unapproved versions in strict mode

## Explicitly deferred

- OIDC/SAML, CSRF tokens beyond SameSite cookies, session fixation beyond hashed tokens
- Connector (Slack/Meta) implementation and abuse
- Execution Graph V2 cryptographic commitment of identity/policy/retrieval
- Supply-chain / dependency scanning beyond CI install
- Signing and external chain anchoring

Anonymous management APIs for organizations, Knowledge, models, users, policies, or connectors must not ship. External clients talk to Core API; Knowledge retrieve is internal-or-session, never a public unauthenticated surface.

## Trust boundary of V0.2 offline verification

V0.2 offline verification proves **chain/internal integrity**: a verifier that holds an evidence bundle can detect modification of hashed fields, broken previous-hash links, and invalid Merkle proofs for the entries in that bundle.

V0.2 does **not** prove freshness or completeness against rollback or truncation. The organization chain head is not externally signed or anchored. An exporter who omits suffix entries, or a database restored to an earlier chain_state, can produce a bundle that still verifies internally. Signing and external anchoring are out of scope for this pass.

Execution metadata on `audit.executions` (actor, skill, risk tier, policy version, status) is **contextual** until Execution Graph V2 cryptographically commits identity, policy, Knowledge retrieval, approvals, and action evidence. Those commitments are Phase 7+ and are not implied by a sealed V2 ledger row today.
