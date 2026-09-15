import type { Pool } from "pg";
import type { DataClassification, PolicyDecision } from "@verityos/contracts";

export interface ConnectorRow {
  id: string;
  organization_id: string;
  connector_key: string;
  connector_type: string;
  version: string;
  enabled: boolean;
  allowed_data_classes_json: DataClassification[];
  secret_ref: string | null;
  page_config: Record<string, unknown>;
  capabilities: string[];
  requires_approval: boolean;
}

export interface EvaluateConnectorInput {
  organizationId: string;
  actorId: string;
  roleId: string;
  skillId: string;
  connectorKey: string;
  action: string;
  classification: DataClassification;
  approvalStatus?: string | null;
  approvalArtifactHash?: string | null;
  requestedArtifactHash: string;
}

function decision(
  value: PolicyDecision["decision"],
  reason: string,
  policy: { id: string | null; version: string | null },
  constraints: Record<string, unknown> = {}
): PolicyDecision {
  return {
    decision: value,
    reason_code: reason,
    policy_id: policy.id,
    policy_version: policy.version,
    evaluated_at: new Date().toISOString(),
    constraints,
  };
}

export async function getConnector(
  pool: Pool,
  organizationId: string,
  connectorId: string
): Promise<ConnectorRow | null> {
  const result = await pool.query<ConnectorRow>(
    `SELECT id, organization_id, connector_key, connector_type, version, enabled,
            allowed_data_classes_json, secret_ref, page_config, capabilities, requires_approval
     FROM command.connectors
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, connectorId]
  );
  return result.rows[0] ?? null;
}

export async function getConnectorByType(
  pool: Pool,
  organizationId: string,
  connectorType: string
): Promise<ConnectorRow | null> {
  const result = await pool.query<ConnectorRow>(
    `SELECT id, organization_id, connector_key, connector_type, version, enabled,
            allowed_data_classes_json, secret_ref, page_config, capabilities, requires_approval
     FROM command.connectors
     WHERE organization_id = $1 AND connector_type = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [organizationId, connectorType]
  );
  return result.rows[0] ?? null;
}

export async function evaluateConnectorAction(
  pool: Pool,
  input: EvaluateConnectorInput
): Promise<PolicyDecision> {
  const policy = await pool.query<{ id: string; version: number }>(
    `SELECT p.id, p.version
     FROM command.policy_bindings b
     JOIN command.policies p ON p.id = b.policy_id
     WHERE b.organization_id = $1 AND p.status = 'active'
     ORDER BY b.skill_id NULLS LAST
     LIMIT 1`,
    [input.organizationId]
  );
  const ref = policy.rows[0]
    ? { id: policy.rows[0].id, version: String(policy.rows[0].version) }
    : { id: null, version: null };

  const connector = await pool.query<ConnectorRow>(
    `SELECT id, organization_id, connector_key, connector_type, version, enabled,
            allowed_data_classes_json, secret_ref, page_config, capabilities, requires_approval
     FROM command.connectors
     WHERE organization_id = $1 AND connector_key = $2`,
    [input.organizationId, input.connectorKey]
  );
  const row = connector.rows[0];
  if (!row) {
    return decision("deny", "CONNECTOR_DISABLED", ref);
  }
  if (!row.enabled) {
    return decision("deny", "CONNECTOR_DISABLED", ref, { connector_id: row.id });
  }
  const allowedClasses = row.allowed_data_classes_json ?? [];
  if (!allowedClasses.includes(input.classification)) {
    return decision("deny", "CLASSIFICATION_BLOCKED", ref, { connector_id: row.id });
  }

  const binding = await pool.query<{ actions: string[] }>(
    `SELECT actions FROM command.skill_connectors
     WHERE organization_id = $1 AND skill_id = $2 AND connector_key = $3`,
    [input.organizationId, input.skillId, input.connectorKey]
  );
    const actions = Array.isArray(binding.rows[0]?.actions)
      ? binding.rows[0].actions
      : [];
  if (!binding.rows[0] || (actions.length > 0 && !actions.includes(input.action))) {
    return decision("deny", "CONNECTOR_NOT_ALLOWED_FOR_SKILL", ref, { skill_id: input.skillId });
  }

  const skillRole = await pool.query<{ id: string }>(
    `SELECT sp.id
     FROM command.skill_policies sp
     JOIN command.skill_policy_roles spr ON spr.skill_policy_id = sp.id
     WHERE sp.organization_id = $1 AND sp.skill_id = $2 AND spr.role_id = $3`,
    [input.organizationId, input.skillId, input.roleId]
  );
  if (skillRole.rows.length === 0) {
    return decision("deny", "ACTOR_NOT_AUTHORIZED", ref);
  }

  if (row.requires_approval) {
    if (!input.approvalStatus) {
      return decision("deny", "APPROVAL_MISSING", ref);
    }
    if (input.approvalStatus !== "approved") {
      return decision("deny", "APPROVAL_MISSING", ref, { approval_status: input.approvalStatus });
    }
    if (!input.approvalArtifactHash || input.approvalArtifactHash !== input.requestedArtifactHash) {
      return decision("deny", "APPROVAL_ARTIFACT_MISMATCH", ref);
    }
  }

  return decision("allow", "CONNECTOR_ALLOWED", ref, { connector_id: row.id, action: input.action });
}
