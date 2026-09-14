import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  CLASSIFICATION_RANK,
  RISK_RANK,
  type DataClassification,
  type PolicyDecision,
  type RiskTier,
} from "@verityos/contracts";

export interface PolicyRules {
  leave_device: Record<DataClassification, boolean>;
  cloud_models: Record<DataClassification, boolean>;
}

export const DEFAULT_POLICY_RULES: PolicyRules = {
  leave_device: {
    public: true,
    internal: true,
    confidential: false,
    restricted: false,
  },
  cloud_models: {
    public: true,
    internal: true,
    confidential: false,
    restricted: false,
  },
};

export type PolicyAction =
  | {
      type: "skill.use";
      skillId: string;
      classification: DataClassification;
      riskTier: RiskTier;
    }
  | {
      type: "knowledge.read";
      classification: DataClassification;
    }
  | {
      type: "model.process";
      classification: DataClassification;
      deploymentType: "local" | "private" | "cloud";
      modelRiskCeiling: RiskTier;
      requestedRisk: RiskTier;
    }
  | {
      type: "data.leave_device";
      classification: DataClassification;
    }
  | {
      type: "connector.use";
      connectorKey: string;
      classification: DataClassification;
    }
  | {
      type: "approval.decide";
      approvalId: string;
    };

export interface EvaluateInput {
  organizationId: string;
  actorId: string;
  roleId: string;
  action: PolicyAction;
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

export async function seedDefaultCommand(
  pool: Pool,
  input: { organizationId: string; adminRoleId: string; memberRoleId: string }
): Promise<{ policyId: string }> {
  const policyId = randomUUID();
  await pool.query(
    `INSERT INTO command.policies (id, organization_id, name, version, status, rules)
     VALUES ($1, $2, 'default', 1, 'active', $3::jsonb)`,
    [policyId, input.organizationId, JSON.stringify(DEFAULT_POLICY_RULES)]
  );
  await pool.query(
    `INSERT INTO command.policy_bindings (id, organization_id, policy_id, skill_id)
     VALUES ($1, $2, $3, NULL)`,
    [randomUUID(), input.organizationId, policyId]
  );

  const skills: Array<{
    skillId: string;
    approval: boolean;
    classification: DataClassification;
    risk: RiskTier;
    roles: string[];
  }> = [
    {
      skillId: "knowledge.retrieve",
      approval: false,
      classification: "restricted",
      risk: "high",
      roles: [input.adminRoleId, input.memberRoleId],
    },
    {
      skillId: "knowledge.manage",
      approval: false,
      classification: "restricted",
      risk: "high",
      roles: [input.adminRoleId],
    },
    {
      skillId: "nova.use",
      approval: false,
      classification: "internal",
      risk: "medium",
      roles: [input.adminRoleId, input.memberRoleId],
    },
    {
      skillId: "models.route",
      approval: false,
      classification: "restricted",
      risk: "high",
      roles: [input.adminRoleId, input.memberRoleId],
    },
    {
      skillId: "audit.export",
      approval: true,
      classification: "restricted",
      risk: "high",
      roles: [input.adminRoleId],
    },
    {
      skillId: "approvals.decide",
      approval: false,
      classification: "restricted",
      risk: "high",
      roles: [input.adminRoleId],
    },
  ];

  for (const skill of skills) {
    const skillPolicyId = randomUUID();
    await pool.query(
      `INSERT INTO command.skill_policies (
         id, organization_id, skill_id, requires_approval, classification_ceiling, risk_ceiling
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        skillPolicyId,
        input.organizationId,
        skill.skillId,
        skill.approval,
        skill.classification,
        skill.risk,
      ]
    );
    for (const roleId of skill.roles) {
      await pool.query(
        `INSERT INTO command.skill_policy_roles (skill_policy_id, role_id, organization_id)
         VALUES ($1, $2, $3)`,
        [skillPolicyId, roleId, input.organizationId]
      );
    }
  }

  await pool.query(
    `INSERT INTO command.models (
       id, organization_id, model_key, provider, deployment_type, endpoint,
       capabilities_json, allowed_data_classes_json, risk_ceiling, requires_internet, enabled
     ) VALUES (
       $1, $2, 'mock-local', 'mock', 'local', NULL,
       '["chat","retrieve"]'::jsonb,
       '["public","internal","confidential","restricted"]'::jsonb,
       'high', false, true
     )`,
    [randomUUID(), input.organizationId]
  );

  return { policyId };
}

async function loadActivePolicy(pool: Pool, organizationId: string, skillId?: string) {
  const bound = await pool.query<{
    id: string;
    version: number;
    rules: PolicyRules;
  }>(
    `SELECT p.id, p.version, p.rules
     FROM command.policy_bindings b
     JOIN command.policies p ON p.id = b.policy_id
     WHERE b.organization_id = $1
       AND p.status = 'active'
       AND (b.skill_id = $2 OR b.skill_id IS NULL)
     ORDER BY b.skill_id NULLS LAST
     LIMIT 1`,
    [organizationId, skillId ?? null]
  );
  return bound.rows[0] ?? null;
}

export async function evaluatePolicy(pool: Pool, input: EvaluateInput): Promise<PolicyDecision> {
  const skillId =
    input.action.type === "skill.use"
      ? input.action.skillId
      : input.action.type === "knowledge.read"
        ? "knowledge.retrieve"
        : input.action.type === "model.process"
          ? "models.route"
          : input.action.type === "approval.decide"
            ? "approvals.decide"
            : input.action.type === "connector.use"
              ? `connector.${input.action.connectorKey}`
              : undefined;
  const policy = await loadActivePolicy(pool, input.organizationId, skillId);
  const ref = policy
    ? { id: policy.id, version: String(policy.version) }
    : { id: null, version: null };

  if (!policy) {
    return decision("deny", "DENY_DEFAULT", ref);
  }

  if (input.action.type === "data.leave_device") {
    const allowed = policy.rules.leave_device[input.action.classification];
    if (!allowed) {
      return decision("deny", "CLASSIFICATION_DENIED", ref, {
        leave_device: false,
      });
    }
    return decision("allow", "ROLE_AND_CLASSIFICATION_ALLOWED", ref);
  }

  if (input.action.type === "connector.use") {
    const connector = await pool.query<{ enabled: boolean; allowed_data_classes_json: DataClassification[] }>(
      `SELECT enabled, allowed_data_classes_json
       FROM command.connectors
       WHERE organization_id = $1 AND connector_key = $2`,
      [input.organizationId, input.action.connectorKey]
    );
    const row = connector.rows[0];
    if (!row?.enabled) {
      return decision("deny", "CONNECTOR_DENIED", ref);
    }
    if (!row.allowed_data_classes_json.includes(input.action.classification)) {
      return decision("deny", "CLASSIFICATION_DENIED", ref);
    }
    return decision("allow", "ROLE_AND_CLASSIFICATION_ALLOWED", ref);
  }

  if (input.action.type === "approval.decide") {
    const skill = await pool.query<{ id: string }>(
      `SELECT sp.id
       FROM command.skill_policies sp
       JOIN command.skill_policy_roles spr ON spr.skill_policy_id = sp.id
       WHERE sp.organization_id = $1 AND sp.skill_id = 'approvals.decide' AND spr.role_id = $2`,
      [input.organizationId, input.roleId]
    );
    if (skill.rows.length === 0) {
      return decision("deny", "APPROVER_UNAUTHORIZED", ref);
    }
    const approval = await pool.query<{ organization_id: string; requested_by: string }>(
      `SELECT organization_id, requested_by FROM command.approvals WHERE id = $1`,
      [input.action.approvalId]
    );
    const row = approval.rows[0];
    if (!row || row.organization_id !== input.organizationId) {
      return decision("deny", "CROSS_ORGANIZATION_DENIED", ref);
    }
    if (row.requested_by === input.actorId) {
      return decision("deny", "APPROVER_UNAUTHORIZED", ref, { self_approval: false });
    }
    return decision("allow", "ROLE_AND_CLASSIFICATION_ALLOWED", ref);
  }

  if (input.action.type === "model.process") {
    if (RISK_RANK[input.action.requestedRisk] > RISK_RANK[input.action.modelRiskCeiling]) {
      return decision("deny", "MODEL_DENIED", ref, { reason: "MODEL_RISK_CEILING_EXCEEDED" });
    }
    if (input.action.deploymentType === "cloud" && !policy.rules.cloud_models[input.action.classification]) {
      return decision("deny", "CLASSIFICATION_DENIED", ref, { cloud_models: false });
    }
    return decision("allow", "ROLE_AND_CLASSIFICATION_ALLOWED", ref);
  }

  const skillKey =
    input.action.type === "skill.use" ? input.action.skillId : "knowledge.retrieve";
  const classification =
    input.action.type === "skill.use" || input.action.type === "knowledge.read"
      ? input.action.classification
      : "public";
  const riskTier = input.action.type === "skill.use" ? input.action.riskTier : "low";

  const skill = await pool.query<{
    requires_approval: boolean;
    classification_ceiling: DataClassification;
    risk_ceiling: RiskTier;
  }>(
    `SELECT sp.requires_approval, sp.classification_ceiling, sp.risk_ceiling
     FROM command.skill_policies sp
     JOIN command.skill_policy_roles spr ON spr.skill_policy_id = sp.id
     WHERE sp.organization_id = $1 AND sp.skill_id = $2 AND spr.role_id = $3`,
    [input.organizationId, skillKey, input.roleId]
  );
  const allowed = skill.rows[0];
  if (!allowed) {
    return decision("deny", "ROLE_DENIED", ref);
  }
  if (CLASSIFICATION_RANK[classification] > CLASSIFICATION_RANK[allowed.classification_ceiling]) {
    return decision("deny", "CLASSIFICATION_DENIED", ref);
  }
  if (RISK_RANK[riskTier] > RISK_RANK[allowed.risk_ceiling]) {
    return decision("deny", "SKILL_DENIED", ref);
  }
  if (allowed.requires_approval) {
    return decision("approval_required", "APPROVAL_REQUIRED", ref, {
      skill_id: skillKey,
    });
  }
  return decision("allow", "ROLE_AND_CLASSIFICATION_ALLOWED", ref);
}

export async function getPolicy(pool: Pool, organizationId: string, policyId: string) {
  const result = await pool.query(
    `SELECT id, name, version, status, rules, created_at
     FROM command.policies
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, policyId]
  );
  return result.rows[0] ?? null;
}

export async function listPolicies(pool: Pool, organizationId: string) {
  const result = await pool.query(
    `SELECT id, name, version, status, created_at
     FROM command.policies
     WHERE organization_id = $1
     ORDER BY name, version DESC`,
    [organizationId]
  );
  return result.rows;
}

export async function createApproval(
  pool: Pool,
  input: {
    organizationId: string;
    executionId: string;
    skillId: string;
    requestedBy: string;
  }
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO command.approvals (
       id, organization_id, execution_id, skill_id, requested_by, status
     ) VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [id, input.organizationId, input.executionId, input.skillId, input.requestedBy]
  );
  return id;
}

export async function decideApproval(
  pool: Pool,
  input: { organizationId: string; approvalId: string; decidedBy: string; allow: boolean }
): Promise<void> {
  const result = await pool.query(
    `UPDATE command.approvals
     SET status = $4, decided_by = $3, decided_at = now(),
         reason_code = $5
     WHERE id = $1 AND organization_id = $2 AND status = 'pending'`,
    [
      input.approvalId,
      input.organizationId,
      input.decidedBy,
      input.allow ? "approved" : "denied",
      input.allow ? "APPROVED" : "DENIED",
    ]
  );
  if (result.rowCount !== 1) {
    throw new Error("approval not pending");
  }
}
