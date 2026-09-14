# V1 characterization sources

Vendored from `salutethegenius/VerityOS-Sovereign-Audit-Kernel` commit
`a18419c66002648224f3def6291b7ed2caa90997` (2026-02-27).

These modules exist so tests can pin prototype behavior (concatenation hashing,
non-transactional append, hex-order Merkle verification). They are not used for
new ledger writes. V2 is `src/hashing`, `src/ledger`, `src/merkle`, and `src/verify`.
