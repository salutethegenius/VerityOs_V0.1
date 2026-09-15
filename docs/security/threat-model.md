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
- Composite database foreign keys so organization-owned relationships cannot cross organizations
- Forged `organization_id` / `actor_id` on client or internal retrieve requests
- Unauthenticated management APIs
- Invalid, revoked, or org-escaping service credentials
- Classification leaving the device / cloud model use
- Knowledge collection ACL (including same-org roles with global `knowledge.read` but no `can_read`)
- Unapproved source versions in strict, grounded, and general retrieval
- Session-authenticated CSRF via disallowed or missing `Origin` on POST/PUT/PATCH/DELETE
- Cross-organization Execution Graph V2 / Verity Record reads, verifies, exports, and event attachment
- Silent embedding-provider mismatch during index (must return `REINDEX_REQUIRED` or use explicit reindex)

## Explicitly deferred

- OIDC/SAML and a general-purpose CSRF token framework (V0.1 uses a strict allowed-Origin check plus SameSite cookies)
- Session fixation beyond hashed tokens
- Connector (Slack/Meta) implementation and abuse
- Supply-chain / dependency scanning beyond CI install
- Signing and external chain anchoring
- OCR and unapproved-version preview as a management capability
- Nova runtime migration and Verity Shell UI

Anonymous management APIs for organizations, Knowledge, models, users, policies, or connectors must not ship. External clients talk to Core API; Knowledge retrieve is internal-or-session, never a public unauthenticated surface.

## Trust boundary of V0.2 offline verification

V0.2 offline verification proves **chain/internal integrity**: a verifier that holds an evidence bundle can detect modification of hashed fields, broken previous-hash links, and invalid Merkle proofs for the entries in that bundle.

When Execution Graph V2 events are present, verification also reconstructs the graph, recomputes `execution_graph_hash`, and compares it to the exported graph and to a non-null ledger `execution_graph_hash`. Older V2 rows with `execution_graph_hash = null` remain valid under Hash Format V2. Graph schema version `"2"` is not `hash_format_version`.

V0.2 does **not** prove freshness or completeness against rollback or truncation. The organization chain head is not externally signed or anchored. An exporter who omits suffix entries, or a database restored to an earlier chain_state, can produce a bundle that still verifies internally. Signing and external anchoring are out of scope for this pass.

Integrity language: GET record returns `integrity_status: "not_verified"` and `provenance_status: "linked" | "unlinked" | "absent"`. `POST /verify` returns `integrity_verified` / `provenance_verified` only after the ledger chain and Graph V2 evidence verify. Offline verification does not claim factual truth.

## Platform service credentials

Organization-less service credentials are platform/root credentials. They may perform cross-organization execution access when they hold `platform.cross_org`. This is intentional bootstrap authority, not tenant isolation. Phase 8 Nova must authenticate with an organization-scoped service credential.
