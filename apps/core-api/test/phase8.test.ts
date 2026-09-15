import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  exportOrganizationEvidence,
  getExecution,
  listExecutionEvents,
  verifyEvidenceBundle,
} from "@verityos/audit-kernel";
import {
  TEST_ORIGIN,
  createOrg,
  createPool,
  login,
  seedPlatformService,
  sessionHeaders,
  startApp,
} from "./helpers.js";

const pool = createPool();
const app = await startApp(pool);
let platformToken = "";

beforeAll(async () => {
  await pool.query("SELECT 1");
  platformToken = await seedPlatformService(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("Phase 8 Core skill and approval APIs", () => {
  it("runs a governed social approval workflow on an org-scoped Nova credential", async () => {
    const org = await createOrg(app, platformToken, "Nova Org");
    const admin = await login(app, org.email, org.password);
    const member = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: sessionHeaders(admin.cookie),
      payload: {
        email: `member-${randomUUID().slice(0, 8)}@example.test`,
        password: "correct-horse-battery",
        display_name: "Nova System",
        role_id: org.member_role_id,
      },
    });
    expect(member.statusCode).toBe(200);
    const systemActorId = member.json().user_id as string;

    const novaCred = await app.inject({
      method: "POST",
      url: "/internal/v1/service-credentials",
      headers: { authorization: `Bearer ${platformToken}` },
      payload: {
        name: "nova-org",
        organization_id: org.organization_id,
        scopes: ["knowledge.read", "models.read", "executions.write"],
      },
    });
    expect(novaCred.statusCode).toBe(200);
    const novaToken = novaCred.json().token as string;
    expect(novaToken).toBeTruthy();

    const novaAuth = { authorization: `Bearer ${novaToken}` };
    const opened = await app.inject({
      method: "POST",
      url: "/internal/v1/executions",
      headers: novaAuth,
      payload: {
        organization_id: org.organization_id,
        actor_id: org.admin_user_id,
        skill_id: "nova.social.draft",
        risk_tier: "medium",
        request: { brand_id: "acme" },
      },
    });
    expect(opened.statusCode).toBe(200);
    const executionId = opened.json().execution_id as string;
    const verityRecordId = opened.json().verity_record_id as string;

    const started = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/skill/start`,
      headers: novaAuth,
      payload: {
        skill_id: "nova.social.draft",
        skill_version: "1.0.0",
        brand_id: "acme",
        config_hash: sha256("acme-config-v1"),
      },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().event_type).toBe("nova.skill.started");

    const executed = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/model/execute`,
      headers: novaAuth,
      payload: {
        task: "nova.social.draft",
        risk_tier: "medium",
        data_classification: "internal",
        content: "Draft a facebook post in a warm neighbor voice.",
        prefer_local: true,
      },
    });
    expect(executed.statusCode).toBe(200);
    const artifact = executed.json().text as string;
    const artifactHash = executed.json().output_hash as string;
    expect(artifactHash).toBe(sha256(artifact));

    const requested = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/approval/request`,
      headers: novaAuth,
      payload: {
        skill_id: "nova.social.draft",
        requested_by: systemActorId,
        artifact_hash: artifactHash,
      },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json().status).toBe("waiting_approval");
    const approvalId = requested.json().approval_id as string;
    const waiting = await getExecution(pool, org.organization_id, executionId);
    expect(waiting?.status).toBe("waiting_approval");

    const premature = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/finalize`,
      headers: novaAuth,
      payload: { outcome: "completed" },
    });
    expect(premature.statusCode).toBe(409);
    expect(premature.json().error.code).toBe("APPROVAL_PENDING");

    const mismatch = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/approval/decide`,
      headers: novaAuth,
      payload: {
        approval_id: approvalId,
        actor_id: org.admin_user_id,
        allow: true,
        artifact_hash: sha256("different-artifact"),
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("ARTIFACT_HASH_MISMATCH");

    const decided = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/approval/decide`,
      headers: novaAuth,
      payload: {
        approval_id: approvalId,
        actor_id: org.admin_user_id,
        allow: true,
        artifact_hash: artifactHash,
      },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe("approved");

    const completed = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/skill/complete`,
      headers: novaAuth,
      payload: {
        skill_id: "nova.social.draft",
        skill_version: "1.0.0",
        result_artifact_hash: artifactHash,
      },
    });
    expect(completed.statusCode).toBe(200);

    const finalized = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/finalize`,
      headers: novaAuth,
      payload: { outcome: "completed" },
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json().verity_record_id).toBe(verityRecordId);

    const events = await listExecutionEvents(pool, org.organization_id, executionId);
    const types = events.map((event) => event.event_type);
    expect(types).toContain("nova.skill.started");
    expect(types).toContain("nova.skill.completed");
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.approved");
    expect(events.find((event) => event.event_type === "nova.skill.started")?.metadata).toMatchObject({
      skill_id: "nova.social.draft",
      brand_id: "acme",
    });
    expect(events.find((event) => event.event_type === "approval.requested")?.metadata).toMatchObject({
      artifact_hash: artifactHash,
    });

    const record = await app.inject({
      method: "GET",
      url: `/internal/v1/executions/${executionId}/record`,
      headers: novaAuth,
    });
    expect(record.statusCode).toBe(200);
    expect(record.json().integrity_status).toBe("not_verified");

    const bundle = await exportOrganizationEvidence(pool, org.organization_id);
    expect(verifyEvidenceBundle(bundle).valid).toBe(true);

    const other = await createOrg(app, platformToken, "Other Nova Org");
    const cross = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/skill/start`,
      headers: {
        authorization: `Bearer ${
          (
            await app.inject({
              method: "POST",
              url: "/internal/v1/service-credentials",
              headers: { authorization: `Bearer ${platformToken}` },
              payload: {
                name: "nova-other",
                organization_id: other.organization_id,
                scopes: ["knowledge.read", "models.read", "executions.write"],
              },
            })
          ).json().token
        }`,
      },
      payload: { skill_id: "nova.social.draft", skill_version: "1.0.0" },
    });
    expect(cross.statusCode).toBe(404);
  });

  it("records rejection without completing the execution", async () => {
    const org = await createOrg(app, platformToken, "Nova Reject Org");
    const admin = await login(app, org.email, org.password);
    const member = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: sessionHeaders(admin.cookie),
      payload: {
        email: `sys-${randomUUID().slice(0, 8)}@example.test`,
        password: "correct-horse-battery",
        display_name: "System",
        role_id: org.member_role_id,
      },
    });
    const novaCred = await app.inject({
      method: "POST",
      url: "/internal/v1/service-credentials",
      headers: { authorization: `Bearer ${platformToken}` },
      payload: {
        name: "nova-reject",
        organization_id: org.organization_id,
        scopes: ["knowledge.read", "models.read", "executions.write"],
      },
    });
    const novaAuth = { authorization: `Bearer ${novaCred.json().token}` };
    const opened = await app.inject({
      method: "POST",
      url: "/internal/v1/executions",
      headers: novaAuth,
      payload: {
        organization_id: org.organization_id,
        actor_id: org.admin_user_id,
        skill_id: "nova.social.draft",
        risk_tier: "medium",
        request: {},
      },
    });
    const executionId = opened.json().execution_id as string;
    await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/skill/start`,
      headers: novaAuth,
      payload: { skill_id: "nova.social.draft", skill_version: "1.0.0" },
    });
    const executed = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/model/execute`,
      headers: novaAuth,
      payload: {
        task: "nova.social.draft",
        risk_tier: "medium",
        data_classification: "internal",
        content: "draft",
        prefer_local: true,
      },
    });
    const artifactHash = executed.json().output_hash as string;
    const requested = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/approval/request`,
      headers: novaAuth,
      payload: {
        skill_id: "nova.social.draft",
        requested_by: member.json().user_id,
        artifact_hash: artifactHash,
      },
    });
    await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/approval/decide`,
      headers: novaAuth,
      payload: {
        approval_id: requested.json().approval_id,
        actor_id: org.admin_user_id,
        allow: false,
        artifact_hash: artifactHash,
      },
    });
    await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/skill/fail`,
      headers: novaAuth,
      payload: {
        skill_id: "nova.social.draft",
        skill_version: "1.0.0",
        reason_code: "APPROVAL_REJECTED",
      },
    });
    const finalized = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${executionId}/finalize`,
      headers: novaAuth,
      payload: { outcome: "blocked" },
    });
    expect(finalized.statusCode).toBe(200);
    const events = await listExecutionEvents(pool, org.organization_id, executionId);
    expect(events.some((event) => event.event_type === "approval.rejected")).toBe(true);
    expect(events.some((event) => event.event_type === "nova.skill.failed")).toBe(true);
    const done = await getExecution(pool, org.organization_id, executionId);
    expect(done?.status).toBe("blocked");
  });

  it("does not grant platform.cross_org to Nova credentials", async () => {
    const org = await createOrg(app, platformToken, "Nova Scope Org");
    const created = await app.inject({
      method: "POST",
      url: "/internal/v1/service-credentials",
      headers: { authorization: `Bearer ${platformToken}` },
      payload: {
        name: "nova-no-root",
        organization_id: org.organization_id,
        scopes: ["knowledge.read", "models.read", "executions.write"],
      },
    });
    expect(created.statusCode).toBe(200);
    const credentialId = created.json().id as string;
    const row = await pool.query<{ scopes: string[]; organization_id: string | null }>(
      `SELECT scopes, organization_id FROM auth.service_credentials WHERE id = $1`,
      [credentialId]
    );
    expect(row.rows[0].organization_id).toBe(org.organization_id);
    expect(row.rows[0].scopes).not.toContain("platform.cross_org");

    const denied = await app.inject({
      method: "POST",
      url: "/internal/v1/service-credentials",
      headers: { authorization: `Bearer ${platformToken}` },
      payload: {
        name: "nova-cross",
        organization_id: org.organization_id,
        scopes: ["knowledge.read", "models.read", "executions.write", "platform.cross_org"],
      },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.code).toBe("INVALID_SCOPE");
    expect(TEST_ORIGIN).toBeTruthy();
  });
});
