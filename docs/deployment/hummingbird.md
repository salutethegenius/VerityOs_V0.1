# Hummingbird (sovereign)

Preferred hardware: ARM64, about 16 GB RAM, local NVMe, LAN, offline-first.

Phase 0–2 does not optimize for Hummingbird, but it also does not introduce x86-only Kernel dependencies. The ledger, verifier, and Postgres schema must run on ARM64 later without a rewrite.

Do not require internet for Kernel verification of an exported evidence bundle.
