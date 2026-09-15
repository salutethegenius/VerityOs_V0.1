import { randomUUID } from "crypto";
import pg, { type Pool, type PoolClient } from "pg";
import {
  EXECUTION_EVENT_TYPES,
  type ExecutionEventStatus,
  type ExecutionEventType,
} from "@verityos/contracts";
import { canonicalize } from "../hashing/canonicalize.js";
import { canonicalTimestampNow } from "../hashing/hash.js";
import {
  InvalidEvidenceInputError,
  assertCanonicalUtcTimestamp,
  assertSha256Hex,
} from "../hashing/evidence.js";
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

export class ExecutionEventError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutionEventError";
    this.code = code;
  }
}

const EVENT_TYPE_SET = new Set<string>(EXECUTION_EVENT_TYPES);

function assertIsPool(db: unknown): asserts db is Pool {
  if (!(db instanceof pg.Pool)) {
    throw new Error(
      "appendExecutionEvent requires a Pool and always opens its own transaction. Use appendExecutionEventInTransaction(client, ...) if you are already inside a transaction."
    );
  }
}

function uniqueSortedIds(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function assertEventEvidence(input: AppendExecutionEventInput): void {
  if (!EVENT_TYPE_SET.has(input.eventType)) {
    throw new ExecutionEventError(
      "UNKNOWN_EVENT_TYPE",
      `unknown execution event type ${input.eventType}`
    );
  }
  assertSha256Hex("input_hash", input.inputHash ?? null);
  assertSha256Hex("output_hash", input.outputHash ?? null);
  const metadata = input.metadata ?? {};
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new InvalidEvidenceInputError("metadata", "metadata must be a JSON object");
  }
  try {
    canonicalize(metadata);
  } catch (err) {
    throw new InvalidEvidenceInputError(
      "metadata",
      err instanceof Error ? err.message : "metadata is not valid for VCHF-2 canonicalization"
    );
  }
}

/**
 * Append an execution event. Always opens BEGIN/COMMIT/ROLLBACK on a Pool.
 * A PoolClient is rejected at runtime — callers already inside a transaction
 * must use appendExecutionEventInTransaction.
 */
export async function appendExecutionEvent(
  pool: Pool,
  input: AppendExecutionEventInput
): Promise<ExecutionEventRow> {
  assertIsPool(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await appendExecutionEventInTransaction(client, input);
    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Append an execution event using a client that is already inside an explicit
 * transaction. Does not open or close BEGIN/COMMIT/ROLLBACK.
 */
export async function appendExecutionEventInTransaction(
  client: PoolClient,
  input: AppendExecutionEventInput
): Promise<ExecutionEventRow> {
  assertEventEvidence(input);
  const occurredAtCanonical = input.occurredAtCanonical ?? canonicalTimestampNow();
  assertCanonicalUtcTimestamp("occurred_at_canonical", occurredAtCanonical);
  const id = randomUUID();
  const parentEventIds = uniqueSortedIds(input.parentEventIds ?? []);
  const locked = await client.query<{ id: string }>(
    `SELECT id FROM audit.executions
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [input.executionId, input.organizationId]
  );
  if (!locked.rows[0]) {
    const existing = await getExecution(client, input.organizationId, input.executionId);
    if (!existing) {
      throw new Error("execution not found");
    }
    throw new Error("failed to lock execution for event append");
  }
  const max = await client.query<{ n: string | number }>(
    `SELECT COALESCE(MAX(event_sequence), 0) AS n
     FROM audit.execution_events
     WHERE organization_id = $1 AND execution_id = $2`,
    [input.organizationId, input.executionId]
  );
  const nextSequence = Number(max.rows[0]?.n ?? 0) + 1;
  if (parentEventIds.length > 0) {
    const parents = await client.query<{
      id: string;
      organization_id: string;
      execution_id: string;
      event_sequence: number;
    }>(
      `SELECT id, organization_id, execution_id, event_sequence
       FROM audit.execution_events
       WHERE id = ANY($1::uuid[])`,
      [parentEventIds]
    );
    const byId = new Map(parents.rows.map((row) => [row.id, row]));
    for (const parentId of parentEventIds) {
      const parent = byId.get(parentId);
      if (!parent) {
        throw new ExecutionEventError(
          "PARENT_NOT_FOUND",
          `parent event ${parentId} does not exist`
        );
      }
      if (parent.organization_id !== input.organizationId) {
        throw new ExecutionEventError(
          "PARENT_CROSS_ORGANIZATION",
          "parent event belongs to another organization"
        );
      }
      if (parent.execution_id !== input.executionId) {
        throw new ExecutionEventError(
          "PARENT_CROSS_EXECUTION",
          "parent event belongs to another execution"
        );
      }
      if (parent.event_sequence >= nextSequence) {
        throw new ExecutionEventError(
          "PARENT_SEQUENCE",
          "parent event_sequence must be lower than the new event"
        );
      }
    }
  }
  const result = await client.query<ExecutionEventRow>(
    `INSERT INTO audit.execution_events (
       id, organization_id, execution_id, event_sequence, event_type, status,
       parent_event_ids, input_hash, output_hash, metadata,
       occurred_at, occurred_at_canonical, created_at
     ) VALUES (
       $3, $2, $1, $11, $4, $5, $6::uuid[], $7, $8, $9::jsonb,
       $10::timestamptz, $10, $10::timestamptz
     )
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
      nextSequence,
    ]
  );
  const row = result.rows[0];
  if (!row) {
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
