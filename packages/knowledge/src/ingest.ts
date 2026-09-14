import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { DataClassification } from "@verityos/contracts";
import { extractText } from "./extract.js";
import { chunkText, embedText, sha256Bytes, sha256Text, vectorLiteral } from "./hashing.js";
import {
  PARSER_VERSION,
  assertUpload,
  sniffMime,
  writeBlob,
} from "./storage.js";

export async function createCollection(
  pool: Pool,
  input: {
    organizationId: string;
    name: string;
    classification: DataClassification;
    createdBy: string;
    adminRoleId: string;
    memberRoleId: string;
  }
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO knowledge.collections (id, organization_id, name, classification, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.organizationId, input.name, input.classification, input.createdBy]
  );
  await pool.query(
    `INSERT INTO knowledge.collection_permissions (
       id, collection_id, organization_id, role_id, can_read, can_manage, can_approve
     ) VALUES
       ($1, $2, $3, $4, true, true, true),
       ($5, $2, $3, $6, true, false, false)`,
    [randomUUID(), id, input.organizationId, input.adminRoleId, randomUUID(), input.memberRoleId]
  );
  return id;
}

export async function uploadSourceVersion(
  pool: Pool,
  input: {
    organizationId: string;
    collectionId: string;
    actorId: string;
    title: string;
    filename: string;
    bytes: Buffer;
    sourceId?: string;
  }
): Promise<{ sourceId: string; versionId: string; contentHash: string; versionNumber: number }> {
  const mime = sniffMime(input.filename, input.bytes);
  assertUpload(input.bytes, mime);
  const contentHash = sha256Bytes(input.bytes);
  const collection = await pool.query<{ organization_id: string }>(
    `SELECT organization_id FROM knowledge.collections WHERE id = $1`,
    [input.collectionId]
  );
  if (!collection.rows[0] || collection.rows[0].organization_id !== input.organizationId) {
    throw new Error("collection not found");
  }

  const sourceId = input.sourceId ?? randomUUID();
  const versionId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!input.sourceId) {
      await client.query(
        `INSERT INTO knowledge.sources (id, organization_id, collection_id, title, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [sourceId, input.organizationId, input.collectionId, input.title, input.actorId]
      );
    } else {
      const existing = await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM knowledge.sources WHERE id = $1`,
        [sourceId]
      );
      if (!existing.rows[0] || existing.rows[0].organization_id !== input.organizationId) {
        throw new Error("source not found");
      }
    }
    const last = await client.query<{ version_number: number }>(
      `SELECT version_number FROM knowledge.source_versions
       WHERE source_id = $1 ORDER BY version_number DESC LIMIT 1
       FOR UPDATE`,
      [sourceId]
    );
    const versionNumber = (last.rows[0]?.version_number ?? 0) + 1;
    const blobUri = await writeBlob(input.organizationId, versionId, input.bytes);
    await client.query(
      `INSERT INTO knowledge.source_versions (
         id, organization_id, source_id, version_number, content_hash, mime_type,
         blob_uri, original_filename, parser_version, effective_at, uploaded_by, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, now())`,
      [
        versionId,
        input.organizationId,
        sourceId,
        versionNumber,
        contentHash,
        mime,
        blobUri,
        input.filename,
        PARSER_VERSION,
        input.actorId,
      ]
    );
    await client.query("COMMIT");
    return { sourceId, versionId, contentHash, versionNumber };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function approveSourceVersion(
  pool: Pool,
  input: { organizationId: string; versionId: string; actorId: string }
): Promise<void> {
  const result = await pool.query(
    `UPDATE knowledge.source_versions
     SET approved_by = $3, approved_at = now()
     WHERE id = $1 AND organization_id = $2 AND approved_at IS NULL`,
    [input.versionId, input.organizationId, input.actorId]
  );
  if (result.rowCount !== 1) {
    throw new Error("version not found or already approved");
  }
}

export async function indexSourceVersion(
  pool: Pool,
  input: { organizationId: string; versionId: string }
): Promise<{ chunkCount: number }> {
  const version = await pool.query<{
    id: string;
    organization_id: string;
    blob_uri: string;
    mime_type: string;
    content_hash: string;
  }>(
    `SELECT id, organization_id, blob_uri, mime_type, content_hash
     FROM knowledge.source_versions WHERE id = $1`,
    [input.versionId]
  );
  const row = version.rows[0];
  if (!row || row.organization_id !== input.organizationId) {
    throw new Error("version not found");
  }
  const existing = await pool.query(
    `SELECT 1 FROM knowledge.chunks WHERE source_version_id = $1 LIMIT 1`,
    [input.versionId]
  );
  if (existing.rows.length > 0) {
    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM knowledge.chunks WHERE source_version_id = $1`,
      [input.versionId]
    );
    return { chunkCount: Number(count.rows[0].n) };
  }

  const { readBlob } = await import("./storage.js");
  const bytes = await readBlob(row.blob_uri);
  if (sha256Bytes(bytes) !== row.content_hash) {
    throw new Error("blob content hash mismatch");
  }
  const text = await extractText(row.mime_type, bytes);
  const chunks = chunkText(text);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const chunk of chunks) {
      const embedding = embedText(chunk.text);
      await client.query(
        `INSERT INTO knowledge.chunks (
           id, organization_id, source_version_id, chunk_index, page_number, section,
           text, text_hash, token_count, embedding, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11::jsonb)`,
        [
          randomUUID(),
          input.organizationId,
          input.versionId,
          chunk.chunkIndex,
          chunk.pageNumber,
          chunk.section,
          chunk.text,
          chunk.textHash,
          chunk.tokenCount,
          vectorLiteral(embedding),
          JSON.stringify({ parser_version: PARSER_VERSION, content_hash: row.content_hash }),
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { chunkCount: chunks.length };
}

export { sha256Text };
