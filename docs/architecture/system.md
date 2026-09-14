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

Phase 3–6 implements identity, Command policy, Model Router V2, and native Verity Knowledge on top of the frozen Audit Kernel. The Kernel is a dependency and trust boundary; Hash Format V2 is not modified.

## Non-negotiable rules

1. Audit is in the execution path. Meaningful AI work is not generated first and logged afterward.
2. The Kernel stays small. Slack, Facebook, RAG, user management, and brand logic stay outside it.
3. Nova does not bypass Command.
4. Verity Knowledge is native (not Open WebUI as source of truth).
5. Cloud model providers are adapters, not architectural dependencies.
6. V0.1 stack stays portable: Postgres, filesystem blobs, no Kafka/K8s/Redis cluster.

## Current phase boundary

**In scope:** identity and organization isolation, Command policy evaluation, Model Router V2 (mock + HTTP adapters), native Verity Knowledge (hybrid retrieval, versioned sources).

**Out of scope until a later prompt:** Nova runtime migration, connectors, Verity Shell UI, Execution Graph V2, signing/external anchoring, OIDC/SAML.
