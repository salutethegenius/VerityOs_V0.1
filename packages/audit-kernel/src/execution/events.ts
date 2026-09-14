import { randomUUID } from "crypto";
import type { Pool, PoolClient } from "pg";
import {
  EXECUTION_EVENT_TYPES,
  type ExecutionEventStatus,
  type ExecutionEventType,
} from "@verityos/contracts";
import { canonicalTimestampNow } from "../hashing/hash.js";
import { getExecution } from "./executions.js";

export interface ExecutionEventRow {
  id: string;
  organization_id: string;
  execution_id: string;
  event_sequence: number;
  event_type: ExecutionEventType;
  status: string;
  parent_event_ids: string[];
  input_hash: string | null;
  output_hash: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  occurred_at_canonical: string;
  created_at: Date;
}

export interface AppendExecutionEventInput {
  organizationId: string;
  executionId: string;
  eventType: ExecutionEventType;
  status: ExecutionEventStatus | string;
  parentEventIds?: string[];
  inputHash?: string | null;
  outputHash?: string | null;
  metadata?: Record<string, unknown>;
  occurredAtCanonical?: string;
}

const EVENT_TYPE_SET = new Set<string>(EXECUTION_EVENT_TYPES);

export async function appendExecutionEvent(
  db: Pool | PoolClient,
  input: AppendExecutionEventInput
): Promise<ExecutionEventRow> {
  if (!EVENT_TYPE_SET.has(input.eventType)) {
    throw new Error(`unknown execution event type ${input.eventType}`);
  }
  const occurredAtCanonical = input.occurredAtCanonical ?? canonicalTimestampNow();
  const id = randomUUID();
  const parentEventIds = [...(input.parentEventIds ?? [])].sort();
  const result = await db.query<ExecutionEventRow>(
    `WITH locked AS (
       SELECT id FROM audit.executions
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE
     )
     INSERT INTO audit.execution_events (
       id, organization_id, execution_id, event_sequence, event_type, status,
       parent_event_ids, input_hash, output_hash, metadata,
       occurred_at, occurred_at_canonical, created_at
     )
     SELECT
       $3, $2, locked.id,
       COALESCE((
         SELECT MAX(event_sequence) FROM audit.execution_events WHERE execution_id = locked.id
       ), 0) + 1,
       $4, $5, $6::uuid[], $7, $8, $9::jsonb,
       $10::timestamptz, $10, $10::timestamptz
     FROM locked
     RETURNING *`,
    [
      input.executionId,
      input.organizationId,
      id,
      input.eventType,
      input.status,
      parentEventIds,
      input.inputHash ?? null,
      input.outputHash ?? null,
      JSON.stringify(input.metadata ?? {}),
      occurredAtCanonical,
    ]
  );
  const row = result.rows[0];
  if (!row) {
    const existing = await getExecution(db, input.organizationId, input.executionId);
    if (!existing) {
      throw new Error("execution not found");
    }
    throw new Error("failed to append execution event");
  }
  return normalizeEvent(row);
}

export async function listExecutionEvents(
  db: Pool | PoolClient,
  organizationId: string,
  executionId: string
): Promise<ExecutionEventRow[]> {
  const result = await db.query<ExecutionEventRow>(
    `SELECT * FROM audit.execution_events
     WHERE organization_id = $1 AND execution_id = $2
     ORDER BY event_sequence ASC`,
    [organizationId, executionId]
  );
  return result.rows.map(normalizeEvent);
}

function normalizeEvent(row: ExecutionEventRow): ExecutionEventRow {
  return {
    ...row,
    parent_event_ids: Array.isArray(row.parent_event_ids)
      ? row.parent_event_ids
      : ((row.parent_event_ids as unknown as string) ?? "")
          .replace(/[{}]/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
    metadata:
      row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}
