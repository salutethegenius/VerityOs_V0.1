import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HASH_FORMAT_VERSION } from "../src/hashing/hash.js";
import { appendLedgerEntry } from "../src/ledger/append.js";
import {
  appendExecutionEvent,
  appendExecutionEventInTransaction,
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
  UnresolvedGraphParentError,
  buildExecutionGraphV2,
  computeExecutionGraphHash,
} from "../src/execution/graph-v2.js";
import { sealExecution } from "../src/execution/finalize.js";
import { exportOrganizationEvidence } from "../src/export/bundle.js";
import { verifyEvidenceBundle } from "../src/verify/verify.js";
import { InvalidEvidenceInputError } from "../src/hashing/evidence.js";
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
      requestHash: contentHash("must-not-be-used"),
      responseHash: contentHash("done"),
    });
    expect(sealed.entry.execution_graph_hash).toBe(sealed.graphHash);
    expect(sealed.entry.request_hash).toBe(contentHash("open"));
    expect(sealed.entry.request_hash).not.toBe(contentHash("must-not-be-used"));
    expect(sealed.entry.response_hash).toBe(contentHash("done"));
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

describe("Execution Graph V2 evidence completeness", () => {
  async function sealedExport() {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    await appendLedgerEntry(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "request_opened",
      requestHash: contentHash("req"),
      responseHash: null,
      executionGraphHash: null,
    });
    await appendExecutionEvent(pool, {
      organizationId,
      executionId: execution.id,
      eventType: "execution.created",
      status: "recorded",
    });
    await sealExecution(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "final",
      executionStatus: "completed",
      responseHash: null,
    });
    const bundle = await exportOrganizationEvidence(pool, organizationId);
    expect(verifyEvidenceBundle(bundle).valid).toBe(true);
    const opened = bundle.ledger_entries.find((entry) => entry.entry_type === "request_opened");
    const final = bundle.ledger_entries.find((entry) => entry.entry_type === "final");
    expect(final?.request_hash).toBe(opened?.request_hash);
    expect(final?.response_hash).toBeNull();
    return bundle;
  }

  it("fails when a graph-bearing final is missing only the graph export", async () => {
    const bundle = await sealedExport();
    bundle.execution_graphs = [];
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "GRAPH_EVIDENCE_MISSING")).toBe(true);
  });

  it("fails when a graph-bearing final is missing only the events", async () => {
    const bundle = await sealedExport();
    bundle.execution_events = [];
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "GRAPH_EVENTS_MISSING")).toBe(true);
  });

  it("fails when a graph-bearing final is missing both graph and events", async () => {
    const bundle = await sealedExport();
    bundle.execution_graphs = [];
    bundle.execution_events = [];
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "GRAPH_EVIDENCE_MISSING")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "GRAPH_EVENTS_MISSING")).toBe(true);
  });

  it("fails when exported events contain an unresolved parent", async () => {
    const bundle = await sealedExport();
    const events = bundle.execution_events ?? [];
    events[events.length - 1].parent_event_ids = [randomUUID()];
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "GRAPH_PARENT_UNRESOLVED")).toBe(true);
  });

  it("fails when a graph-bearing final has duplicate graph exports", async () => {
    const bundle = await sealedExport();
    const graphs = bundle.execution_graphs ?? [];
    expect(graphs[0]).toBeTruthy();
    bundle.execution_graphs = [graphs[0], { ...graphs[0] }];
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "GRAPH_DUPLICATE")).toBe(true);
  });

  it("fails when the reconstructed graph hash does not match the ledger", async () => {
    const bundle = await sealedExport();
    const final = bundle.ledger_entries.find((entry) => entry.entry_type === "final");
    expect(final).toBeTruthy();
    final!.execution_graph_hash = contentHash("tampered-graph");
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "GRAPH_LEDGER_MISMATCH")).toBe(true);
  });
});

describe("execution event parents and evidence", () => {
  it("rejects nonexistent, cross-execution, and cross-organization parents", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const executionA = await openExecution(pool, { organizationId: orgA });
    const executionB = await openExecution(pool, { organizationId: orgA });
    const foreign = await openExecution(pool, { organizationId: orgB });
    const createdA = await appendExecutionEvent(pool, {
      organizationId: orgA,
      executionId: executionA.id,
      eventType: "execution.created",
      status: "recorded",
    });
    const createdB = await appendExecutionEvent(pool, {
      organizationId: orgA,
      executionId: executionB.id,
      eventType: "execution.created",
      status: "recorded",
    });
    const createdForeign = await appendExecutionEvent(pool, {
      organizationId: orgB,
      executionId: foreign.id,
      eventType: "execution.created",
      status: "recorded",
    });
    await expect(
      appendExecutionEvent(pool, {
        organizationId: orgA,
        executionId: executionA.id,
        eventType: "identity.authenticated",
        status: "ok",
        parentEventIds: [randomUUID()],
      })
    ).rejects.toMatchObject({ code: "PARENT_NOT_FOUND" });
    await expect(
      appendExecutionEvent(pool, {
        organizationId: orgA,
        executionId: executionA.id,
        eventType: "identity.authenticated",
        status: "ok",
        parentEventIds: [createdB.id],
      })
    ).rejects.toMatchObject({ code: "PARENT_CROSS_EXECUTION" });
    await expect(
      appendExecutionEvent(pool, {
        organizationId: orgA,
        executionId: executionA.id,
        eventType: "identity.authenticated",
        status: "ok",
        parentEventIds: [createdForeign.id],
      })
    ).rejects.toMatchObject({ code: "PARENT_CROSS_ORGANIZATION" });
    expect(createdA.id).toBeTruthy();
  });

  it("accepts a valid multi-parent event and normalizes duplicate parent ids", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    const created = await appendExecutionEvent(pool, {
      organizationId,
      executionId: execution.id,
      eventType: "execution.created",
      status: "recorded",
    });
    const identity = await appendExecutionEvent(pool, {
      organizationId,
      executionId: execution.id,
      eventType: "identity.authenticated",
      status: "ok",
      parentEventIds: [created.id, created.id],
    });
    expect(identity.parent_event_ids).toEqual([created.id]);
    const classified = await appendExecutionEvent(pool, {
      organizationId,
      executionId: execution.id,
      eventType: "risk.classified",
      status: "recorded",
      parentEventIds: [created.id, identity.id],
    });
    expect(classified.parent_event_ids.sort()).toEqual([created.id, identity.id].sort());
    const events = await listExecutionEvents(pool, organizationId, execution.id);
    const graph = buildExecutionGraphV2(execution, events);
    expect(graph.edges.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects malformed hashes, timestamps, and non-VCHF-2 metadata", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    await expect(
      appendExecutionEvent(pool, {
        organizationId,
        executionId: execution.id,
        eventType: "execution.created",
        status: "recorded",
        inputHash: "not-a-hash",
      })
    ).rejects.toBeInstanceOf(InvalidEvidenceInputError);
    await expect(
      appendExecutionEvent(pool, {
        organizationId,
        executionId: execution.id,
        eventType: "execution.created",
        status: "recorded",
        occurredAtCanonical: "2026-09-14T20:00:00.123+00:00",
      })
    ).rejects.toBeInstanceOf(InvalidEvidenceInputError);
    await expect(
      appendExecutionEvent(pool, {
        organizationId,
        executionId: execution.id,
        eventType: "execution.created",
        status: "recorded",
        metadata: { latency_ms: 1.5 },
      })
    ).rejects.toBeInstanceOf(InvalidEvidenceInputError);
    await expect(
      appendExecutionEvent(pool, {
        organizationId,
        executionId: execution.id,
        eventType: "not.a.contract" as never,
        status: "recorded",
      })
    ).rejects.toMatchObject({ code: "UNKNOWN_EVENT_TYPE" });
  });

  it("rejects a PoolClient on the public append API", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    const client = await pool.connect();
    try {
      await expect(
        appendExecutionEvent(client as never, {
          organizationId,
          executionId: execution.id,
          eventType: "execution.created",
          status: "recorded",
        })
      ).rejects.toThrow(/appendExecutionEventInTransaction/);
      await client.query("BEGIN");
      const row = await appendExecutionEventInTransaction(client, {
        organizationId,
        executionId: execution.id,
        eventType: "execution.created",
        status: "recorded",
      });
      await client.query("COMMIT");
      expect(row.event_sequence).toBe(1);
    } finally {
      client.release();
    }
  });

  it("does not silently drop unresolved parents during reconstruction", () => {
    expect(
      () =>
        buildExecutionGraphV2(
          {
            id: randomUUID(),
            verity_record_id: "VTY-2026-TEST",
            organization_id: randomUUID(),
            status: "running",
          },
          [
            {
              id: randomUUID(),
              organization_id: randomUUID(),
              execution_id: randomUUID(),
              event_sequence: 1,
              event_type: "execution.created",
              status: "recorded",
              parent_event_ids: [randomUUID()],
              input_hash: null,
              output_hash: null,
              metadata: {},
              occurred_at: new Date(),
              occurred_at_canonical: new Date().toISOString(),
              created_at: new Date(),
            },
          ]
        )
    ).toThrow(UnresolvedGraphParentError);
  });
});
