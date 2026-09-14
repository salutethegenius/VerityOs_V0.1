/**
 * V1 characterization copy from
 * salutethegenius/VerityOS-Sovereign-Audit-Kernel@a18419c66002648224f3def6291b7ed2caa90997
 * Do not use for new ledger writes.
 *
 * Known defect: SELECT latest then INSERT is not transactional. Concurrent
 * callers can share previous_entry_hash and fork the chain.
 */
import type { Pool } from "pg";
import { randomUUID } from "crypto";
import { computeEntryHash, type ChainInput } from "./hash.js";
import { computeMerkleRoot } from "./merkle.js";

export interface AppendEntryInput {
  requestHash: string;
  responseHash: string;
  executionGraphHash: string;
  modelId: string;
  modelProvider: string;
  riskTier: string;
  kernelVersion: string;
  merkleRoot?: string | null;
  merkleSnapshotInterval?: number;
  /** Test-only hook to force interleaving between SELECT and INSERT. */
  yieldAfterRead?: () => Promise<void>;
}

export interface LedgerRow {
  id: string;
  verity_audit_id: string;
  request_hash: string;
  response_hash: string;
  execution_graph_hash: string;
  model_id: string;
  model_provider: string;
  risk_tier: string;
  kernel_version: string;
  previous_entry_hash: string | null;
  entry_hash: string;
  merkle_root: string | null;
  created_at: Date;
}

export async function appendLedgerEntry(
  pool: Pool,
  input: AppendEntryInput
): Promise<{ verityAuditId: string; entryHash: string; createdAt: Date }> {
  const verityAuditId = randomUUID();
  const id = randomUUID();
  const createdAt = new Date();
  const createdAtStr = createdAt.toISOString();

  const prevResult = await pool.query<{ entry_hash: string }>(
    "SELECT entry_hash FROM audit_ledger_v1 ORDER BY created_at DESC LIMIT 1"
  );
  const previousEntryHash = prevResult.rows[0]?.entry_hash ?? null;

  if (input.yieldAfterRead) {
    await input.yieldAfterRead();
  }

  const chainInput: ChainInput = {
    verityAuditId,
    requestHash: input.requestHash,
    responseHash: input.responseHash,
    executionGraphHash: input.executionGraphHash,
    modelId: input.modelId,
    modelProvider: input.modelProvider,
    riskTier: input.riskTier,
    kernelVersion: input.kernelVersion,
    previousEntryHash,
    createdAt: createdAtStr,
  };
  const entryHash = computeEntryHash(chainInput);

  let merkleRoot = input.merkleRoot ?? null;
  if (input.merkleSnapshotInterval != null && input.merkleSnapshotInterval > 0) {
    const countResult = await pool.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM audit_ledger_v1"
    );
    const count = countResult.rows[0]?.c ?? 0;
    if ((count + 1) % input.merkleSnapshotInterval === 0) {
      const recent = await pool.query<{ entry_hash: string }>(
        "SELECT entry_hash FROM audit_ledger_v1 ORDER BY created_at DESC LIMIT $1",
        [input.merkleSnapshotInterval - 1]
      );
      const hashes = recent.rows.map((r) => r.entry_hash).reverse();
      merkleRoot = computeMerkleRoot([...hashes, entryHash]);
    }
  }

  await pool.query(
    `INSERT INTO audit_ledger_v1 (
      id, verity_audit_id, request_hash, response_hash, execution_graph_hash,
      model_id, model_provider, risk_tier, kernel_version,
      previous_entry_hash, entry_hash, merkle_root, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      verityAuditId,
      input.requestHash,
      input.responseHash,
      input.executionGraphHash,
      input.modelId,
      input.modelProvider,
      input.riskTier,
      input.kernelVersion,
      previousEntryHash,
      entryHash,
      merkleRoot,
      createdAt,
    ]
  );

  return { verityAuditId, entryHash, createdAt };
}

export async function getLedgerRows(pool: Pool, limit = 1000): Promise<LedgerRow[]> {
  const result = await pool.query<LedgerRow>(
    "SELECT * FROM audit_ledger_v1 ORDER BY created_at ASC LIMIT $1",
    [limit]
  );
  return result.rows;
}
