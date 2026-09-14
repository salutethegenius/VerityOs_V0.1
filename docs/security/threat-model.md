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
