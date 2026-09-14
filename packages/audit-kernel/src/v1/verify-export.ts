/**
 * V1 characterization copy from
 * salutethegenius/VerityOS-Sovereign-Audit-Kernel@a18419c66002648224f3def6291b7ed2caa90997
 *
 * Known defect: reconstructs created_at through Date#toISOString and only
 * checks a single entry, not the full chain.
 */
import { computeEntryHash, type ChainInput } from "./ledger/hash.js";

export interface LedgerRowExport {
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
  created_at: string;
}

export interface VerifyExportResult {
  valid: boolean;
  reason?: string;
  merkle_root?: string | null;
}

export function verifyFromLedgerExport(
  rows: LedgerRowExport[],
  auditId: string
): VerifyExportResult {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Ledger export must be a non-empty array of rows");
  }

  const index = rows.findIndex((r) => r.verity_audit_id === auditId);
  if (index < 0) {
    throw new Error(`Audit ID ${auditId} not found in ledger export`);
  }

  const entry = rows[index];
  const previousHash = index > 0 ? rows[index - 1].entry_hash : null;

  const chainInput: ChainInput = {
    verityAuditId: entry.verity_audit_id,
    requestHash: entry.request_hash,
    responseHash: entry.response_hash,
    executionGraphHash: entry.execution_graph_hash,
    modelId: entry.model_id,
    modelProvider: entry.model_provider,
    riskTier: entry.risk_tier,
    kernelVersion: entry.kernel_version,
    previousEntryHash: previousHash,
    createdAt: new Date(entry.created_at).toISOString(),
  };

  const recomputed = computeEntryHash(chainInput);
  const valid = recomputed === entry.entry_hash;

  return {
    valid,
    reason: valid ? undefined : "Recomputed entry_hash does not match stored",
    merkle_root: entry.merkle_root,
  };
}
