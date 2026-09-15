# Changelog

## 0.1.0-rc1

Release candidate for VerityOS V0.1 (Phase 11 hardening). Pilot system, not a certified government product.

### Product surface (Phases 0–10)

- Audit Kernel V2 and Execution Graph V2 with frozen hash semantics
- Identity, Command/RBAC, Knowledge, Model Router
- Nova on the governed execution lifecycle (non-production; Content-Loop untouched)
- Connector Gateway with mock Meta publishing and idempotency
- Verity Shell (browser → Shell → Core)

### Phase 11

- Deployment profiles: development, demo, sovereign (fail-fast configuration)
- Health/readiness, request IDs, security headers, structured redacted logs
- Conservative in-process rate limiting and login abuse protections
- Postgres + Knowledge file backup/restore with SHA-256 manifests
- Synthetic government communications demo, reset, and preflight
- Secret scanning and dependency-scan policy
- Tenant/permission regression coverage and government Playwright scenario

### Not in this candidate

Hummingbird packaging, chain-head signing, additional connectors, OIDC/SAML, production cutover.
