import type { Pool } from "pg";
import { KERNEL_VERSION, canonicalTimestampNow } from "../hashing/hash.js";
import { getMerkleProof } from "../merkle/merkle.js";
import type { EvidenceBundle, ExecutionRow, LedgerEntryRow } from "../types.js";
import { getLedgerEntries, getMerkleCheckpoints } from "../ledger/append.js";

export async function exportOrganizationEvidence(
  pool: Pool,
  organizationId: string
): Promise<EvidenceBundle> {
  const [entries, checkpoints, executions] = await Promise.all([
    getLedgerEntries(pool, organizationId),
    getMerkleCheckpoints(pool, organizationId),
    pool.query<ExecutionRow>(
      `SELECT * FROM audit.executions
       WHERE organization_id = $1
       ORDER BY started_at ASC`,
      [organizationId]
    ),
  ]);

  return {
    manifest: {
      format_version: "1.0",
      hash_format_version: "2",
      kernel_version: KERNEL_VERSION,
      organization_id: organizationId,
      exported_at: canonicalTimestampNow(),
      entry_count: entries.length,
      includes_plaintext: false,
    },
    ledger_entries: entries.map((entry) => {
      const checkpoint = checkpoints.find(
        (c) =>
          entry.organization_sequence >= c.from_sequence &&
          entry.organization_sequence <= c.through_sequence
      );
      const exported: EvidenceBundle["ledger_entries"][number] = {
        ...entry,
        created_at: entry.created_at_canonical,
      };
      if (checkpoint) {
        const index = entry.organization_sequence - checkpoint.from_sequence;
        exported.merkle_proof = getMerkleProof(checkpoint.leaf_hashes, index).proof;
      }
      return exported;
    }),
    executions: executions.rows.map((row) => ({
      ...row,
      started_at:
        row.started_at instanceof Date
          ? row.started_at.toISOString()
          : String(row.started_at),
      completed_at:
        row.completed_at instanceof Date
          ? row.completed_at.toISOString()
          : row.completed_at,
    })),
    merkle_checkpoints: checkpoints.map((row) => ({
      ...row,
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    })),
  };
}

export function serializeEvidenceBundle(bundle: EvidenceBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function ledgerRowToExport(
  entry: LedgerEntryRow
): EvidenceBundle["ledger_entries"][number] {
  return {
    ...entry,
    created_at: entry.created_at_canonical,
  };
}
