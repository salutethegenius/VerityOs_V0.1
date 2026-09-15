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

Connectors are configured in `command.connectors` and bound to skills in `command.skill_connectors`. External calls go through Connector Gateway (`evaluateConnectorAction`); see [connectors.md](connectors.md). Social publishing requires approval by default (`requires_approval = true`). Skill `audit.export` also requires approval under the default policy.

Connector reason codes: `CONNECTOR_ALLOWED`, `CONNECTOR_DISABLED`, `CONNECTOR_NOT_ALLOWED_FOR_SKILL`, `APPROVAL_MISSING`, `APPROVAL_ARTIFACT_MISMATCH`, `CLASSIFICATION_BLOCKED`, `ACTOR_NOT_AUTHORIZED`.
