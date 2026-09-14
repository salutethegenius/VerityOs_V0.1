import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HASH_FORMAT_VERSION } from "../src/hashing/hash.js";
import { appendLedgerEntry } from "../src/ledger/append.js";
import {
  appendExecutionEvent,
  listExecutionEvents,
} from "../src/execution/events.js";
import {
  ExecutionTransitionError,
  assertExecutionTransition,
  getExecution,
  openExecution,
  setExecutionStatus,
} from "../src/execution/executions.js";
import {
  GRAPH_SCHEMA_VERSION,
  buildExecutionGraphV2,
  computeExecutionGraphHash,
} from "../src/execution/graph-v2.js";
import { sealExecution } from "../src/execution/finalize.js";
import { exportOrganizationEvidence } from "../src/export/bundle.js";
import { verifyEvidenceBundle } from "../src/verify/verify.js";
import { createPool } from "./helpers/db.js";
import { contentHash } from "./helpers/evidence.js";

const pool = createPool();

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

describe("Execution Graph V2", () => {
  it("does not treat graph schema version as hash_format_version", () => {
    expect(HASH_FORMAT_VERSION).toBe("2");
    expect(GRAPH_SCHEMA_VERSION).toBe("2");
  });

  it("rejects invalid execution transitions", async () => {
    expect(() => assertExecutionTransition("completed", "running")).toThrow(
      ExecutionTransitionError
    );
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    await expect(
      setExecutionStatus(pool, execution.id, "completed", { organizationId })
    ).rejects.toThrow(/invalid execution transition/);
    expect(await getExecution(pool, randomUUID(), execution.id)).toBeNull();
  });

  it("allocates ordered sequences under concurrent appends", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    const count = 12;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        appendExecutionEvent(pool, {
          organizationId,
          executionId: execution.id,
          eventType: i === 0 ? "execution.created" : "identity.authenticated",
          status: "recorded",
          metadata: { i },
        })
      )
    );
    const events = await listExecutionEvents(pool, organizationId, execution.id);
    expect(events.map((e) => e.event_sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, i) => i + 1)
    );
    expect(new Set(events.map((e) => e.event_sequence)).size).toBe(count);
  });

  it("rejects cross-organization event injection", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const executionA = await openExecution(pool, { organizationId: orgA });
    await openExecution(pool, { organizationId: orgB });
    await expect(
      pool.query(
        `INSERT INTO audit.execution_events (
           id, organization_id, execution_id, event_sequence, event_type, status,
           parent_event_ids, metadata, occurred_at, occurred_at_canonical, created_at
         ) VALUES (
           $1, $2, $3, 1, 'execution.created', 'recorded', '{}', '{}'::jsonb, now(), now()::text, now()
         )`,
        [randomUUID(), orgB, executionA.id]
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("reconstructs a deterministic graph hash from the same event set", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    const created = await appendExecutionEvent(pool, {
      organizationId,
      executionId: execution.id,
      eventType: "execution.created",
      status: "recorded",
      metadata: { skill_id: "nova.use" },
    });
    await appendExecutionEvent(pool, {
      organizationId,
      executionId: execution.id,
      eventType: "identity.authenticated",
      status: "ok",
      parentEventIds: [created.id],
      metadata: { actor_id: created.id },
    });
    const events = await listExecutionEvents(pool, organizationId, execution.id);
    const graphA = buildExecutionGraphV2(execution, events);
    const graphB = buildExecutionGraphV2(execution, [...events].reverse());
    expect(graphA).toEqual(graphB);
    expect(computeExecutionGraphHash(graphA)).toBe(computeExecutionGraphHash(graphB));
    const mutated = {
      ...graphA,
      nodes: graphA.nodes.map((node, i) =>
        i === 0 ? { ...node, metadata: { ...node.metadata, tampered: true } } : node
      ),
    };
    expect(computeExecutionGraphHash(mutated)).not.toBe(computeExecutionGraphHash(graphA));
  });

  it("seals a final ledger entry with execution_graph_hash and rolls back on injected failure", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    await appendLedgerEntry(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "request_opened",
      requestHash: contentHash("open"),
      responseHash: null,
      executionGraphHash: null,
    });
    await appendExecutionEvent(pool, {
      organizationId,
      executionId: execution.id,
      eventType: "execution.created",
      status: "recorded",
    });
    await expect(
      sealExecution(
        pool,
        {
          organizationId,
          executionId: execution.id,
          entryType: "final",
          executionStatus: "completed",
          requestHash: contentHash("open"),
          responseHash: contentHash("done"),
        },
        {
          beforeCommit: async () => {
            throw new Error("injected finalization failure");
          },
        }
      )
    ).rejects.toThrow(/injected finalization failure/);
    const afterFail = await getExecution(pool, organizationId, execution.id);
    expect(afterFail?.status).toBe("running");
    expect(afterFail?.final_entry_id).toBeNull();
    const finals = await pool.query(
      `SELECT * FROM audit.ledger_entries WHERE execution_id = $1 AND entry_type = 'final'`,
      [execution.id]
    );
    expect(finals.rows).toHaveLength(0);

    const sealed = await sealExecution(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "final",
      executionStatus: "completed",
      requestHash: contentHash("open"),
      responseHash: contentHash("done"),
    });
    expect(sealed.entry.execution_graph_hash).toBe(sealed.graphHash);
    expect(sealed.entry.hash_format_version).toBe("2");
    expect(sealed.graph.schema_version).toBe("2");
    const completed = await getExecution(pool, organizationId, execution.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.final_entry_id).toBe(sealed.entry.id);
  });

  it("keeps older null-graph ledger entries verifiable", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    await appendLedgerEntry(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "request_opened",
      requestHash: contentHash("legacy"),
      responseHash: null,
      executionGraphHash: null,
    });
    await appendLedgerEntry(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "final",
      requestHash: contentHash("legacy"),
      responseHash: contentHash("legacy-out"),
      executionGraphHash: null,
    });
    const bundle = await exportOrganizationEvidence(pool, organizationId);
    expect(bundle.ledger_entries.some((row) => row.execution_graph_hash === null)).toBe(true);
    expect(bundle.execution_graphs ?? []).toEqual([]);
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(true);
  });
});
