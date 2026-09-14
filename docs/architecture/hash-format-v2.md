# Verity Canonical Hash Format V2

`hash_format_version` value: `"2"`.

This format is **frozen**. Changing canonicalization, field set, null policy, or timestamp representation requires a new `hash_format_version`.

## What V2 is

```text
entry_hash = SHA-256( VCHF-2(payload) )
```

VCHF-2 is a **restricted JSON Canonicalization Scheme domain**. It follows RFC 8785 / JCS rules for the values VerityOS actually hashes. It is **not** a complete general-purpose RFC 8785 implementation: non-integer numbers are rejected so hash input cannot depend on floating-point serialization.

## Payload

Every V2 ledger payload includes exactly these keys (never omitted):

| Key | JSON type | Notes |
| --- | --- | --- |
| `hash_format_version` | string | Always `"2"` |
| `organization_id` | string | UUID |
| `ledger_sequence` | integer | Organization-scoped, starting at 1 |
| `execution_id` | string | UUID |
| `entry_type` | string | `request_opened`, `approval_requested`, `action_completed`, `final`, `failure` |
| `request_hash` | string or null | SHA-256 hex, or JSON `null` |
| `response_hash` | string or null | SHA-256 hex, or JSON `null` |
| `execution_graph_hash` | string or null | SHA-256 hex, or JSON `null` |
| `previous_entry_hash` | string or null | SHA-256 hex, or JSON `null` on the first org entry |
| `kernel_version` | string | e.g. `0.2.0` |
| `created_at` | string | Canonical UTC timestamp (below) |

Unavailable hashes are JSON `null`. Empty strings are not substitutes.

## Canonical UTC timestamp

`created_at` in the payload is the exact string stored as `created_at_canonical`.

Required form (ES2022 `Date.prototype.toISOString`):

```text
YYYY-MM-DDTHH:mm:ss.sssZ
```

- UTC only
- always three millisecond digits
- always the `Z` suffix
- never `+00:00`, never a space separator, never reconstructed through `Date` or Postgres at verify time

## SHA-256 evidence fields

Any non-null SHA-256 field written into a V2 ledger row (`request_hash`, `response_hash`, `execution_graph_hash`, `previous_entry_hash`, `entry_hash`, `merkle_root`) must match:

```text
^[0-9a-f]{64}$
```

Uppercase hex, truncated hex, and placeholder strings are rejected before append.

## VCHF-2 value domain

Accepted: `null`, booleans, finite safe integers (`Number.isSafeInteger`), strings, arrays of domain values, objects of domain values.

Rejected: `NaN`, `Infinity`, floats, non-safe integers, `undefined`, bigint, functions.

Object keys are sorted by UTF-16 code unit order. There is no insignificant whitespace.

## RFC 8785 / JCS coverage

In-domain official vectors (tested):

- RFC 8785 §3.2.2 literals `null`, `true`, `false`
- RFC 8785 §3.2.3 UTF-16 property-name sort order (Euro / CR / Hebrew / `1` / emoji / control / ö)
- RFC 8785 Appendix B integer samples `0`, minus zero (`-0` → `0`), and the maximum safe integer `9007199254740991`

Out of domain (rejected; must not be used to hash ledger entries):

- RFC 8785 §3.2.2 sample object `numbers` array (floats and scientific notation)
- RFC 8785 Appendix B floats, `NaN`, `Infinity`, and `9007199254740992` (`2^53`, "Max pos int")

V2 ledger payloads only use this domain: JSON objects and arrays of strings, JSON `null`, booleans, and small integers (`ledger_sequence`). Changing serialization of those values requires a new `hash_format_version`.

## Frozen V2 ledger payload vector

```text
request_hash = SHA-256("aa")
             = 961b6dd3ede3cb8ecbaacbd68de040cd78eb2ed5889130cceb4c49268ea4d506

VCHF-2(payload) =
{"created_at":"2026-09-14T20:00:00.000Z","entry_type":"request_opened","execution_graph_hash":null,"execution_id":"33333333-3333-3333-3333-333333333333","hash_format_version":"2","kernel_version":"0.2.0","ledger_sequence":1,"organization_id":"22222222-2222-2222-2222-222222222222","previous_entry_hash":null,"request_hash":"961b6dd3ede3cb8ecbaacbd68de040cd78eb2ed5889130cceb4c49268ea4d506","response_hash":null}

entry_hash = SHA-256(VCHF-2(payload))
           = dd865a13890abb157cfce6a25db436eff5dfb0e21098e1ee2cd31a3e7fb2ac9f
```

## Compatibility

V1 concatenation hashing remains in `packages/audit-kernel/src/v1` for characterization only. V1 and V2 hashes are not interchangeable.
