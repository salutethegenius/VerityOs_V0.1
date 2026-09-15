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

Phase 3–9 implements identity, Command policy, Model Router V2, native Verity Knowledge, Execution Graph V2, the Nova operator runtime, and Connector Gateway (Meta publishing) on top of the frozen Audit Kernel. The Kernel is a dependency and trust boundary; Hash Format V2 is not modified.

## Non-negotiable rules

1. Audit is in the execution path. Meaningful AI work is not generated first and logged afterward.
2. The Kernel stays small. Slack, Facebook, RAG, user management, and brand logic stay outside it.
3. Nova does not bypass Command.
4. Verity Knowledge is native (not Open WebUI as source of truth).
5. Cloud model providers are adapters, not architectural dependencies.
6. V0.1 stack stays portable: Postgres, filesystem blobs, no Kafka/K8s/Redis cluster.

## Current phase boundary

**In scope through Phase 9:** Nova skill contract (`nova.social.draft`, `nova.research`, `nova.drafting`), organization-scoped Core client, Slack adapter, Command-bound artifact approval, Connector Gateway, and mock-tested `meta.facebook` publish/schedule. Hash Format V2 and Execution Graph V2 hashing are unchanged.

**Out of scope until a later prompt:** Verity Shell UI, production Content-Loop cutover, email/SMS/payment/database connectors, Hummingbird packaging, signing/external anchoring, OIDC/SAML.

See [execution-graph-v2.md](execution-graph-v2.md).
