# Verity Command

Command owns policies, model registry, skill policies, connectors, and approvals. Nova may propose actions; it must not bypass Command.

V0.1 ships a deny-by-default evaluator. Decisions are machine-readable:

```json
{
  "decision": "allow",
  "reason_code": "ROLE_AND_CLASSIFICATION_ALLOWED",
  "policy_id": "...",
  "policy_version": "1",
  "evaluated_at": "...",
  "constraints": {}
}
```

Connectors are schema-only in this phase (no Slack/Meta implementation). Skill `audit.export` requires approval under the default policy.
