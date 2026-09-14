import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendLedgerEntry, getLedgerEntries } from "../src/ledger/append.js";
import { openExecution } from "../src/execution/executions.js";
import { exportOrganizationEvidence, serializeEvidenceBundle } from "../src/export/bundle.js";
import { verifyEvidenceBundle, verifyExportFile } from "../src/verify/verify.js";
import { computeEntryHash, buildHashPayload } from "../src/hashing/hash.js";
import { createPool } from "./helpers/db.js";
import { contentHash } from "./helpers/evidence.js";
import * as v1 from "../src/v1/verify-export.js";
import { computeEntryHash as v1ComputeEntryHash } from "../src/v1/ledger/hash.js";

const pool = createPool();

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

async function seededChain() {
  const organizationId = randomUUID();
  const execution = await openExecution(pool, {
    organizationId,
    skillId: "nova.drafting",
    riskTier: "medium",
  });
  await appendLedgerEntry(pool, {
    organizationId,
    executionId: execution.id,
    entryType: "request_opened",
    requestHash: contentHash("req-1"),
    responseHash: null,
    executionGraphHash: null,
    merkleSnapshotInterval: 4,
  });
  await appendLedgerEntry(pool, {
    organizationId,
    executionId: execution.id,
    entryType: "approval_requested",
    requestHash: contentHash("req-1"),
    responseHash: null,
    executionGraphHash: null,
    merkleSnapshotInterval: 4,
  });
  await appendLedgerEntry(pool, {
    organizationId,
    executionId: execution.id,
    entryType: "action_completed",
    requestHash: contentHash("req-1"),
    responseHash: contentHash("res-1"),
    executionGraphHash: contentHash("graph-1"),
    merkleSnapshotInterval: 4,
  });
  await appendLedgerEntry(pool, {
    organizationId,
    executionId: execution.id,
    entryType: "final",
    requestHash: contentHash("req-1"),
    responseHash: contentHash("res-1"),
    executionGraphHash: contentHash("graph-1"),
    merkleSnapshotInterval: 4,
  });
  return { organizationId, execution };
}

describe("V1 single-entry verify characterization", () => {
  it("does not fail the last entry when a middle row is mutated", () => {
    const rows: v1.LedgerRowExport[] = [
      {
        verity_audit_id: "a",
        request_hash: "r1",
        response_hash: "s1",
        execution_graph_hash: "g1",
        model_id: "m",
        model_provider: "p",
        risk_tier: "low",
        kernel_version: "0.1.0",
        previous_entry_hash: null,
        entry_hash: "will-fill",
        merkle_root: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        verity_audit_id: "b",
        request_hash: "r2",
        response_hash: "s2",
        execution_graph_hash: "g2",
        model_id: "m",
        model_provider: "p",
        risk_tier: "low",
        kernel_version: "0.1.0",
        previous_entry_hash: "will-fill",
        entry_hash: "will-fill",
        merkle_root: null,
        created_at: "2026-01-01T00:00:01.000Z",
      },
    ];
    rows[0].entry_hash = v1ComputeEntryHash({
      verityAuditId: "a",
      requestHash: "r1",
      responseHash: "s1",
      executionGraphHash: "g1",
      modelId: "m",
      modelProvider: "p",
      riskTier: "low",
      kernelVersion: "0.1.0",
      previousEntryHash: null,
      createdAt: rows[0].created_at,
    });
    rows[1].previous_entry_hash = rows[0].entry_hash;
    rows[1].entry_hash = v1ComputeEntryHash({
      verityAuditId: "b",
      requestHash: "r2",
      responseHash: "s2",
      executionGraphHash: "g2",
      modelId: "m",
      modelProvider: "p",
      riskTier: "low",
      kernelVersion: "0.1.0",
      previousEntryHash: rows[0].entry_hash,
      createdAt: rows[1].created_at,
    });
    rows[0].request_hash = "tampered";
    const last = v1.verifyFromLedgerExport(rows, "b");
    expect(last.valid).toBe(true);
  });
});

describe("V2 verification (converted V1 expected failures)", () => {
  it("walks the full organization chain and detects a mutated middle entry", async () => {
    const { organizationId } = await seededChain();
    const bundle = await exportOrganizationEvidence(pool, organizationId);
    expect(verifyEvidenceBundle(bundle).valid).toBe(true);
    bundle.ledger_entries[1].request_hash = "tampered";
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "ENTRY_HASH_MISMATCH")).toBe(true);
  });

  it("detects a mutated created_at_canonical without using Date reconstruction", async () => {
    const { organizationId } = await seededChain();
    const bundle = await exportOrganizationEvidence(pool, organizationId);
    bundle.ledger_entries[0].created_at_canonical = "1999-01-01T00:00:00.000Z";
    bundle.ledger_entries[0].created_at = "1999-01-01T00:00:00.000Z";
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "ENTRY_HASH_MISMATCH")).toBe(true);
  });

  it("detects a swapped Merkle sibling", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    for (let i = 0; i < 4; i++) {
      await appendLedgerEntry(pool, {
        organizationId,
        executionId: execution.id,
        entryType: i === 3 ? "final" : "request_opened",
        requestHash: contentHash(`req-${i}`),
        responseHash: i === 3 ? contentHash("res") : null,
        executionGraphHash: i === 3 ? contentHash("graph") : null,
        merkleSnapshotInterval: 4,
      });
    }
    const bundle = await exportOrganizationEvidence(pool, organizationId);
    expect(verifyEvidenceBundle(bundle).valid).toBe(true);
    const proof = bundle.ledger_entries[0].merkle_proof;
    expect(proof && proof.length > 0).toBe(true);
    if (proof && proof.length > 0) {
      proof[0] = {
        sibling_hash: proof[0].sibling_hash,
        position: proof[0].position === "left" ? "right" : "left",
      };
    }
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "MERKLE_PROOF_INVALID")).toBe(
      true
    );
  });

  it("verifies an offline export file without DATABASE_URL", async () => {
    const { organizationId } = await seededChain();
    const bundle = await exportOrganizationEvidence(pool, organizationId);
    const dir = mkdtempSync(join(tmpdir(), "verity-export-"));
    const file = join(dir, "bundle.json");
    writeFileSync(file, serializeEvidenceBundle(bundle));
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const result = verifyExportFile(file);
      expect(result.valid).toBe(true);
    } finally {
      if (previous !== undefined) {
        process.env.DATABASE_URL = previous;
      }
    }
    expect(bundle.manifest.includes_plaintext).toBe(false);
  });

  it("persists created_at_canonical as the hashed timestamp", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    const canonical = "2026-09-14T20:00:00.123Z";
    const row = await appendLedgerEntry(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "request_opened",
      requestHash: contentHash("req"),
      responseHash: null,
      executionGraphHash: null,
      createdAtCanonical: canonical,
    });
    expect(row.created_at_canonical).toBe(canonical);
    const expected = computeEntryHash(
      buildHashPayload({
        organizationId,
        ledgerSequence: 1,
        executionId: execution.id,
        entryType: "request_opened",
        requestHash: contentHash("req"),
        responseHash: null,
        executionGraphHash: null,
        previousEntryHash: null,
        kernelVersion: row.kernel_version,
        createdAtCanonical: canonical,
      })
    );
    expect(row.entry_hash).toBe(expected);
    const fromDb = await getLedgerEntries(pool, organizationId);
    expect(fromDb[0].created_at_canonical).toBe(canonical);
    expect(fromDb[0].created_at.toISOString()).toBe(canonical);
  });
});
