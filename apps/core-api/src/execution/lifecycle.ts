import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  appendExecutionEvent,
  appendExecutionEventInTransaction,
  appendLedgerEntryInTransaction,
  getExecution,
  listExecutionEvents,
  setExecutionStatus,
} from "@verityos/audit-kernel";
import { decideApproval, evaluatePolicy, getApproval } from "@verityos/command";
import type { ExecutionEventType } from "@verityos/contracts";
import { ExecutionError } from "./service.js";

const SKILL_EVENT_TYPES = {
  start: "nova.skill.started",
  complete: "nova.skill.completed",
  fail: "nova.skill.failed",
} as const;

function assertSha256(field: string, value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ExecutionError("INVALID_INPUT", `${field} must be a lowercase SHA-256 hex string`, 400);
  }
  return value;
}

async function lastEventId(pool: Pool, organizationId: string, executionId: string) {
  const events = await listExecutionEvents(pool, organizationId, executionId);
  return events.at(-1)?.id;
}

async function requireScopedOpen(
  pool: Pool,
  organizationId: string,
  executionId: string
) {
  const execution = await getExecution(pool, organizationId, executionId);
  if (!execution) {
    throw new ExecutionError("NOT_FOUND", "execution not found", 404);
  }
  if (["completed", "failed", "blocked", "cancelled"].includes(execution.status)) {
    throw new ExecutionError("INVALID_EXECUTION_TRANSITION", "execution is terminal", 409);
  }
  return execution;
}

export async function recordSkillLifecycleEvent(
  pool: Pool,
  input: {
    organizationId: string;
    executionId: string;
    phase: "start" | "complete" | "fail";
    skillId: string;
    skillVersion: string;
    brandId?: string | null;
    configHash?: string | null;
    resultArtifactHash?: string | null;
    reasonCode?: string | null;
  }
) {
  const execution = await requireScopedOpen(pool, input.organizationId, input.executionId);
  const allowed = new Set(["nova.social.draft", "nova.research", "nova.drafting", "nova.use"]);
  if (!allowed.has(input.skillId)) {
    throw new ExecutionError("UNKNOWN_SKILL", `unsupported skill ${input.skillId}`, 400);
  }
  const configHash = assertSha256("config_hash", input.configHash ?? null);
  const artifactHash = assertSha256("result_artifact_hash", input.resultArtifactHash ?? null);
  const parent = await lastEventId(pool, execution.organization_id, execution.id);
  const eventType = SKILL_EVENT_TYPES[input.phase] as ExecutionEventType;
  const metadata: Record<string, unknown> = {
    skill_id: input.skillId,
    skill_version: input.skillVersion,
  };
  if (input.brandId) {
    metadata.brand_id = input.brandId;
  }
  if (configHash) {
    metadata.config_hash = configHash;
  }
  if (artifactHash) {
    metadata.result_artifact_hash = artifactHash;
  }
  if (input.reasonCode) {
    metadata.reason_code = input.reasonCode;
  }
  const row = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType,
    status: input.phase === "fail" ? "failed" : input.phase === "complete" ? "ok" : "started",
    parentEventIds: parent ? [parent] : [],
    outputHash: artifactHash,
    metadata,
  });
  return {
    event_id: row.id,
    event_type: row.event_type,
    execution_id: execution.id,
    status: execution.status,
  };
}

export async function requestExecutionApproval(
  pool: Pool,
  input: {
    organizationId: string;
    executionId: string;
    skillId: string;
    requestedBy: string;
    artifactHash: string;
  }
) {
  const execution = await requireScopedOpen(pool, input.organizationId, input.executionId);
  const artifactHash = assertSha256("artifact_hash", input.artifactHash);
  if (!artifactHash) {
    throw new ExecutionError("INVALID_INPUT", "artifact_hash is required", 400);
  }
  const requestedBy = await pool.query<{ id: string }>(
    `SELECT u.id FROM auth.users u
     JOIN auth.memberships m ON m.user_id = u.id
     WHERE u.id = $1 AND m.organization_id = $2`,
    [input.requestedBy, execution.organization_id]
  );
  if (!requestedBy.rows[0]) {
    throw new ExecutionError("NOT_A_MEMBER", "requested_by is not a member of this organization", 403);
  }
  const client = await pool.connect();
  let approvalId = "";
  try {
    await client.query("BEGIN");
    approvalId = randomUUID();
    await client.query(
      `INSERT INTO command.approvals (
         id, organization_id, execution_id, skill_id, requested_by, status, artifact_hash
       ) VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [
        approvalId,
        execution.organization_id,
        execution.id,
        input.skillId,
        input.requestedBy,
        artifactHash,
      ]
    );
    const parent = await lastEventId(pool, execution.organization_id, execution.id);
    await appendExecutionEventInTransaction(client, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "approval.requested",
      status: "started",
      parentEventIds: parent ? [parent] : [],
      outputHash: artifactHash,
      metadata: {
        approval_id: approvalId,
        skill_id: input.skillId,
        artifact_hash: artifactHash,
      },
    });
    const opened = await client.query<{ request_hash: string | null }>(
      `SELECT request_hash FROM audit.ledger_entries
       WHERE organization_id = $1 AND execution_id = $2 AND entry_type = 'request_opened'
       ORDER BY organization_sequence ASC LIMIT 1`,
      [execution.organization_id, execution.id]
    );
    await appendLedgerEntryInTransaction(client, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      entryType: "approval_requested",
      requestHash: opened.rows[0]?.request_hash ?? null,
      responseHash: null,
      executionGraphHash: null,
      executionStatus: "waiting_approval",
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return {
    approval_id: approvalId,
    execution_id: execution.id,
    status: "waiting_approval",
    artifact_hash: artifactHash,
  };
}

export async function decideExecutionApproval(
  pool: Pool,
  input: {
    organizationId: string;
    executionId: string;
    approvalId: string;
    actorId: string;
    allow: boolean;
    artifactHash: string;
  }
) {
  const execution = await getExecution(pool, input.organizationId, input.executionId);
  if (!execution) {
    throw new ExecutionError("NOT_FOUND", "execution not found", 404);
  }
  const approval = await getApproval(pool, execution.organization_id, input.approvalId);
  if (!approval || approval.execution_id !== execution.id) {
    throw new ExecutionError("NOT_FOUND", "approval not found", 404);
  }
  const submitted = assertSha256("artifact_hash", input.artifactHash);
  if (!approval.artifact_hash || approval.artifact_hash !== submitted) {
    throw new ExecutionError(
      "ARTIFACT_HASH_MISMATCH",
      "approval does not bind this artifact hash",
      409
    );
  }
  const membership = await pool.query<{ role_id: string }>(
    `SELECT role_id FROM auth.memberships WHERE user_id = $1 AND organization_id = $2`,
    [input.actorId, execution.organization_id]
  );
  if (!membership.rows[0]) {
    throw new ExecutionError("NOT_A_MEMBER", "actor is not a member of this organization", 403);
  }
  const policy = await evaluatePolicy(pool, {
    organizationId: execution.organization_id,
    actorId: input.actorId,
    roleId: membership.rows[0].role_id,
    action: { type: "approval.decide", approvalId: input.approvalId },
  });
  if (policy.decision !== "allow") {
    throw new ExecutionError(policy.reason_code, "approval decision denied", 403);
  }
  await decideApproval(pool, {
    organizationId: execution.organization_id,
    approvalId: input.approvalId,
    decidedBy: input.actorId,
    allow: input.allow,
  });
  const parent = await lastEventId(pool, execution.organization_id, execution.id);
  await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: input.allow ? "approval.approved" : "approval.rejected",
    status: input.allow ? "ok" : "denied",
    parentEventIds: parent ? [parent] : [],
    outputHash: approval.artifact_hash,
    metadata: {
      approval_id: input.approvalId,
      artifact_hash: approval.artifact_hash,
      decided_by: input.actorId,
    },
  });
  if (input.allow && execution.status === "waiting_approval") {
    await setExecutionStatus(pool, execution.id, "running", {
      organizationId: execution.organization_id,
    });
  }
  return {
    approval_id: input.approvalId,
    execution_id: execution.id,
    status: input.allow ? "approved" : "rejected",
    artifact_hash: approval.artifact_hash,
  };
}
