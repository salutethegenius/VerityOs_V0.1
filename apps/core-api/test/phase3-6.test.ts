import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createOrg,
  createPool,
  login,
  markdownPart,
  seedPlatformService,
  startApp,
} from "./helpers.js";

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

const FACT =
  "The capital of France is Paris. Verity Knowledge records that Paris is the capital of France for sovereign retrieval tests.";

describe("Phase 3 identity", () => {
  it("logs in successfully and rejects bad passwords", async () => {
    const org = await createOrg(app, serviceToken, "Login Org");
    const ok = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: org.email, password: org.password },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().organization_id).toBe(org.organization_id);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: org.email, password: "wrong-password-value" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(JSON.stringify(bad.json())).not.toMatch(/scrypt|password_hash|SELECT /);
  });

  it("enforces membership and RBAC", async () => {
    const org = await createOrg(app, serviceToken, "RBAC Org");
    const admin = await login(app, org.email, org.password);
    const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { cookie: admin.cookie },
      payload: {
        email: memberEmail,
        password: "member-horse-battery",
        display_name: "Member",
        role_id: org.member_role_id,
      },
    });
    expect(created.statusCode).toBe(200);
    const member = await login(app, memberEmail, "member-horse-battery");
    const denied = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: { cookie: member.cookie },
      payload: { name: "secret", classification: "internal" },
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "GET",
      url: "/v1/knowledge/collections",
      headers: { cookie: member.cookie },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe("Phase 4 command", () => {
  it("allows, denies, requires approval, and blocks unauthorized decisions", async () => {
    const org = await createOrg(app, serviceToken, "Policy Org");
    const admin = await login(app, org.email, org.password);
    const allow = await app.inject({
      method: "POST",
      url: "/v1/policies/evaluate",
      headers: { cookie: admin.cookie },
      payload: {
        action: {
          type: "skill.use",
          skillId: "knowledge.retrieve",
          classification: "internal",
          riskTier: "low",
        },
      },
    });
    expect(allow.statusCode).toBe(200);
    expect(allow.json().decision).toBe("allow");
    expect(allow.json().reason_code).toBe("ROLE_AND_CLASSIFICATION_ALLOWED");

    const memberEmail = `p-member-${randomUUID().slice(0, 8)}@example.test`;
    await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { cookie: admin.cookie },
      payload: {
        email: memberEmail,
        password: "member-horse-battery",
        display_name: "Member",
        role_id: org.member_role_id,
      },
    });
    const member = await login(app, memberEmail, "member-horse-battery");
    const roleDeny = await app.inject({
      method: "POST",
      url: "/v1/policies/evaluate",
      headers: { cookie: member.cookie },
      payload: {
        action: {
          type: "skill.use",
          skillId: "knowledge.manage",
          classification: "internal",
          riskTier: "low",
        },
      },
    });
    expect(roleDeny.json().decision).toBe("deny");
    expect(roleDeny.json().reason_code).toBe("ROLE_DENIED");

    const classDeny = await app.inject({
      method: "POST",
      url: "/v1/policies/evaluate",
      headers: { cookie: member.cookie },
      payload: {
        action: { type: "data.leave_device", classification: "restricted" },
      },
    });
    expect(classDeny.json().reason_code).toBe("CLASSIFICATION_DENIED");

    const skillDeny = await app.inject({
      method: "POST",
      url: "/v1/policies/evaluate",
      headers: { cookie: member.cookie },
      payload: {
        action: {
          type: "skill.use",
          skillId: "nova.use",
          classification: "internal",
          riskTier: "high",
        },
      },
    });
    expect(skillDeny.json().reason_code).toBe("SKILL_DENIED");

    const approval = await app.inject({
      method: "POST",
      url: "/v1/policies/evaluate",
      headers: { cookie: admin.cookie },
      payload: {
        action: {
          type: "skill.use",
          skillId: "audit.export",
          classification: "restricted",
          riskTier: "high",
        },
      },
    });
    expect(approval.json().decision).toBe("approval_required");

    const exportRes = await app.inject({
      method: "GET",
      url: "/v1/audit/export",
      headers: { cookie: admin.cookie },
    });
    expect(exportRes.statusCode).toBe(403);
    expect(exportRes.json().error.code).toBe("APPROVAL_REQUIRED");

    const modelDeny = await app.inject({
      method: "POST",
      url: "/v1/policies/evaluate",
      headers: { cookie: admin.cookie },
      payload: {
        action: {
          type: "model.process",
          classification: "confidential",
          deploymentType: "cloud",
          modelRiskCeiling: "high",
          requestedRisk: "low",
        },
      },
    });
    expect(modelDeny.json().reason_code).toBe("CLASSIFICATION_DENIED");

    const approvalId = randomUUID();
    await pool.query(
      `INSERT INTO command.approvals (
         id, organization_id, execution_id, skill_id, requested_by, status
       ) VALUES ($1,$2,$3,'audit.export',$4,'pending')`,
      [approvalId, org.organization_id, randomUUID(), org.admin_user_id]
    );
    const selfApprove = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/decide`,
      headers: { cookie: admin.cookie },
      payload: { allow: true },
    });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error.code).toBe("APPROVER_UNAUTHORIZED");

    const memberDecide = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/decide`,
      headers: { cookie: member.cookie },
      payload: { allow: true },
    });
    expect(memberDecide.statusCode).toBe(403);
  });
});

describe("Phase 5 model router", () => {
  it("routes mock local, honors preference, classification, and risk ceiling", async () => {
    const org = await createOrg(app, serviceToken, "Router Org");
    const admin = await login(app, org.email, org.password);

    const mock = await app.inject({
      method: "POST",
      url: "/v1/models/route",
      headers: { cookie: admin.cookie },
      payload: {
        task: "summarize",
        risk_tier: "low",
        data_classification: "internal",
        required_capabilities: ["chat"],
        prefer_local: true,
      },
    });
    expect(mock.statusCode).toBe(200);
    expect(mock.json().provider).toBe("mock");
    expect(mock.json().deployment_type).toBe("local");
    expect(mock.json().selection_reason_code).toBe("LOCAL_PREFERRED_AVAILABLE");

    const restricted = await app.inject({
      method: "POST",
      url: "/v1/models/route",
      headers: { cookie: admin.cookie },
      payload: {
        task: "summarize",
        risk_tier: "low",
        data_classification: "restricted",
        required_capabilities: ["chat"],
        prefer_local: false,
      },
    });
    expect(restricted.json().selection_reason_code).toBe("LOCAL_REQUIRED_CLASSIFICATION");

    await app.inject({
      method: "POST",
      url: "/v1/models",
      headers: { cookie: admin.cookie },
      payload: {
        model_key: "tiny-cloud",
        provider: "openai",
        deployment_type: "cloud",
        capabilities_json: ["chat"],
        allowed_data_classes_json: ["public"],
        risk_ceiling: "low",
        requires_internet: true,
        enabled: true,
      },
    });

    await pool.query(
      `UPDATE command.models SET enabled = false
       WHERE organization_id = $1 AND model_key = 'mock-local'`,
      [org.organization_id]
    );
    const none = await app.inject({
      method: "POST",
      url: "/v1/models/route",
      headers: { cookie: admin.cookie },
      payload: {
        task: "summarize",
        risk_tier: "high",
        data_classification: "internal",
        required_capabilities: ["chat"],
      },
    });
    expect(none.json().selection_reason_code).toMatch(
      /NO_ALLOWED_MODEL|MODEL_RISK_CEILING_EXCEEDED|CLASSIFICATION_DENIED/
    );
  });
});

describe("Phase 6 knowledge and exit gate", () => {
  it("isolates organizations and satisfies the retrieval/model exit gate", async () => {
    const orgA = await createOrg(app, serviceToken, "Organization A");
    const orgB = await createOrg(app, serviceToken, "Organization B");
    const adminA = await login(app, orgA.email, orgA.password);
    const adminB = await login(app, orgB.email, orgB.password);

    const collection = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: { cookie: adminA.cookie },
      payload: { name: "Policies", classification: "internal" },
    });
    expect(collection.statusCode).toBe(200);
    const collectionId = collection.json().collection_id as string;

    const uploaded = await app.inject({
      method: "POST",
      url: `/v1/knowledge/collections/${collectionId}/sources`,
      headers: {
        cookie: adminA.cookie,
        "content-type": "multipart/form-data; boundary=----veritytest",
      },
      payload: markdownPart("france.md", FACT, "France facts"),
    });
    expect(uploaded.statusCode).toBe(200);
    const versionId = uploaded.json().version_id as string;
    const sourceId = uploaded.json().source_id as string;
    expect(uploaded.json().content_hash).toMatch(/^[0-9a-f]{64}$/);

    const approved = await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${versionId}/approve`,
      headers: { cookie: adminA.cookie },
    });
    expect(approved.statusCode).toBe(200);

    const indexed = await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${versionId}/index`,
      headers: { cookie: adminA.cookie },
    });
    expect(indexed.statusCode).toBe(200);
    expect(indexed.json().chunkCount).toBeGreaterThan(0);

    const retrieved = await app.inject({
      method: "POST",
      url: "/internal/v1/knowledge/retrieve",
      headers: { authorization: `Bearer ${serviceToken}` },
      payload: {
        execution_id: randomUUID(),
        organization_id: orgA.organization_id,
        actor_id: orgA.admin_user_id,
        query: "What is the capital of France?",
        collection_ids: [collectionId],
        mode: "strict",
        top_k: 8,
        classification_ceiling: "internal",
      },
    });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().insufficient_evidence).toBe(false);
    expect(retrieved.json().hits[0].source_version_id).toBe(versionId);
    expect(retrieved.json().hits[0].text).toMatch(/Paris/);

    const empty = await app.inject({
      method: "POST",
      url: "/internal/v1/knowledge/retrieve",
      headers: { authorization: `Bearer ${serviceToken}` },
      payload: {
        execution_id: randomUUID(),
        organization_id: orgA.organization_id,
        actor_id: orgA.admin_user_id,
        query: "boiling point of liquid nitrogen lasagna recipe",
        collection_ids: [collectionId],
        mode: "strict",
        top_k: 8,
        classification_ceiling: "internal",
      },
    });
    expect(empty.json().insufficient_evidence).toBe(true);
    expect(empty.json().hits).toEqual([]);

    const routed = await app.inject({
      method: "POST",
      url: "/v1/models/route",
      headers: { cookie: adminA.cookie },
      payload: {
        task: "answer-from-knowledge",
        risk_tier: "low",
        data_classification: "internal",
        required_capabilities: ["chat"],
        prefer_local: true,
      },
    });
    expect(routed.json().provider).toBe("mock");

    const runId = retrieved.json().retrieval_run_id as string;
    const bCollection = await app.inject({
      method: "GET",
      url: `/v1/knowledge/sources/${sourceId}`,
      headers: { cookie: adminB.cookie },
    });
    expect(bCollection.statusCode).toBe(404);

    const bRun = await app.inject({
      method: "GET",
      url: `/v1/knowledge/runs/${runId}`,
      headers: { cookie: adminB.cookie },
    });
    expect(bRun.statusCode).toBe(404);

    const bUsers = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: { cookie: adminB.cookie },
    });
    expect(bUsers.json().users.every((u: { email: string }) => u.email !== orgA.email)).toBe(
      true
    );

    const bRetrieve = await app.inject({
      method: "POST",
      url: "/v1/knowledge/retrieve",
      headers: { cookie: adminB.cookie },
      payload: {
        organization_id: orgA.organization_id,
        query: "What is the capital of France?",
        collection_ids: [collectionId],
        mode: "strict",
        classification_ceiling: "internal",
      },
    });
    expect(bRetrieve.statusCode).toBe(403);

    const bPolicy = await app.inject({
      method: "GET",
      url: `/v1/policies/${(await app.inject({
        method: "GET",
        url: "/v1/policies",
        headers: { cookie: adminA.cookie },
      })).json().policies[0].id}`,
      headers: { cookie: adminB.cookie },
    });
    expect(bPolicy.statusCode).toBe(404);

    const bModels = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { cookie: adminB.cookie },
    });
    expect(
      bModels.json().models.every((m: { organization_id: string }) => m.organization_id === orgB.organization_id)
    ).toBe(true);

    const forged = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: { cookie: adminB.cookie },
      payload: {
        name: "steal",
        classification: "internal",
        organization_id: orgA.organization_id,
      },
    });
    expect(forged.statusCode).toBe(403);
  });
});

describe("security", () => {
  it("rejects unauthenticated management, invalid service credentials, and cross-tenant IDs", async () => {
    const unauth = await app.inject({ method: "GET", url: "/v1/users" });
    expect(unauth.statusCode).toBe(401);

    const badService = await app.inject({
      method: "POST",
      url: "/internal/v1/organizations",
      headers: { authorization: "Bearer not-a-real-token-value" },
      payload: {
        name: "Nope",
        admin_email: "a@b.c",
        admin_password: "correct-horse-battery",
      },
    });
    expect(badService.statusCode).toBe(401);

    const org = await createOrg(app, serviceToken, "Sec Org");
    const admin = await login(app, org.email, org.password);
    const missing = await app.inject({
      method: "GET",
      url: `/v1/knowledge/sources/${randomUUID()}`,
      headers: { cookie: admin.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});
