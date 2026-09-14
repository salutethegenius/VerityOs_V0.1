import type { Pool, PoolClient } from "pg";
import type { ExecutionStatus, LedgerEntryType } from "@verityos/contracts";
import type { ExecutionGraphV2 } from "@verityos/contracts";
import { sha256Hex } from "../hashing/hash.js";
import { appendLedgerEntryInTransaction } from "../ledger/append.js";
import {
  appendExecutionEvent,
  listExecutionEvents,
  type AppendExecutionEventInput,
} from "./events.js";
import { getExecution } from "./executions.js";
import { buildExecutionGraphV2, computeExecutionGraphHash } from "./graph-v2.js";
import type { LedgerEntryRow } from "../types.js";

export interface SealExecutionInput {
  organizationId: string;
  executionId: string;
  entryType: Extract<LedgerEntryType, "final" | "failure">;
  executionStatus: Extract<ExecutionStatus, "completed" | "failed" | "blocked" | "cancelled">;
  requestHash: string | null;
  responseHash: string | null;
  parentEventIds?: string[];
  preludeEvents?: Array<Omit<AppendExecutionEventInput, "organizationId" | "executionId">>;
}

export interface SealExecutionResult {
  entry: LedgerEntryRow;
  graph: ExecutionGraphV2;
  graphHash: string;
}

export interface SealExecutionHooks {
  beforeCommit?: () => Promise<void>;
}

export async function sealExecutionInTransaction(
  client: PoolClient,
  input: SealExecutionInput
): Promise<SealExecutionResult> {
  const execution = await getExecution(client, input.organizationId, input.executionId);
  if (!execution) {
    throw new Error("execution not found");
  }

  let parentEventIds = [...(input.parentEventIds ?? [])];
  for (const prelude of input.preludeEvents ?? []) {
    const recorded = await appendExecutionEvent(client, {
      ...prelude,
      organizationId: input.organizationId,
      executionId: input.executionId,
      parentEventIds:
        prelude.parentEventIds && prelude.parentEventIds.length > 0
          ? prelude.parentEventIds
          : parentEventIds,
    });
    parentEventIds = [recorded.id];
  }

  const events = await listExecutionEvents(client, input.organizationId, input.executionId);
  const preSealGraph = buildExecutionGraphV2(
    { ...execution, status: input.executionStatus },
    events
  );
  const preSealHash = computeExecutionGraphHash(preSealGraph);
  const sealed = await appendExecutionEvent(client, {
    organizationId: input.organizationId,
    executionId: input.executionId,
    eventType: "audit.checkpoint.sealed",
    status: "ok",
    parentEventIds,
    outputHash: preSealHash,
    metadata: {
      entry_type: input.entryType,
      execution_status: input.executionStatus,
    },
  });
  const sealedGraph = buildExecutionGraphV2(
    { ...execution, status: input.executionStatus },
    [...events, sealed]
  );
  const sealedHash = computeExecutionGraphHash(sealedGraph);
  const entry = await appendLedgerEntryInTransaction(client, {
    organizationId: input.organizationId,
    executionId: input.executionId,
    entryType: input.entryType,
    requestHash: input.requestHash,
    responseHash: input.responseHash ?? sha256Hex(sealedHash),
    executionGraphHash: sealedHash,
    executionStatus: input.executionStatus,
  });
  return { entry, graph: sealedGraph, graphHash: sealedHash };
}

export async function sealExecution(
  pool: Pool,
  input: SealExecutionInput,
  hooks: SealExecutionHooks = {}
): Promise<SealExecutionResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await sealExecutionInTransaction(client, input);
    if (hooks.beforeCommit) {
      await hooks.beforeCommit();
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
