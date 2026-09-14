import { randomBytes, randomUUID } from "crypto";
import type { Pool, PoolClient } from "pg";
import type { ExecutionStatus, RiskTier } from "@verityos/contracts";
import type { ExecutionRow } from "../types.js";

function clientOf(pool: Pool | PoolClient): Pool | PoolClient {
  return pool;
}

export function allocateVerityRecordId(now = new Date()): string {
  const year = now.getUTCFullYear();
  const token = randomBytes(4).toString("hex").toUpperCase();
  return `VTY-${year}-${token}`;
}

export interface OpenExecutionInput {
  organizationId: string;
  actorId?: string | null;
  sessionId?: string | null;
  skillId?: string | null;
  riskTier?: RiskTier;
  policyVersion?: string | null;
  retentionMode?: string | null;
}

const TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  created: ["running", "blocked", "failed", "cancelled"],
  running: ["waiting_approval", "completed", "blocked", "failed", "cancelled"],
  waiting_approval: ["running", "completed", "blocked", "failed", "cancelled"],
  completed: [],
  failed: [],
  blocked: [],
  cancelled: [],
};

export class ExecutionTransitionError extends Error {
  readonly code = "INVALID_EXECUTION_TRANSITION";
  constructor(from: ExecutionStatus, to: ExecutionStatus) {
    super(`invalid execution transition ${from} -> ${to}`);
    this.name = "ExecutionTransitionError";
  }
}

export function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (from === to) {
    return;
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new ExecutionTransitionError(from, to);
  }
}

export async function openExecution(
  pool: Pool | PoolClient,
  input: OpenExecutionInput
): Promise<ExecutionRow> {
  const id = randomUUID();
  const verityRecordId = allocateVerityRecordId();
  const riskTier = input.riskTier ?? "low";
  const result = await clientOf(pool).query<ExecutionRow>(
    `INSERT INTO audit.executions (
       id, verity_record_id, organization_id, actor_id, session_id, skill_id,
       status, risk_tier, policy_version, retention_mode, started_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'created',$7,$8,$9, now())
     RETURNING *`,
    [
      id,
      verityRecordId,
      input.organizationId,
      input.actorId ?? null,
      input.sessionId ?? null,
      input.skillId ?? null,
      riskTier,
      input.policyVersion ?? null,
      input.retentionMode ?? null,
    ]
  );
  return result.rows[0];
}

export async function setExecutionStatus(
  pool: Pool | PoolClient,
  executionId: string,
  status: ExecutionStatus,
  extra: {
    organizationId?: string;
    finalEntryId?: string | null;
    completedAt?: Date | null;
  } = {}
): Promise<void> {
  const current = extra.organizationId
    ? await getExecution(pool, extra.organizationId, executionId)
    : await getExecutionById(pool, executionId);
  if (!current) {
    throw new Error("execution not found");
  }
  assertExecutionTransition(current.status, status);
  const result = await clientOf(pool).query(
    `UPDATE audit.executions
     SET status = $2,
         final_entry_id = COALESCE($3, final_entry_id),
         completed_at = COALESCE($4, completed_at)
     WHERE id = $1
       AND ($5::uuid IS NULL OR organization_id = $5)`,
    [executionId, status, extra.finalEntryId ?? null, extra.completedAt ?? null, extra.organizationId ?? null]
  );
  if (result.rowCount !== 1) {
    throw new Error("execution not found");
  }
}

export async function getExecution(
  pool: Pool | PoolClient,
  organizationId: string,
  executionId: string
): Promise<ExecutionRow | null> {
  const result = await clientOf(pool).query<ExecutionRow>(
    `SELECT * FROM audit.executions WHERE id = $1 AND organization_id = $2`,
    [executionId, organizationId]
  );
  return result.rows[0] ?? null;
}

export async function getExecutionByRecord(
  pool: Pool | PoolClient,
  organizationId: string,
  verityRecordId: string
): Promise<ExecutionRow | null> {
  const result = await clientOf(pool).query<ExecutionRow>(
    `SELECT * FROM audit.executions WHERE verity_record_id = $1 AND organization_id = $2`,
    [verityRecordId, organizationId]
  );
  return result.rows[0] ?? null;
}

/** Internal-only: ledger append looks up by id after it already scoped the write. */
export async function getExecutionById(
  pool: Pool | PoolClient,
  executionId: string
): Promise<ExecutionRow | null> {
  const result = await clientOf(pool).query<ExecutionRow>(
    "SELECT * FROM audit.executions WHERE id = $1",
    [executionId]
  );
  return result.rows[0] ?? null;
}

export async function listExecutions(
  pool: Pool,
  organizationId: string
): Promise<ExecutionRow[]> {
  const result = await pool.query<ExecutionRow>(
    `SELECT * FROM audit.executions
     WHERE organization_id = $1
     ORDER BY started_at DESC`,
    [organizationId]
  );
  return result.rows;
}
