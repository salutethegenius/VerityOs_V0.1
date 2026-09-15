# Retention and secret rotation (V0.1)

## Retention

| Class | V0.1 behavior |
| --- | --- |
| Auth sessions | 12h TTL; deleted on logout; leftover rows expire |
| Knowledge files | Kept under `VERITY_DATA_DIR` until the org is wiped by demo reset or the operator deletes the volume |
| Source versions / chunks / retrieval runs | Append-only for the org; no casual delete API |
| Execution events / ledger entries | Append-only. Do not implement arbitrary deletion. |
| Connector actions | Append-only idempotency ledger |
| Nova / social artifacts | Retained with the org |

Audit / ledger evidence must not be selectively tampered with. The **demo reset** (`pnpm demo:reset`) destroys and recreates the **synthetic demo organization only**, and only when `VERITY_PROFILE` is `demo` or `development` **and** `VERITY_DEMO_RESET=1`. It is not a production retention tool.

Resetting an existing demo org temporarily disables the Audit append-only DELETE triggers **inside that transaction** so the org can be destroyed as a unit. Triggers are re-enabled before commit. This is not an operator API for deleting evidence in sovereign/production profiles.

## Secret rotation (documentation only — do not rotate production secrets in Phase 11)

| Secret | Procedure |
| --- | --- |
| `SESSION_SECRET` | Deploy new secret; delete `auth.sessions` (or wait for TTL) so old cookies stop resolving. Current cookies are opaque hashed tokens, not signed with this secret. |
| Nova internal token | Generate a new random token; set on Core and Nova together; restart both. |
| Core service credentials | Create a new credential via the internal API; configure Nova; revoke the old row. |
| Slack signing secret / bot token | Replace in Nova runtime env; restart `create_runtime_app`. Unused by Shell `create_dev_app`. |
| Meta page token | Change env `META_PAGE_ACCESS_TOKEN` (or the configured `secret_ref`); no Core code change. Mock tokens are not production. |
| Model provider keys | Replace env; restart Core. No automatic cloud fallback. |
| Database credentials | Issue a new role, update `DATABASE_URL`, restart Core/Nova, then revoke the old role. Take a backup first. |

Never commit rotated values. Never put them in `NEXT_PUBLIC_*`.
