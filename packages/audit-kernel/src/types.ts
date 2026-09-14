import type { ExecutionStatus, LedgerEntryType, RiskTier } from "@verityos/contracts";
import type { MerkleProofStep } from "./merkle/merkle.js";

export interface LedgerEntryRow {
  id: string;
  organization_id: string;
  organization_sequence: number;
  execution_id: string;
  entry_type: LedgerEntryType;
  request_hash: string | null;
  response_hash: string | null;
  execution_graph_hash: string | null;
  previous_entry_hash: string | null;
  entry_hash: string;
  merkle_root: string | null;
  kernel_version: string;
  hash_format_version: string;
  created_at: Date;
  created_at_canonical: string;
}

export interface ExecutionRow {
  id: string;
  verity_record_id: string;
  organization_id: string;
  actor_id: string | null;
  session_id: string | null;
  skill_id: string | null;
  status: ExecutionStatus;
  risk_tier: RiskTier;
  policy_version: string | null;
  retention_mode: string | null;
  started_at: Date;
  completed_at: Date | null;
  final_entry_id: string | null;
}

export interface MerkleCheckpointRow {
  id: string;
  organization_id: string;
  from_sequence: number;
  through_sequence: number;
  root: string;
  leaf_hashes: string[];
  created_at: Date;
}

export interface EvidenceBundle {
  manifest: {
    format_version: "1.0";
    hash_format_version: "2";
    kernel_version: string;
    organization_id: string;
    exported_at: string;
    entry_count: number;
    includes_plaintext: false;
    execution_graph_schema_version?: string;
  };
  ledger_entries: Array<
    Omit<LedgerEntryRow, "created_at"> & {
      created_at: string;
      merkle_proof?: MerkleProofStep[];
    }
  >;
  executions: Array<
    Omit<ExecutionRow, "started_at" | "completed_at"> & {
      started_at: string;
      completed_at: string | null;
    }
  >;
  merkle_checkpoints: Array<
    Omit<MerkleCheckpointRow, "created_at"> & { created_at: string }
  >;
  execution_events?: Array<{
    id: string;
    organization_id: string;
    execution_id: string;
    event_sequence: number;
    event_type: string;
    status: string;
    parent_event_ids: string[];
    input_hash: string | null;
    output_hash: string | null;
    metadata: Record<string, unknown>;
    occurred_at_canonical: string;
  }>;
  execution_graphs?: Array<{
    schema_version: string;
    execution_id: string;
    verity_record_id: string;
    organization_id: string;
    status: string;
    graph_hash: string;
    graph: unknown;
  }>;
}

export interface VerifyIssue {
  code: string;
  message: string;
  sequence?: number;
  entry_hash?: string;
}

export interface VerifyResult {
  valid: boolean;
  issues: VerifyIssue[];
}
