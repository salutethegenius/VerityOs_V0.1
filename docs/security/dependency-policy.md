# Dependency security policy (V0.1)

## Tools

- Node: `pnpm audit` via `node scripts/dependency-scan.mjs`
- Python: `pip-audit` when installed (`python3 -m pip_audit`)
- Secrets: `node scripts/secret-scan.mjs` (plus `--self-test` against `tests/security/secret-scan-fixture.txt`)

CI runs the secret scan on every TypeScript job. Dependency scan runs in the security job and as part of `pnpm release:check`.

## Release gate

Known **critical** or **high** vulnerabilities in **production** dependencies block V0.1 release unless this file (or `docs/releases/v0.1-rc1.md`) records:

- package and advisory id
- why it is not exploitable in this deployment
- owner and follow-up

Development-only noise (for example a Vitest transitive advisory that cannot reach Core) must be triaged, not blindly used to fail every CI push. `RELEASE_ALLOW_DEP_FINDINGS=1` is an explicit override for `release:check`, not a silent skip.

## Out of scope for V0.1

OS-level image scanning of Hummingbird, full OSV monorepo daemon, and automatic `pnpm audit --fix`.
