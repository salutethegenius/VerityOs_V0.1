import type { Pool } from "pg";
import { KnowledgeError } from "./errors.js";

export interface CollectionPermission {
  collectionId: string;
  can_read: boolean;
  can_manage: boolean;
  can_approve: boolean;
}

export type CollectionCapability = "can_read" | "can_manage" | "can_approve";

export function canRead(permission: CollectionPermission | null | undefined): boolean {
  return permission?.can_read === true;
}

export function canManage(permission: CollectionPermission | null | undefined): boolean {
  return permission?.can_manage === true;
}

export function canApprove(permission: CollectionPermission | null | undefined): boolean {
  return permission?.can_approve === true;
}

export async function getCollectionPermission(
  pool: Pool,
  input: { organizationId: string; collectionId: string; roleId: string }
): Promise<CollectionPermission | null> {
  const result = await pool.query<{
    id: string;
    can_read: boolean | null;
    can_manage: boolean | null;
    can_approve: boolean | null;
  }>(
    `SELECT c.id,
            p.can_read,
            p.can_manage,
            p.can_approve
     FROM knowledge.collections c
     LEFT JOIN knowledge.collection_permissions p
       ON p.collection_id = c.id
      AND p.organization_id = c.organization_id
      AND p.role_id = $3
     WHERE c.organization_id = $1 AND c.id = $2`,
    [input.organizationId, input.collectionId, input.roleId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    collectionId: row.id,
    can_read: row.can_read === true,
    can_manage: row.can_manage === true,
    can_approve: row.can_approve === true,
  };
}

export async function requireCollectionPermission(
  pool: Pool,
  input: {
    organizationId: string;
    collectionId: string;
    roleId: string;
    capability: CollectionCapability;
  }
): Promise<CollectionPermission> {
  const permission = await getCollectionPermission(pool, input);
  if (!permission || !permission[input.capability]) {
    throw new KnowledgeError("COLLECTION_FORBIDDEN", "collection not found", 404);
  }
  return permission;
}

export async function listReadableCollections(
  pool: Pool,
  input: { organizationId: string; roleId: string }
) {
  const result = await pool.query(
    `SELECT c.id, c.name, c.classification, c.created_at
     FROM knowledge.collections c
     JOIN knowledge.collection_permissions p
       ON p.collection_id = c.id
      AND p.organization_id = c.organization_id
      AND p.role_id = $2
      AND p.can_read = true
     WHERE c.organization_id = $1
     ORDER BY c.name`,
    [input.organizationId, input.roleId]
  );
  return result.rows;
}

export async function collectionIdForSource(
  pool: Pool,
  input: { organizationId: string; sourceId: string }
): Promise<string> {
  const result = await pool.query<{ collection_id: string }>(
    `SELECT collection_id FROM knowledge.sources
     WHERE id = $1 AND organization_id = $2`,
    [input.sourceId, input.organizationId]
  );
  if (!result.rows[0]) {
    throw new KnowledgeError("NOT_FOUND", "source not found", 404);
  }
  return result.rows[0].collection_id;
}

export async function collectionIdForVersion(
  pool: Pool,
  input: { organizationId: string; versionId: string }
): Promise<string> {
  const result = await pool.query<{ collection_id: string }>(
    `SELECT s.collection_id
     FROM knowledge.source_versions sv
     JOIN knowledge.sources s
       ON s.id = sv.source_id AND s.organization_id = sv.organization_id
     WHERE sv.id = $1 AND sv.organization_id = $2`,
    [input.versionId, input.organizationId]
  );
  if (!result.rows[0]) {
    throw new KnowledgeError("NOT_FOUND", "version not found", 404);
  }
  return result.rows[0].collection_id;
}

export async function collectionIdsForRetrievalRun(
  pool: Pool,
  input: { organizationId: string; runId: string }
): Promise<string[]> {
  const result = await pool.query<{ collection_ids: string[] }>(
    `SELECT collection_ids FROM knowledge.retrieval_runs
     WHERE id = $1 AND organization_id = $2`,
    [input.runId, input.organizationId]
  );
  if (!result.rows[0]) {
    throw new KnowledgeError("NOT_FOUND", "retrieval run not found", 404);
  }
  return result.rows[0].collection_ids;
}
