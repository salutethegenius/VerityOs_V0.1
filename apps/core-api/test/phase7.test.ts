import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HASH_FORMAT_VERSION,
  exportOrganizationEvidence,
  getExecution,
  listExecutionEvents,
  verifyEvidenceBundle,
} from "@verityos/audit-kernel";
import {
  KnowledgeError,
  MockEmbeddingProvider,
  indexSourceVersion,
  reindexSourceVersion,
} from "@verityos/knowledge";
import {
  TEST_ORIGIN,
  createOrg,
  createPool,
  login,
  markdownPart,
  seedPlatformService,
  sessionHeaders,
  startApp,
} from "./helpers.js";

const FACT =
  "The capital of France is Paris. Verity Knowledge records that Paris is the capital of France for sovereign retrieval tests.";

const pool = createPool();
const app = await startApp(pool);
let serviceToken = "";

beforeAll(async () => {
  await pool.query("SELECT 1");
  serviceToken = await seedPlatformService(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const localProvider = {
  key: "local-nomic",
  dimensions: 768,
  embed: (texts: string[]) => new MockEmbeddingProvider().embed(texts),
};

async function authHeader() {
  return { authorization: `Bearer ${serviceToken}` };
}

async function seedKnowledge(name: string) {
  const org = await createOrg(app, serviceToken, name);
  const admin = await login(app, org.email, org.password);
  const collection = await app.inject({
    method: "POST",
    url: "/v1/knowledge/collections",
    headers: sessionHeaders(admin.cookie),
    payload: { name: "Policies", classification: "internal" },
  });
  const collectionId = collection.json().collection_id as string;
  const uploaded = await app.inject({
    method: "POST",
    url: `/v1/knowledge/collections/${collectionId}/sources`,
    headers: sessionHeaders(admin.cookie, {
      "content-type": "multipart/form-data; boundary=----veritytest",
    }),
    payload: markdownPart("france.md", FACT, "France facts"),
  });
  const versionId = uploaded.json().version_id as string;
  await app.inject({
    method: "POST",
    url: `/v1/knowledge/versions/${versionId}/approve`,
    headers: sessionHeaders(admin.cookie),
  });
  const indexed = await app.inject({
    method: "POST",
    url: `/v1/knowledge/versions/${versionId}/index`,
    headers: sessionHeaders(admin.cookie),
  });
  expect(indexed.statusCode).toBe(200);
  return { org, admin, collectionId, versionId };
}

async function openExecution(org: {
  organization_id: string;
  admin_user_id: string;
}) {
  const opened = await app.inject({
    method: "POST",
    url: "/internal/v1/executions",
    headers: await authHeader(),
    payload: {
      organization_id: org.organization_id,
      actor_id: org.admin_user_id,
      skill_id: "knowledge.retrieve",
      risk_tier: "low",
      request: { task: "answer" },
    },
  });
  expect(opened.statusCode).toBe(200);
  return opened.json() as {
    execution_id: string;
    verity_record_id: string;
    status: string;
  };
}

describe("embedding provider mismatch", () => {
  it("requires explicit reindex when the provider key changes", async () => {
    const { org, versionId } = await seedKnowledge("Reindex Org");
    const same = await indexSourceVersion(pool, {
      organizationId: org.organization_id,
      versionId,
    });
    expect(same.chunkCount).toBeGreaterThan(0);

    try {
      await indexSourceVersion(
        pool,
        { organizationId: org.organization_id, versionId },
        localProvider
      );
      throw new Error("expected REINDEX_REQUIRED");
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeError);
      expect((err as KnowledgeError).code).toBe("REINDEX_REQUIRED");
    }

    const reindexed = await reindexSourceVersion(
      pool,
      { organizationId: org.organization_id, versionId },
      localProvider
    );
    expect(reindexed.chunkCount).toBeGreaterThan(0);
    const stored = await pool.query<{ embedding_provider_key: string }>(
      `SELECT embedding_provider_key FROM knowledge.chunks WHERE source_version_id = $1`,
      [versionId]
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    expect(stored.rows.every((row) => row.embedding_provider_key === "local-nomic")).toBe(
      true
    );
  });
});

describe("Phase 7 unified execution", () => {
  it("keeps one execution_id across knowledge, routing, model execution, graph, and offline verify", async () => {
    const { org, admin, collectionId } = await seedKnowledge("Graph Org");
    const opened = await openExecution(org);
    const executionId = opened.execution_id;
    const verityRecordId = opened.verity_record_id;

    const retrieved = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/knowledge/retrieve`,
      headers: await authHeader(),
      payload: {
        query: "What is the capital of France?",
        collection_ids: [collectionId],
        mode: "strict",
        top_k: 8,
        classification_ceiling: "internal",
      },
    });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().insufficient_evidence).toBe(false);
    expect(retrieved.json().execution_id ?? executionId).toBe(executionId);
    const runId = retrieved.json().retrieval_run_id as string;
    const chunkIds = (retrieved.json().hits as Array<{ chunk_id: string }>).map(
      (hit) => hit.chunk_id
    );
    expect(chunkIds.length).toBeGreaterThan(0);

    const run = await pool.query<{ execution_id: string }>(
      `SELECT execution_id FROM knowledge.retrieval_runs WHERE id = $1`,
      [runId]
    );
    expect(run.rows[0].execution_id).toBe(executionId);
    const beforeModel = await pool.query<{ included_in_context: boolean }>(
      `SELECT included_in_context FROM knowledge.retrieval_hits WHERE retrieval_run_id = $1`,
      [runId]
    );
    expect(beforeModel.rows.every((row) => row.included_in_context === false)).toBe(true);

    const routed = await app.inject({
      method: "POST",
      url: "/internal/v1/models/route",
      headers: await authHeader(),
      payload: {
        organization_id: org.organization_id,
        actor_id: org.admin_user_id,
        execution_id: executionId,
        task: "answer-from-knowledge",
        risk_tier: "low",
        data_classification: "internal",
        required_capabilities: ["chat"],
        prefer_local: true,
      },
    });
    expect(routed.statusCode).toBe(200);
    expect(routed.json().provider).toBe("mock");
    expect(routed.json().execution_id).toBe(executionId);

    const executed = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/model/execute`,
      headers: await authHeader(),
      payload: {
        task: "answer-from-knowledge",
        risk_tier: "low",
        data_classification: "internal",
        required_capabilities: ["chat"],
        prefer_local: true,
        content: "What is the capital of France?",
        retrieval_run_id: runId,
        context_chunk_ids: chunkIds,
      },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().provider).toBe("mock");
    expect(executed.json().prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(executed.json().output_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(executed.json())).not.toMatch(/OPENAI_API_KEY|sk-/);
    const afterModel = await pool.query<{ included_in_context: boolean }>(
      `SELECT included_in_context FROM knowledge.retrieval_hits
       WHERE retrieval_run_id = $1 AND chunk_id = ANY($2::uuid[])`,
      [runId, chunkIds]
    );
    expect(afterModel.rows.length).toBe(chunkIds.length);
    expect(afterModel.rows.every((row) => row.included_in_context === true)).toBe(true);

    const finalized = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/finalize`,
      headers: await authHeader(),
      payload: { outcome: "completed" },
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json().execution_id).toBe(executionId);
    expect(finalized.json().verity_record_id).toBe(verityRecordId);
    expect(finalized.json().execution_graph_hash).toMatch(/^[0-9a-f]{64}$/);

    const events = await listExecutionEvents(pool, org.organization_id, executionId);
    expect(events.map((e) => e.event_sequence)).toEqual(
      events.map((_, i) => i + 1)
    );
    const types = events.map((e) => e.event_type);
    expect(types).toContain("execution.created");
    expect(types).toContain("identity.authenticated");
    expect(types).toContain("knowledge.retrieval.completed");
    expect(types).toContain("model.selected");
    expect(types).toContain("model.execution.completed");
    expect(types).toContain("audit.checkpoint.sealed");
    const selected = events.find((e) => e.event_type === "model.selected");
    expect(selected?.metadata).toMatchObject({
      provider: "mock",
      deployment_type: "local",
    });
    const completed = events.find((e) => e.event_type === "model.execution.completed");
    expect(completed?.input_hash).toBe(executed.json().prompt_hash);
    expect(completed?.output_hash).toBe(executed.json().output_hash);
    expect(JSON.stringify(events.map((e) => e.metadata))).not.toContain(FACT);

    const record = await app.inject({
      method: "GET",
      url: `/v1/audit/records/${verityRecordId}`,
      headers: sessionHeaders(admin.cookie),
    });
    expect(record.statusCode).toBe(200);
    expect(record.json().execution_id).toBe(executionId);
    expect(record.json().integrity_status).toBe("not_verified");
    expect(record.json().provenance_status).toBe("linked");
    expect(record.json()).not.toHaveProperty("integrity_verified");
    expect(record.json()).not.toHaveProperty("provenance_verified");
    expect(record.json()).not.toHaveProperty("fact_verified");
    expect(record.json()).not.toHaveProperty("truth_verified");
    expect(record.json().final_ledger_entry.execution_graph_hash).toBe(
      finalized.json().execution_graph_hash
    );
    expect(record.json().final_ledger_entry.hash_format_version).toBe(HASH_FORMAT_VERSION);
    const openedEntry = await pool.query<{ request_hash: string }>(
      `SELECT request_hash FROM audit.ledger_entries
       WHERE execution_id = $1 AND entry_type = 'request_opened'
       ORDER BY organization_sequence ASC LIMIT 1`,
      [executionId]
    );
    expect(record.json().final_ledger_entry.request_hash).toBe(openedEntry.rows[0].request_hash);
    expect(record.json().final_ledger_entry.response_hash).toBe(executed.json().output_hash);
    expect(completed?.output_hash).toBe(executed.json().output_hash);

    const graph = await app.inject({
      method: "GET",
      url: `/v1/audit/records/${verityRecordId}/graph`,
      headers: sessionHeaders(admin.cookie),
    });
    expect(graph.statusCode).toBe(200);
    expect(graph.json().graph.schema_version).toBe("2");
    expect(graph.json().execution_graph_hash).toBe(finalized.json().execution_graph_hash);

    const verified = await app.inject({
      method: "POST",
      url: `/v1/audit/records/${verityRecordId}/verify`,
      headers: sessionHeaders(admin.cookie),
    });
    expect(verified.json().integrity_verified).toBe(true);
    expect(verified.json().provenance_verified).toBe(true);

    const exported = await exportOrganizationEvidence(pool, org.organization_id);
    expect(exported.manifest.hash_format_version).toBe("2");
    expect(exported.manifest.execution_graph_schema_version).toBe("2");
    const offline = verifyEvidenceBundle(exported);
    expect(offline.valid).toBe(true);

    const mutated = structuredClone(exported);
    const target = mutated.execution_graphs?.[0];
    expect(target).toBeTruthy();
    const node = (target?.graph as { nodes: Array<{ metadata: Record<string, unknown> }> })
      .nodes[0];
    node.metadata.tampered = true;
    const mutatedResult = verifyEvidenceBundle(mutated);
    expect(mutatedResult.valid).toBe(false);
    expect(mutatedResult.issues.some((issue) => issue.code.startsWith("GRAPH_"))).toBe(
      true
    );
  });

  it("blocks strict insufficient evidence without calling the model", async () => {
    const { org, admin, collectionId } = await seedKnowledge("Insufficient Org");
    const opened = await openExecution(org);
    const retrieved = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${opened.execution_id}/knowledge/retrieve`,
      headers: await authHeader(),
      payload: {
        query: "boiling point of liquid nitrogen lasagna recipe",
        collection_ids: [collectionId],
        mode: "strict",
        classification_ceiling: "internal",
      },
    });
    expect(retrieved.json().insufficient_evidence).toBe(true);
    const executed = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${opened.execution_id}/model/execute`,
      headers: await authHeader(),
      payload: {
        task: "answer-from-knowledge",
        risk_tier: "low",
        data_classification: "internal",
        content: "invent an answer",
        retrieval_run_id: retrieved.json().retrieval_run_id,
      },
    });
    expect(executed.statusCode).toBe(409);
    expect(executed.json().error.code).toBe("INSUFFICIENT_EVIDENCE");
    const events = await listExecutionEvents(
      pool,
      org.organization_id,
      opened.execution_id
    );
    expect(events.some((e) => e.event_type === "knowledge.retrieval.insufficient")).toBe(
      true
    );
    expect(events.some((e) => e.event_type === "model.execution.started")).toBe(false);
    expect(events.some((e) => e.event_type === "release.blocked")).toBe(true);

    const finalized = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${opened.execution_id}/finalize`,
      headers: await authHeader(),
      payload: { outcome: "blocked" },
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json().status).toBe("blocked");
    const record = await app.inject({
      method: "GET",
      url: `/v1/audit/records/${opened.verity_record_id}`,
      headers: sessionHeaders(admin.cookie),
    });
    expect(record.json().status).toBe("blocked");
    expect(record.json().integrity_status).toBe("not_verified");
    expect(record.json().provenance_status).toBe("linked");
    expect(record.json().final_ledger_entry.response_hash).toBeNull();
    const verified = await app.inject({
      method: "POST",
      url: `/v1/audit/records/${opened.verity_record_id}/verify`,
      headers: sessionHeaders(admin.cookie),
    });
    expect(verified.json().integrity_verified).toBe(true);
    expect(verified.json().provenance_verified).toBe(true);
    const bundle = await exportOrganizationEvidence(pool, org.organization_id);
    expect(verifyEvidenceBundle(bundle).valid).toBe(true);
  });

  it("rejects invalid and cross-run context chunks", async () => {
    const { org, admin, collectionId } = await seedKnowledge("Context Org");
    const otherCollection = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(admin.cookie),
      payload: { name: "Other", classification: "internal" },
    });
    const otherId = otherCollection.json().collection_id as string;
    const uploaded = await app.inject({
      method: "POST",
      url: `/v1/knowledge/collections/${otherId}/sources`,
      headers: sessionHeaders(admin.cookie, {
        "content-type": "multipart/form-data; boundary=----veritytest",
      }),
      payload: markdownPart(
        "spain.md",
        "The capital of Spain is Madrid. Verity Knowledge records that Madrid is the capital of Spain for isolated retrieval tests.",
        "Spain facts"
      ),
    });
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${uploaded.json().version_id}/approve`,
      headers: sessionHeaders(admin.cookie),
    });
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${uploaded.json().version_id}/index`,
      headers: sessionHeaders(admin.cookie),
    });
    const first = await openExecution(org);
    const second = await openExecution(org);
    const a = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${first.execution_id}/knowledge/retrieve`,
      headers: await authHeader(),
      payload: {
        query: "What is the capital of France?",
        collection_ids: [collectionId],
        mode: "strict",
        classification_ceiling: "internal",
      },
    });
    const b = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${second.execution_id}/knowledge/retrieve`,
      headers: await authHeader(),
      payload: {
        query: "What is the capital of Spain?",
        collection_ids: [otherId],
        mode: "strict",
        classification_ceiling: "internal",
      },
    });
    expect(b.json().hits.length).toBeGreaterThan(0);
    const otherChunk = b.json().hits[0].chunk_id as string;
    expect(a.json().hits.some((hit: { chunk_id: string }) => hit.chunk_id === otherChunk)).toBe(
      false
    );
    const invalid = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${first.execution_id}/model/execute`,
      headers: await authHeader(),
      payload: {
        task: "answer-from-knowledge",
        risk_tier: "low",
        data_classification: "internal",
        content: "use this chunk",
        retrieval_run_id: a.json().retrieval_run_id,
        context_chunk_ids: [randomUUID()],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_CONTEXT_CHUNK");
    const cross = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${first.execution_id}/model/execute`,
      headers: await authHeader(),
      payload: {
        task: "answer-from-knowledge",
        risk_tier: "low",
        data_classification: "internal",
        content: "use that chunk",
        retrieval_run_id: a.json().retrieval_run_id,
        context_chunk_ids: [otherChunk],
      },
    });
    expect(cross.statusCode).toBe(400);
    expect(cross.json().error.code).toBe("INVALID_CONTEXT_CHUNK");
  });

  it("records authorization denial and provider failure", async () => {
    const { org, admin, collectionId } = await seedKnowledge("Denial Org");
    const memberEmail = `deny-${randomUUID().slice(0, 8)}@example.test`;
    const createdMember = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: sessionHeaders(admin.cookie),
      payload: {
        email: memberEmail,
        password: "member-horse-battery",
        display_name: "Member",
        role_id: org.member_role_id,
      },
    });
    expect(createdMember.statusCode).toBe(200);
    await pool.query(
      `DELETE FROM command.skill_policy_roles spr
       USING command.skill_policies sp
       WHERE spr.skill_policy_id = sp.id
         AND sp.organization_id = $1
         AND sp.skill_id = 'knowledge.retrieve'
         AND spr.role_id = $2`,
      [org.organization_id, org.member_role_id]
    );
    const member = await app.inject({
      method: "POST",
      url: "/internal/v1/executions",
      headers: await authHeader(),
      payload: {
        organization_id: org.organization_id,
        actor_id: createdMember.json().user_id,
        skill_id: "knowledge.retrieve",
        risk_tier: "low",
        request: {},
      },
    });
    const denied = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${member.json().execution_id}/knowledge/retrieve`,
      headers: await authHeader(),
      payload: {
        query: "capital",
        collection_ids: [collectionId],
        mode: "strict",
        classification_ceiling: "internal",
      },
    });
    expect(denied.statusCode).toBe(403);
    const deniedEvents = await listExecutionEvents(
      pool,
      org.organization_id,
      member.json().execution_id
    );
    expect(deniedEvents.some((e) => e.event_type === "authorization.denied")).toBe(true);

    await pool.query(
      `UPDATE command.models SET enabled = false
       WHERE organization_id = $1 AND model_key = 'mock-local'`,
      [org.organization_id]
    );
    await app.inject({
      method: "POST",
      url: "/v1/models",
      headers: sessionHeaders(admin.cookie),
      payload: {
        model_key: "broken-local",
        provider: "openai-compatible",
        deployment_type: "local",
        endpoint: "http://127.0.0.1:1/v1/chat/completions",
        capabilities_json: ["chat"],
        allowed_data_classes_json: ["public", "internal"],
        risk_ceiling: "high",
        requires_internet: false,
        enabled: true,
      },
    });
    const failing = await openExecution(org);
    const failed = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${failing.execution_id}/model/execute`,
      headers: await authHeader(),
      payload: {
        task: "summarize",
        risk_tier: "low",
        data_classification: "internal",
        content: "hello",
        prefer_local: true,
      },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe("PROVIDER_FAILURE");
    const failEvents = await listExecutionEvents(
      pool,
      org.organization_id,
      failing.execution_id
    );
    expect(failEvents.some((e) => e.event_type === "model.selected")).toBe(true);
    expect(failEvents.some((e) => e.event_type === "model.execution.failed")).toBe(true);
  });

  it("does not complete when finalization is injected to fail, then releases after commit", async () => {
    const org = await createOrg(app, serviceToken, "Inject Org");
    const opened = await openExecution(org);
    process.env.VERITY_ALLOW_FAILURE_INJECTION = "true";
    const injected = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${opened.execution_id}/finalize`,
      headers: await authHeader(),
      payload: { outcome: "completed", inject_failure: true },
    });
    expect(injected.statusCode).toBe(500);
    const after = await getExecution(pool, org.organization_id, opened.execution_id);
    expect(after?.status).toBe("running");
    expect(after?.final_entry_id).toBeNull();
    const events = await listExecutionEvents(
      pool,
      org.organization_id,
      opened.execution_id
    );
    expect(events.some((e) => e.event_type === "execution.completed")).toBe(false);
    expect(events.some((e) => e.event_type === "release.completed")).toBe(false);

    delete process.env.VERITY_ALLOW_FAILURE_INJECTION;
    const released = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${opened.execution_id}/finalize`,
      headers: await authHeader(),
      payload: { outcome: "completed" },
    });
    expect(released.statusCode).toBe(200);
    const done = await getExecution(pool, org.organization_id, opened.execution_id);
    expect(done?.status).toBe("completed");
    expect(done?.final_entry_id).toBeTruthy();
  });

  it("prevents Org B from reading Org A records, graphs, verify, or attaching events", async () => {
    const a = await seedKnowledge("Tenant A Graph");
    const b = await createOrg(app, serviceToken, "Tenant B Graph");
    const adminB = await login(app, b.email, b.password);
    const opened = await openExecution(a.org);
    await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${opened.execution_id}/finalize`,
      headers: await authHeader(),
      payload: { outcome: "completed" },
    });

    const record = await app.inject({
      method: "GET",
      url: `/v1/audit/records/${opened.verity_record_id}`,
      headers: sessionHeaders(adminB.cookie),
    });
    expect(record.statusCode).toBe(404);
    const graph = await app.inject({
      method: "GET",
      url: `/v1/audit/records/${opened.verity_record_id}/graph`,
      headers: sessionHeaders(adminB.cookie),
    });
    expect(graph.statusCode).toBe(404);
    const verify = await app.inject({
      method: "POST",
      url: `/v1/audit/records/${opened.verity_record_id}/verify`,
      headers: sessionHeaders(adminB.cookie),
    });
    expect(verify.statusCode).toBe(404);

    const scoped = await app.inject({
      method: "POST",
      url: "/internal/v1/service-credentials",
      headers: await authHeader(),
      payload: {
        name: "org-b-reader",
        organization_id: b.organization_id,
        scopes: ["knowledge.read", "models.read"],
      },
    });
    const inject = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${opened.execution_id}/knowledge/retrieve`,
      headers: { authorization: `Bearer ${scoped.json().token}` },
      payload: {
        query: "capital",
        collection_ids: [a.collectionId],
        mode: "strict",
      },
    });
    expect(inject.statusCode).toBe(404);
  });

  it("rejects organization-less credentials without platform.cross_org", async () => {
    const org = await createOrg(app, serviceToken, "Platform Scope");
    const opened = await openExecution(org);
    const limited = await app.inject({
      method: "POST",
      url: "/internal/v1/service-credentials",
      headers: await authHeader(),
      payload: {
        name: "platform-no-cross-org",
        organization_id: null,
        scopes: ["knowledge.read", "models.read"],
      },
    });
    expect(limited.statusCode).toBe(200);
    const retrieve = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${opened.execution_id}/knowledge/retrieve`,
      headers: { authorization: `Bearer ${limited.json().token}` },
      payload: {
        query: "capital",
        collection_ids: [randomUUID()],
        mode: "strict",
      },
    });
    expect(retrieve.statusCode).toBe(403);
    expect(retrieve.json().error.code).toBe("FORBIDDEN");
  });
});

describe("health", () => {
  it("reports phase 10", async () => {
    const health = await app.inject({ method: "GET", url: "/v1/health" });
    expect(health.json().phase).toBe("10");
    expect(TEST_ORIGIN).toBeTruthy();
  });
});
