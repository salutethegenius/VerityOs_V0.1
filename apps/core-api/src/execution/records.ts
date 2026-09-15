import type { Pool } from "pg";
import {
  buildExecutionGraphV2,
  computeExecutionGraphHash,
  getExecutionByRecord,
  listExecutionEvents,
  listExecutions,
} from "@verityos/audit-kernel";
import { ExecutionError, summarizeEvents } from "./service.js";

export async function listVerityRecords(pool: Pool, organizationId: string) {
  const executions = await listExecutions(pool, organizationId);
  const actorIds = [...new Set(executions.map((row) => row.actor_id).filter(Boolean))] as string[];
  const actors =
    actorIds.length === 0
      ? { rows: [] as Array<{ id: string; display_name: string; email: string }> }
      : await pool.query<{ id: string; display_name: string; email: string }>(
          `SELECT id, display_name, email FROM auth.users WHERE id = ANY($1::uuid[])`,
          [actorIds]
        );
  const byId = new Map(actors.rows.map((row) => [row.id, row]));
  return executions.map((row) => {
    const actor = row.actor_id ? byId.get(row.actor_id) : undefined;
    return {
      verity_record_id: row.verity_record_id,
      execution_id: row.id,
      actor_id: row.actor_id,
      actor_name: actor?.display_name ?? null,
      actor_email: actor?.email ?? null,
      skill_id: row.skill_id,
      risk_tier: row.risk_tier,
      status: row.status,
      policy_version: row.policy_version,
      started_at: row.started_at,
      completed_at: row.completed_at,
    };
  });
}

export async function getVerityRecord(
  pool: Pool,
  organizationId: string,
  verityRecordId: string
) {
  const execution = await getExecutionByRecord(pool, organizationId, verityRecordId);
  if (!execution) {
    throw new ExecutionError("NOT_FOUND", "verity record not found", 404);
  }
  const events = await listExecutionEvents(pool, organizationId, execution.id);
  const graph = events.length > 0 ? buildExecutionGraphV2(execution, events) : null;
  const graphHash = graph ? computeExecutionGraphHash(graph) : null;
  const ledger = await pool.query(
    `SELECT * FROM audit.ledger_entries
     WHERE organization_id = $1 AND execution_id = $2
     ORDER BY organization_sequence ASC`,
    [organizationId, execution.id]
  );
  const finalEntry = ledger.rows.find((row) => row.id === execution.final_entry_id) ?? null;
  const linked =
    Boolean(graphHash) &&
    Boolean(finalEntry?.execution_graph_hash) &&
    graphHash === finalEntry.execution_graph_hash;
  const summary = summarizeEvents(events);
  const actor =
    execution.actor_id
      ? await pool.query<{ display_name: string; email: string }>(
          `SELECT display_name, email FROM auth.users WHERE id = $1`,
          [execution.actor_id]
        )
      : { rows: [] };
  return {
    verity_record_id: execution.verity_record_id,
    execution_id: execution.id,
    actor: execution.actor_id,
    actor_name: actor.rows[0]?.display_name ?? null,
    actor_email: actor.rows[0]?.email ?? null,
    skill: execution.skill_id,
    risk: execution.risk_tier,
    status: execution.status,
    policy_version: execution.policy_version,
    knowledge_provenance: summary.knowledge,
    model_provenance: summary.model,
    approval_summary: summary.approval,
    connector_evidence: summary.tool,
    final_ledger_entry: finalEntry,
    integrity_status: "not_verified" as const,
    provenance_status: linked ? ("linked" as const) : graph ? ("unlinked" as const) : ("absent" as const),
    execution_graph_hash: graphHash,
  };
}

export async function getVerityGraph(
  pool: Pool,
  organizationId: string,
  verityRecordId: string
) {
  const execution = await getExecutionByRecord(pool, organizationId, verityRecordId);
  if (!execution) {
    throw new ExecutionError("NOT_FOUND", "verity record not found", 404);
  }
  const events = await listExecutionEvents(pool, organizationId, execution.id);
  const graph = buildExecutionGraphV2(execution, events);
  return {
    graph,
    execution_graph_hash: computeExecutionGraphHash(graph),
  };
}
