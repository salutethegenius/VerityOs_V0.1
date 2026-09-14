import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  DataClassification,
  KnowledgeHit,
  KnowledgeMode,
  KnowledgeRetrieveResponse,
} from "@verityos/contracts";
import { CLASSIFICATION_RANK } from "@verityos/contracts";
import { KnowledgeError } from "./errors.js";
import { embeddingProviderFromEnv, type EmbeddingProvider } from "./embed.js";
import { reciprocalRankFusion, sha256Text, vectorLiteral } from "./hashing.js";

interface Candidate {
  chunk_id: string;
  source_id: string;
  source_version_id: string;
  collection_id: string;
  title: string;
  page: number | null;
  section: string | null;
  text: string;
  content_hash: string;
  vector_score: number;
  keyword_score: number;
  retrieved: boolean;
  ranked: boolean;
}

export async function retrieve(
  pool: Pool,
  input: {
    organizationId: string;
    actorId: string;
    roleId: string;
    executionId: string | null;
    query: string;
    collectionIds: string[];
    mode: KnowledgeMode;
    topK: number;
    classificationCeiling: DataClassification;
  },
  provider: EmbeddingProvider = embeddingProviderFromEnv()
): Promise<KnowledgeRetrieveResponse> {
  const topK = Math.min(Math.max(input.topK, 1), 20);
  const collections = await pool.query<{ id: string; classification: DataClassification }>(
    `SELECT c.id, c.classification
     FROM knowledge.collections c
     JOIN knowledge.collection_permissions p
       ON p.collection_id = c.id
      AND p.organization_id = c.organization_id
      AND p.role_id = $2
      AND p.can_read = true
     WHERE c.organization_id = $1
       AND c.id = ANY($3::uuid[])`,
    [input.organizationId, input.roleId, input.collectionIds]
  );
  const allowedIds = collections.rows
    .filter(
      (c) => CLASSIFICATION_RANK[c.classification] <= CLASSIFICATION_RANK[input.classificationCeiling]
    )
    .map((c) => c.id);

  if (allowedIds.length === 0) {
    throw new KnowledgeError("COLLECTION_FORBIDDEN", "collection not found", 404);
  }

  const [queryEmbedding] = await provider.embed([input.query]);
  const queryVector = vectorLiteral(queryEmbedding);

  const vector = await pool.query<{
    chunk_id: string;
    source_id: string;
    source_version_id: string;
    collection_id: string;
    title: string;
    page_number: number | null;
    section: string | null;
    text: string;
    content_hash: string;
    vector_score: number;
  }>(
    `SELECT ch.id AS chunk_id, s.id AS source_id, sv.id AS source_version_id,
            s.collection_id, s.title, ch.page_number, ch.section, ch.text,
            sv.content_hash,
            1 - (ch.embedding <=> $1::vector) AS vector_score
     FROM knowledge.chunks ch
     JOIN knowledge.source_versions sv
       ON sv.id = ch.source_version_id AND sv.organization_id = ch.organization_id
     JOIN knowledge.sources s
       ON s.id = sv.source_id AND s.organization_id = sv.organization_id
     WHERE ch.organization_id = $2
       AND s.collection_id = ANY($3::uuid[])
       AND sv.approved_at IS NOT NULL
       AND ch.embedding_provider_key = $4
       AND ch.embedding_dimensions = $5
     ORDER BY ch.embedding <=> $1::vector
     LIMIT $6`,
    [queryVector, input.organizationId, allowedIds, provider.key, provider.dimensions, topK * 4]
  );

  const keyword = await pool.query<{
    chunk_id: string;
    source_id: string;
    source_version_id: string;
    collection_id: string;
    title: string;
    page_number: number | null;
    section: string | null;
    text: string;
    content_hash: string;
    keyword_score: number;
  }>(
    `SELECT ch.id AS chunk_id, s.id AS source_id, sv.id AS source_version_id,
            s.collection_id, s.title, ch.page_number, ch.section, ch.text,
            sv.content_hash,
            ts_rank(ch.tsv, plainto_tsquery('english', $1)) AS keyword_score
     FROM knowledge.chunks ch
     JOIN knowledge.source_versions sv
       ON sv.id = ch.source_version_id AND sv.organization_id = ch.organization_id
     JOIN knowledge.sources s
       ON s.id = sv.source_id AND s.organization_id = sv.organization_id
     WHERE ch.organization_id = $2
       AND s.collection_id = ANY($3::uuid[])
       AND sv.approved_at IS NOT NULL
       AND ch.embedding_provider_key = $4
       AND ch.embedding_dimensions = $5
       AND ch.tsv @@ plainto_tsquery('english', $1)
     ORDER BY keyword_score DESC
     LIMIT $6`,
    [input.query, input.organizationId, allowedIds, provider.key, provider.dimensions, topK * 4]
  );

  const byId = new Map<string, Candidate>();
  const add = (
    row: {
      chunk_id: string;
      source_id: string;
      source_version_id: string;
      collection_id: string;
      title: string;
      page_number: number | null;
      section: string | null;
      text: string;
      content_hash: string;
      vector_score?: number;
      keyword_score?: number;
    }
  ) => {
    const current = byId.get(row.chunk_id) ?? {
      chunk_id: row.chunk_id,
      source_id: row.source_id,
      source_version_id: row.source_version_id,
      collection_id: row.collection_id,
      title: row.title,
      page: row.page_number,
      section: row.section,
      text: row.text,
      content_hash: row.content_hash,
      vector_score: 0,
      keyword_score: 0,
      retrieved: true,
      ranked: false,
    };
    current.retrieved = true;
    if (row.vector_score != null) {
      current.vector_score = Number(row.vector_score);
    }
    if (row.keyword_score != null) {
      current.keyword_score = Number(row.keyword_score);
    }
    byId.set(row.chunk_id, current);
  };
  vector.rows.forEach(add);
  keyword.rows.forEach(add);

  const fused = reciprocalRankFusion([
    vector.rows.map((row, index) => ({ id: row.chunk_id, rank: index + 1 })),
    keyword.rows.map((row, index) => ({ id: row.chunk_id, rank: index + 1 })),
  ]);

  const ranked = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  for (const [id] of ranked) {
    const row = byId.get(id);
    if (row) {
      row.ranked = true;
    }
  }

  const hits: KnowledgeHit[] = ranked.map(([id, score], index) => {
    const row = byId.get(id)!;
    return {
      chunk_id: row.chunk_id,
      source_id: row.source_id,
      source_version_id: row.source_version_id,
      title: row.title,
      page: row.page,
      section: row.section,
      text: row.text,
      content_hash: row.content_hash,
      vector_score: row.vector_score,
      keyword_score: row.keyword_score,
      rerank_score: score,
      rank: index + 1,
    };
  });

  const insufficient = input.mode === "strict" && keyword.rows.length === 0;
  const returnedIds = new Set(insufficient ? [] : hits.map((hit) => hit.chunk_id));
  return persistRun(pool, input, insufficient, hits, byId, ranked, returnedIds, provider);
}

async function persistRun(
  pool: Pool,
  input: {
    organizationId: string;
    actorId: string;
    executionId: string | null;
    query: string;
    collectionIds: string[];
    mode: KnowledgeMode;
    classificationCeiling: DataClassification;
  },
  insufficient: boolean,
  hits: KnowledgeHit[],
  candidates: Map<string, Candidate>,
  ranked: Array<[string, number]>,
  returnedIds: Set<string>,
  provider: EmbeddingProvider
): Promise<KnowledgeRetrieveResponse> {
  const runId = randomUUID();
  const queryHash = sha256Text(input.query);
  await pool.query(
    `INSERT INTO knowledge.retrieval_runs (
       id, organization_id, execution_id, actor_id, query, query_hash, mode,
       collection_ids, classification_ceiling, insufficient_evidence,
       embedding_provider_key, embedding_dimensions
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      runId,
      input.organizationId,
      input.executionId,
      input.actorId,
      input.query,
      queryHash,
      input.mode,
      input.collectionIds,
      input.classificationCeiling,
      insufficient,
      provider.key,
      provider.dimensions,
    ]
  );

  const rankedIndex = new Map(ranked.map(([id], index) => [id, index + 1]));
  let retrievedOnly = 0;
  for (const candidate of candidates.values()) {
    const returned = returnedIds.has(candidate.chunk_id);
    const rank = rankedIndex.get(candidate.chunk_id) ?? 10000 + retrievedOnly;
    if (!rankedIndex.has(candidate.chunk_id)) {
      retrievedOnly += 1;
    }
    await pool.query(
      `INSERT INTO knowledge.retrieval_hits (
         id, retrieval_run_id, organization_id, chunk_id, source_id, source_version_id,
         collection_id, content_hash, rank, vector_score, keyword_score, rerank_score,
         included_in_context, retrieved, ranked, returned_to_caller
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        randomUUID(),
        runId,
        input.organizationId,
        candidate.chunk_id,
        candidate.source_id,
        candidate.source_version_id,
        candidate.collection_id,
        candidate.content_hash,
        rank,
        candidate.vector_score,
        candidate.keyword_score,
        rankedIndex.has(candidate.chunk_id)
          ? ranked.find(([id]) => id === candidate.chunk_id)?.[1] ?? null
          : null,
        false,
        candidate.retrieved,
        candidate.ranked,
        returned,
      ]
    );
  }

  return {
    retrieval_run_id: runId,
    mode: input.mode,
    insufficient_evidence: insufficient,
    hits: insufficient ? [] : hits,
  };
}
