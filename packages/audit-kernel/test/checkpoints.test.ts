import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendLedgerEntry, getMerkleCheckpoints } from "../src/ledger/append.js";
import { openExecution, getExecution } from "../src/execution/executions.js";
import { verifyEvidenceBundle } from "../src/verify/verify.js";
import { exportOrganizationEvidence } from "../src/export/bundle.js";
import { createPool } from "./helpers/db.js";

const pool = createPool();

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

describe("V2 checkpoints", () => {
  it("seals request_opened -> approval_requested -> final with null hashes where unavailable", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, {
      organizationId,
      riskTier: "high",
    });
    const opened = await appendLedgerEntry(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "request_opened",
      requestHash: "artifact-draft",
      responseHash: null,
      executionGraphHash: null,
    });
    expect(opened.response_hash).toBeNull();
    expect(opened.execution_graph_hash).toBeNull();

    const approval = await appendLedgerEntry(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "approval_requested",
      requestHash: "artifact-draft",
      responseHash: null,
      executionGraphHash: null,
    });
    expect(approval.previous_entry_hash).toBe(opened.entry_hash);
    expect(approval.organization_sequence).toBe(2);

    const finalized = await appendLedgerEntry(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "final",
      requestHash: "artifact-draft",
      responseHash: "published",
      executionGraphHash: "graph",
    });
    expect(finalized.previous_entry_hash).toBe(approval.entry_hash);
    expect(finalized.organization_sequence).toBe(3);

    const exec = await getExecution(pool, execution.id);
    expect(exec?.status).toBe("completed");
    expect(exec?.final_entry_id).toBe(finalized.id);

    const bundle = await exportOrganizationEvidence(pool, organizationId);
    expect(verifyEvidenceBundle(bundle).valid).toBe(true);
  });

  it("writes a Merkle checkpoint using the duplicate-last rule at the configured interval", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    for (let i = 0; i < 4; i++) {
      await appendLedgerEntry(pool, {
        organizationId,
        executionId: execution.id,
        entryType: i === 3 ? "final" : "request_opened",
        requestHash: `h-${i}`,
        responseHash: null,
        executionGraphHash: null,
        merkleSnapshotInterval: 4,
      });
    }
    const checkpoints = await getMerkleCheckpoints(pool, organizationId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].from_sequence).toBe(1);
    expect(checkpoints[0].through_sequence).toBe(4);
    expect(checkpoints[0].leaf_hashes).toHaveLength(4);
    const bundle = await exportOrganizationEvidence(pool, organizationId);
    expect(bundle.ledger_entries.every((e) => (e.merkle_proof ?? []).length > 0)).toBe(
      true
    );
    expect(verifyEvidenceBundle(bundle).valid).toBe(true);
  });
});
