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
  extra: { finalEntryId?: string | null; completedAt?: Date | null } = {}
): Promise<void> {
  await clientOf(pool).query(
    `UPDATE audit.executions
     SET status = $2,
         final_entry_id = COALESCE($3, final_entry_id),
         completed_at = COALESCE($4, completed_at)
     WHERE id = $1`,
    [executionId, status, extra.finalEntryId ?? null, extra.completedAt ?? null]
  );
}

export async function getExecution(
  pool: Pool,
  executionId: string
): Promise<ExecutionRow | null> {
  const result = await pool.query<ExecutionRow>(
    "SELECT * FROM audit.executions WHERE id = $1",
    [executionId]
  );
  return result.rows[0] ?? null;
}
