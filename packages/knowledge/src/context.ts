import type { Pool } from "pg";
import { KnowledgeError } from "./errors.js";

export interface ContextChunk {
  chunk_id: string;
  source_id: string;
  source_version_id: string;
  collection_id: string;
  text: string;
  content_hash: string;
  returned_to_caller: boolean;
}

export async function loadRetrievalRun(
  pool: Pool,
  input: { organizationId: string; retrievalRunId: string }
) {
  const result = await pool.query<{
    id: string;
    organization_id: string;
    execution_id: string | null;
    mode: string;
    insufficient_evidence: boolean;
    collection_ids: string[];
  }>(
    `SELECT id, organization_id, execution_id, mode, insufficient_evidence, collection_ids
     FROM knowledge.retrieval_runs
     WHERE id = $1 AND organization_id = $2`,
    [input.retrievalRunId, input.organizationId]
  );
  if (!result.rows[0]) {
    throw new KnowledgeError("NOT_FOUND", "retrieval run not found", 404);
  }
  return result.rows[0];
}

export async function loadReturnedChunks(
  pool: Pool,
  input: { organizationId: string; retrievalRunId: string; chunkIds: string[] }
): Promise<ContextChunk[]> {
  if (input.chunkIds.length === 0) {
    return [];
  }
  const result = await pool.query<ContextChunk>(
    `SELECT h.chunk_id, h.source_id, h.source_version_id, h.collection_id,
            c.text, h.content_hash, h.returned_to_caller
     FROM knowledge.retrieval_hits h
     JOIN knowledge.chunks c
       ON c.id = h.chunk_id AND c.organization_id = h.organization_id
     WHERE h.retrieval_run_id = $1
       AND h.organization_id = $2
       AND h.chunk_id = ANY($3::uuid[])
     ORDER BY h.rank ASC`,
    [input.retrievalRunId, input.organizationId, input.chunkIds]
  );
  return result.rows;
}

export async function markChunksIncludedInContext(
  pool: Pool,
  input: { organizationId: string; retrievalRunId: string; chunkIds: string[] }
): Promise<void> {
  if (input.chunkIds.length === 0) {
    return;
  }
  await pool.query(
    `UPDATE knowledge.retrieval_hits
     SET included_in_context = true
     WHERE organization_id = $1
       AND retrieval_run_id = $2
       AND chunk_id = ANY($3::uuid[])
       AND returned_to_caller = true`,
    [input.organizationId, input.retrievalRunId, input.chunkIds]
  );
}
