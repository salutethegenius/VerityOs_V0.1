# VerityOS system model (V0.1)

VerityOS is a governed, grounded, auditable AI operating environment. Nova, Knowledge, Command, and the Audit Kernel are components of that environment, not the product itself.

## Components

```text
                    VERITY SHELL
                   Browser interface
                         |
                    VERITY CORE
              Identity / Policy / Audit
               Models / Approvals / API
          +--------------+--------------+
          |                             |
     VERITY KNOWLEDGE                  NOVA
        RAG layer                  Agent runtime
                         |
                VERITY AUDIT KERNEL
                         |
                    MODEL ROUTER
          local | private | cloud
```

Phase 0–2 implements only the Audit Kernel foundation inside this monorepo. Higher layers must not be built on a ledger whose correctness has not been proven.

## Non-negotiable rules

1. Audit is in the execution path. Meaningful AI work is not generated first and logged afterward.
2. The Kernel stays small. Slack, Facebook, RAG, user management, and brand logic stay outside it.
3. Nova does not bypass Command.
4. Verity Knowledge is native (not Open WebUI as source of truth).
5. Cloud model providers are adapters, not architectural dependencies.
6. V0.1 stack stays portable: Postgres, filesystem blobs, no Kafka/K8s/Redis cluster.

## Current phase boundary

**In scope:** freeze inventory, monorepo skeleton, Audit Kernel V2 (organization chains, transactional append, canonical hashing, Merkle proofs with explicit direction, checkpoints, offline verifier).

**Out of scope until a later prompt:** Identity/RBAC, Command policies, Model Router V2, Knowledge, Nova runtime migration, connectors, Verity Shell, Hummingbird image.
