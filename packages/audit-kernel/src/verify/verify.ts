import { readFileSync } from "node:fs";
import {
  HASH_FORMAT_VERSION,
  buildHashPayload,
  computeEntryHash,
} from "../hashing/hash.js";
import { computeMerkleRoot, verifyMerkleProof } from "../merkle/merkle.js";
import type { EvidenceBundle, VerifyIssue, VerifyResult } from "../types.js";
import {
  buildExecutionGraphV2,
  computeExecutionGraphHash,
} from "../execution/graph-v2.js";
import type { ExecutionEventRow } from "../execution/events.js";

export function verifyLedgerEntry(
  entry: EvidenceBundle["ledger_entries"][number],
  previousEntryHash: string | null
): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const payload = buildHashPayload({
    organizationId: entry.organization_id,
    ledgerSequence: entry.organization_sequence,
    executionId: entry.execution_id,
    entryType: entry.entry_type,
    requestHash: entry.request_hash,
    responseHash: entry.response_hash,
    executionGraphHash: entry.execution_graph_hash,
    previousEntryHash: entry.previous_entry_hash,
    kernelVersion: entry.kernel_version,
    createdAtCanonical: entry.created_at_canonical,
  });

  const recomputed = computeEntryHash(payload);
  if (recomputed !== entry.entry_hash) {
    issues.push({
      code: "ENTRY_HASH_MISMATCH",
      message: "Recomputed entry_hash does not match stored entry_hash",
      sequence: entry.organization_sequence,
      entry_hash: entry.entry_hash,
    });
  }

  if (entry.hash_format_version !== HASH_FORMAT_VERSION) {
    issues.push({
      code: "HASH_FORMAT",
      message: `Unsupported hash_format_version ${entry.hash_format_version}`,
      sequence: entry.organization_sequence,
    });
  }

  if (entry.previous_entry_hash !== previousEntryHash) {
    issues.push({
      code: "PREVIOUS_HASH_MISMATCH",
      message: "previous_entry_hash does not match the prior entry",
      sequence: entry.organization_sequence,
    });
  }

  if (entry.created_at !== entry.created_at_canonical) {
    issues.push({
      code: "CANONICAL_TIMESTAMP_DRIFT",
      message: "created_at in the bundle is not the hashed created_at_canonical string",
      sequence: entry.organization_sequence,
    });
  }

  return issues;
}

export function verifyOrganizationChain(
  entries: EvidenceBundle["ledger_entries"]
): VerifyResult {
  const issues: VerifyIssue[] = [];
  if (entries.length === 0) {
    return { valid: true, issues };
  }

  const sorted = [...entries].sort(
    (a, b) => a.organization_sequence - b.organization_sequence
  );

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const expectedSequence = i === 0 ? entry.organization_sequence : sorted[i - 1].organization_sequence + 1;
    if (entry.organization_sequence !== expectedSequence && i > 0) {
      issues.push({
        code: "SEQUENCE_GAP",
        message: `Expected sequence ${expectedSequence}, found ${entry.organization_sequence}`,
        sequence: entry.organization_sequence,
      });
    }
    if (i === 0 && entry.organization_sequence !== 1) {
      issues.push({
        code: "SEQUENCE_START",
        message: "First entry must have organization_sequence = 1",
        sequence: entry.organization_sequence,
      });
    }
    const previous = i === 0 ? null : sorted[i - 1].entry_hash;
    issues.push(...verifyLedgerEntry(entry, previous));
  }

  return { valid: issues.length === 0, issues };
}

export function verifyMerkleCheckpoints(bundle: EvidenceBundle): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const bySequence = new Map(
    bundle.ledger_entries.map((e) => [e.organization_sequence, e] as const)
  );

  for (const checkpoint of bundle.merkle_checkpoints) {
    const recomputed = computeMerkleRoot(checkpoint.leaf_hashes);
    if (recomputed !== checkpoint.root) {
      issues.push({
        code: "MERKLE_ROOT_MISMATCH",
        message: `Checkpoint through sequence ${checkpoint.through_sequence} has an incorrect root`,
        sequence: checkpoint.through_sequence,
      });
    }

    for (let i = 0; i < checkpoint.leaf_hashes.length; i++) {
      const sequence = checkpoint.from_sequence + i;
      const entry = bySequence.get(sequence);
      if (!entry) {
        issues.push({
          code: "MERKLE_LEAF_MISSING",
          message: `Checkpoint leaf for sequence ${sequence} is missing from the export`,
          sequence,
        });
        continue;
      }
      if (entry.entry_hash !== checkpoint.leaf_hashes[i]) {
        issues.push({
          code: "MERKLE_LEAF_MISMATCH",
          message: `Checkpoint leaf does not match ledger entry at sequence ${sequence}`,
          sequence,
        });
      }
      if (entry.merkle_proof) {
        const ok = verifyMerkleProof(
          entry.entry_hash,
          entry.merkle_proof,
          checkpoint.root
        );
        if (!ok) {
          issues.push({
            code: "MERKLE_PROOF_INVALID",
            message: `Merkle proof failed for sequence ${sequence}`,
            sequence,
            entry_hash: entry.entry_hash,
          });
        }
      }
    }
  }

  return issues;
}

export function verifyEvidenceBundle(bundle: EvidenceBundle): VerifyResult {
  const issues: VerifyIssue[] = [];
  if (bundle.manifest.includes_plaintext !== false) {
    issues.push({
      code: "PLAINTEXT_EXPORT",
      message: "Evidence export must not include confidential plaintext",
    });
  }
  if (bundle.manifest.organization_id) {
    for (const entry of bundle.ledger_entries) {
      if (entry.organization_id !== bundle.manifest.organization_id) {
        issues.push({
          code: "ORG_MISMATCH",
          message: "Ledger entry organization_id does not match the manifest",
          sequence: entry.organization_sequence,
        });
      }
    }
  }
  const chain = verifyOrganizationChain(bundle.ledger_entries);
  issues.push(...chain.issues);
  issues.push(...verifyMerkleCheckpoints(bundle));
  issues.push(...verifyExecutionGraphs(bundle));
  return { valid: issues.length === 0, issues };
}

export function verifyExecutionGraphs(bundle: EvidenceBundle): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const events = bundle.execution_events ?? [];
  const graphs = bundle.execution_graphs ?? [];
  if (events.length === 0 && graphs.length === 0) {
    return issues;
  }
  const executions = new Map(bundle.executions.map((row) => [row.id, row]));
  for (const graphExport of graphs) {
    const execution = executions.get(graphExport.execution_id);
    if (!execution || execution.organization_id !== bundle.manifest.organization_id) {
      issues.push({
        code: "GRAPH_ORG_MISMATCH",
        message: "Execution graph does not belong to the exported organization",
      });
      continue;
    }
    const related = events
      .filter((event) => event.execution_id === graphExport.execution_id)
      .map(
        (event): ExecutionEventRow => ({
          id: event.id,
          organization_id: event.organization_id,
          execution_id: event.execution_id,
          event_sequence: event.event_sequence,
          event_type: event.event_type as ExecutionEventRow["event_type"],
          status: event.status,
          parent_event_ids: event.parent_event_ids,
          input_hash: event.input_hash,
          output_hash: event.output_hash,
          metadata: event.metadata,
          occurred_at: new Date(event.occurred_at_canonical),
          occurred_at_canonical: event.occurred_at_canonical,
          created_at: new Date(event.occurred_at_canonical),
        })
      );
    const reconstructed = buildExecutionGraphV2(execution, related);
    const recomputed = computeExecutionGraphHash(reconstructed);
    if (recomputed !== graphExport.graph_hash) {
      issues.push({
        code: "GRAPH_HASH_MISMATCH",
        message: "Recomputed execution_graph_hash does not match the export",
      });
    }
    if (graphExport.graph && typeof graphExport.graph === "object") {
      const embeddedHash = computeExecutionGraphHash(
        graphExport.graph as Parameters<typeof computeExecutionGraphHash>[0]
      );
      if (embeddedHash !== graphExport.graph_hash || embeddedHash !== recomputed) {
        issues.push({
          code: "GRAPH_EVIDENCE_MISMATCH",
          message: "Embedded Execution Graph V2 does not match reconstructed events",
        });
      }
    }
    const finalEntry = bundle.ledger_entries
      .filter(
        (entry) =>
          entry.execution_id === graphExport.execution_id &&
          (entry.entry_type === "final" || entry.entry_type === "failure")
      )
      .sort((a, b) => b.organization_sequence - a.organization_sequence)[0];
    if (finalEntry?.execution_graph_hash && finalEntry.execution_graph_hash !== recomputed) {
      issues.push({
        code: "GRAPH_LEDGER_MISMATCH",
        message: "Ledger execution_graph_hash does not match reconstructed graph",
        sequence: finalEntry.organization_sequence,
        entry_hash: finalEntry.entry_hash,
      });
    }
  }
  return issues;
}

export function verifyExportFile(bundlePath: string): VerifyResult {
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as EvidenceBundle;
  return verifyEvidenceBundle(bundle);
}
