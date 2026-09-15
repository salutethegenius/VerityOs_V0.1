import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganization } from "@verityos/identity";
import { seedDefaultCommand } from "@verityos/command";
import { createPool } from "./helpers.js";

const pool = createPool();

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

async function twoOrgs() {
  const a = await createOrganization(pool, {
    name: `Tenant A ${randomUUID().slice(0, 8)}`,
    adminEmail: `a-${randomUUID().slice(0, 8)}@example.test`,
    adminPassword: "correct-horse-battery",
  });
  const b = await createOrganization(pool, {
    name: `Tenant B ${randomUUID().slice(0, 8)}`,
    adminEmail: `b-${randomUUID().slice(0, 8)}@example.test`,
    adminPassword: "correct-horse-battery",
  });
  await seedDefaultCommand(pool, {
    organizationId: a.organizationId,
    adminRoleId: a.adminRoleId,
    memberRoleId: a.memberRoleId,
  });
  await seedDefaultCommand(pool, {
    organizationId: b.organizationId,
    adminRoleId: b.adminRoleId,
    memberRoleId: b.memberRoleId,
  });
  return { a, b };
}

async function expectFk(sql: string, params: unknown[]) {
  await expect(pool.query(sql, params)).rejects.toMatchObject({ code: "23503" });
}

describe("composite tenant foreign keys", () => {
  it("rejects cross-organization memberships, policies, and knowledge links", async () => {
    const { a, b } = await twoOrgs();

    await expectFk(
      `INSERT INTO auth.memberships (id, organization_id, user_id, role_id)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), a.organizationId, b.adminUserId, b.adminRoleId]
    );

    const policyB = await pool.query<{ id: string }>(
      `SELECT id FROM command.policies WHERE organization_id = $1`,
      [b.organizationId]
    );
    await expectFk(
      `INSERT INTO command.policy_bindings (id, organization_id, policy_id, skill_id)
       VALUES ($1, $2, $3, 'knowledge.retrieve')`,
      [randomUUID(), a.organizationId, policyB.rows[0].id]
    );

    const skillA = await pool.query<{ id: string }>(
      `SELECT id FROM command.skill_policies WHERE organization_id = $1 LIMIT 1`,
      [a.organizationId]
    );
    await expectFk(
      `INSERT INTO command.skill_policy_roles (skill_policy_id, role_id, organization_id)
       VALUES ($1, $2, $3)`,
      [skillA.rows[0].id, b.memberRoleId, a.organizationId]
    );

    const collectionA = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.collections (id, organization_id, name, classification, created_by)
       VALUES ($1, $2, 'A docs', 'internal', $3)`,
      [collectionA, a.organizationId, a.adminUserId]
    );
    const collectionB = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.collections (id, organization_id, name, classification, created_by)
       VALUES ($1, $2, 'B docs', 'internal', $3)`,
      [collectionB, b.organizationId, b.adminUserId]
    );

    await expectFk(
      `INSERT INTO knowledge.collection_permissions (
         id, collection_id, organization_id, role_id, can_read, can_manage, can_approve
       ) VALUES ($1, $2, $3, $4, true, false, false)`,
      [randomUUID(), collectionA, a.organizationId, b.adminRoleId]
    );

    await expectFk(
      `INSERT INTO knowledge.sources (id, organization_id, collection_id, title, created_by)
       VALUES ($1, $2, $3, 'stolen', $4)`,
      [randomUUID(), a.organizationId, collectionB, a.adminUserId]
    );

    const sourceA = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.sources (id, organization_id, collection_id, title, created_by)
       VALUES ($1, $2, $3, 'A source', $4)`,
      [sourceA, a.organizationId, collectionA, a.adminUserId]
    );
    const sourceB = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.sources (id, organization_id, collection_id, title, created_by)
       VALUES ($1, $2, $3, 'B source', $4)`,
      [sourceB, b.organizationId, collectionB, b.adminUserId]
    );

    await expectFk(
      `INSERT INTO knowledge.source_versions (
         id, organization_id, source_id, version_number, content_hash, mime_type,
         blob_uri, original_filename, parser_version, effective_at, uploaded_by
       ) VALUES ($1, $2, $3, 1, 'abc', 'text/plain', 'file:///tmp/x', 'x.txt', 'test', now(), $4)`,
      [randomUUID(), a.organizationId, sourceB, a.adminUserId]
    );

    const versionA = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.source_versions (
         id, organization_id, source_id, version_number, content_hash, mime_type,
         blob_uri, original_filename, parser_version, effective_at, uploaded_by
       ) VALUES ($1, $2, $3, 1, 'aaa', 'text/plain', 'file:///tmp/a', 'a.txt', 'test', now(), $4)`,
      [versionA, a.organizationId, sourceA, a.adminUserId]
    );
    const versionB = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.source_versions (
         id, organization_id, source_id, version_number, content_hash, mime_type,
         blob_uri, original_filename, parser_version, effective_at, uploaded_by
       ) VALUES ($1, $2, $3, 1, 'bbb', 'text/plain', 'file:///tmp/b', 'b.txt', 'test', now(), $4)`,
      [versionB, b.organizationId, sourceB, b.adminUserId]
    );

    const embedding = `[${Array.from({ length: 768 }, () => "0.0").join(",")}]`;
    await expectFk(
      `INSERT INTO knowledge.chunks (
         id, organization_id, source_version_id, chunk_index, text, text_hash,
         token_count, embedding
       ) VALUES ($1, $2, $3, 0, 'text', 'hash', 1, $4::vector)`,
      [randomUUID(), a.organizationId, versionB, embedding]
    );

    const chunkA = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.chunks (
         id, organization_id, source_version_id, chunk_index, text, text_hash,
         token_count, embedding
       ) VALUES ($1, $2, $3, 0, 'text', 'hash', 1, $4::vector)`,
      [chunkA, a.organizationId, versionA, embedding]
    );
    const chunkB = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.chunks (
         id, organization_id, source_version_id, chunk_index, text, text_hash,
         token_count, embedding
       ) VALUES ($1, $2, $3, 0, 'text', 'hash', 1, $4::vector)`,
      [chunkB, b.organizationId, versionB, embedding]
    );

    const runA = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.retrieval_runs (
         id, organization_id, actor_id, query, query_hash, mode, collection_ids,
         classification_ceiling, insufficient_evidence
       ) VALUES ($1, $2, $3, 'q', 'qh', 'strict', $4::uuid[], 'internal', false)`,
      [runA, a.organizationId, a.adminUserId, [collectionA]]
    );
    const runB = randomUUID();
    await pool.query(
      `INSERT INTO knowledge.retrieval_runs (
         id, organization_id, actor_id, query, query_hash, mode, collection_ids,
         classification_ceiling, insufficient_evidence
       ) VALUES ($1, $2, $3, 'q', 'qh', 'strict', $4::uuid[], 'internal', false)`,
      [runB, b.organizationId, b.adminUserId, [collectionB]]
    );

    await expectFk(
      `INSERT INTO knowledge.retrieval_hits (
         id, retrieval_run_id, organization_id, chunk_id, source_id, source_version_id,
         collection_id, content_hash, rank, vector_score, keyword_score, included_in_context
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'h', 1, 0, 0, false)`,
      [randomUUID(), runA, a.organizationId, chunkB, sourceA, versionA, collectionA]
    );
    await expectFk(
      `INSERT INTO knowledge.retrieval_hits (
         id, retrieval_run_id, organization_id, chunk_id, source_id, source_version_id,
         collection_id, content_hash, rank, vector_score, keyword_score, included_in_context
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'h', 1, 0, 0, false)`,
      [randomUUID(), runB, a.organizationId, chunkA, sourceA, versionA, collectionA]
    );
    await expectFk(
      `INSERT INTO knowledge.retrieval_hits (
         id, retrieval_run_id, organization_id, chunk_id, source_id, source_version_id,
         collection_id, content_hash, rank, vector_score, keyword_score, included_in_context
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'h', 1, 0, 0, false)`,
      [randomUUID(), runA, a.organizationId, chunkA, sourceB, versionA, collectionA]
    );
  });

  it("rejects cross-organization Nova identity, skill run, and social content links", async () => {
    const { a, b } = await twoOrgs();
    const executionA = randomUUID();
    const executionB = randomUUID();
    await pool.query(
      `INSERT INTO audit.executions (
         id, verity_record_id, organization_id, actor_id, skill_id, status, risk_tier
       ) VALUES
         ($1, $2, $3, $4, 'nova.social.draft', 'running', 'medium'),
         ($5, $6, $7, $8, 'nova.social.draft', 'running', 'medium')`,
      [
        executionA,
        `VTY-2026-${randomUUID().slice(0, 8)}`,
        a.organizationId,
        a.adminUserId,
        executionB,
        `VTY-2026-${randomUUID().slice(0, 8)}`,
        b.organizationId,
        b.adminUserId,
      ]
    );

    await expectFk(
      `INSERT INTO nova.external_identities (
         id, organization_id, provider, external_user_id, verity_user_id
       ) VALUES ($1, $2, 'slack', 'U-cross', $3)`,
      [randomUUID(), a.organizationId, b.adminUserId]
    );

    await expectFk(
      `INSERT INTO nova.skill_runs (
         id, organization_id, execution_id, skill_id, skill_version, actor_id, status
       ) VALUES ($1, $2, $3, 'nova.social.draft', '1.0.0', $4, 'started')`,
      [randomUUID(), a.organizationId, executionB, a.adminUserId]
    );

    await expectFk(
      `INSERT INTO nova.skill_runs (
         id, organization_id, execution_id, skill_id, skill_version, actor_id, status
       ) VALUES ($1, $2, $3, 'nova.social.draft', '1.0.0', $4, 'started')`,
      [randomUUID(), a.organizationId, executionA, b.adminUserId]
    );

    await pool.query(
      `INSERT INTO social.brands (
         id, organization_id, brand_id, display_name, active, config_version
       ) VALUES ($1, $2, 'acme', 'Acme', true, 1), ($3, $4, 'beta', 'Beta', true, 1)`,
      [randomUUID(), a.organizationId, randomUUID(), b.organizationId]
    );

    await expectFk(
      `INSERT INTO social.content_items (
         id, organization_id, brand_id, platform, draft_text, status, artifact_hash
       ) VALUES ($1, $2, 'beta', 'facebook', 'draft', 'pending_approval', $3)`,
      [randomUUID(), a.organizationId, "a".repeat(64)]
    );

    const approvalB = randomUUID();
    await pool.query(
      `INSERT INTO command.approvals (
         id, organization_id, execution_id, skill_id, requested_by, status, artifact_hash
       ) VALUES ($1, $2, $3, 'nova.social.draft', $4, 'pending', $5)`,
      [approvalB, b.organizationId, executionB, b.adminUserId, "b".repeat(64)]
    );
    await expectFk(
      `INSERT INTO social.content_items (
         id, organization_id, brand_id, platform, draft_text, status, artifact_hash,
         execution_id, approval_id
       ) VALUES ($1, $2, 'acme', 'facebook', 'draft', 'pending_approval', $3, $4, $5)`,
      [randomUUID(), a.organizationId, "c".repeat(64), executionA, approvalB]
    );

    await expectFk(
      `INSERT INTO social.content_items (
         id, organization_id, brand_id, platform, draft_text, status, artifact_hash, execution_id
       ) VALUES ($1, $2, 'acme', 'facebook', 'draft', 'pending_approval', $3, $4)`,
      [randomUUID(), a.organizationId, "d".repeat(64), executionB]
    );
  });
});
