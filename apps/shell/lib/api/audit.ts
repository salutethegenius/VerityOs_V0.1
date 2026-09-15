import { api } from "./client";
import type { VerityRecordListItem, VerifyResult } from "./types";

export function listRecords() {
  return api<{ records: VerityRecordListItem[] }>("/v1/audit/records");
}

export function getRecord(id: string) {
  return api<{
    verity_record_id: string;
    execution_id: string;
    actor: string;
    skill: string | null;
    risk: string | null;
    status: string;
    policy_version: string | number | null;
    knowledge_provenance: Record<string, unknown> | null;
    model_provenance: Record<string, unknown> | null;
    approval_summary: Record<string, unknown> | null;
    connector_evidence: Record<string, unknown> | null;
    final_ledger_entry: Record<string, unknown> | null;
    integrity_status: string;
    provenance_status: string;
    execution_graph_hash: string | null;
  }>(`/v1/audit/records/${encodeURIComponent(id)}`);
}

export function getGraph(id: string) {
  return api<{
    graph: {
      nodes?: Array<{
        event_id?: string;
        event_type: string;
        status: string;
        occurred_at_canonical?: string;
        metadata?: Record<string, unknown>;
      }>;
    };
    execution_graph_hash: string;
  }>(`/v1/audit/records/${encodeURIComponent(id)}/graph`);
}

export function verifyRecord(id: string) {
  return api<VerifyResult>(`/v1/audit/records/${encodeURIComponent(id)}/verify`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function exportEvidence(): Promise<{ filename: string; json: string }> {
  const payload = await api<unknown>("/v1/audit/export");
  return {
    filename: "verity-organization-evidence.json",
    json: JSON.stringify(payload, null, 2),
  };
}
