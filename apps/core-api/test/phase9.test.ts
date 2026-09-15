import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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
const calls: { url: string; body: string; method: string }[] = [];
let mode: "ok" | "auth" | "reject" | "timeout" = "ok";
let app: FastifyInstance;
let platformToken = "";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

beforeAll(async () => {
  await pool.query("SELECT 1");
  platformToken = await seedPlatformService(pool);
  app = await startApp(pool, {
    secretResolver: (ref) => (ref === "META_TEST_TOKEN" ? "fake-page-token" : undefined),
    connectorFetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: String(init?.body ?? ""),
        method: String(init?.method ?? "GET"),
      });
      if (String(init?.method ?? "GET").toUpperCase() === "POST" && String(url).includes("/feed")) {
        const pending = await pool.query(
          `SELECT status FROM command.connector_actions
           WHERE status IN ('authorized','executing')
           ORDER BY created_at DESC LIMIT 1`
        );
        if (pending.rowCount === 0) {
          throw new Error("connector action was not persisted before network call");
        }
        if (mode === "timeout") {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
      }
      if (mode === "auth") {
        return new Response(JSON.stringify({ error: { message: "invalid token" } }), { status: 401 });
      }
      if (mode === "reject") {
        return new Response(JSON.stringify({ error: { message: "blocked" } }), { status: 400 });
      }
      if (String(url).includes("fields=name")) {
        return new Response(JSON.stringify({ name: "Acme Page" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "111_222" }), { status: 200 });
    },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function enableMeta(organizationId: string) {
  const updated = await pool.query<{ id: string }>(
    `UPDATE command.connectors
     SET enabled = true,
         secret_ref = 'META_TEST_TOKEN',
         page_config = jsonb_build_object('page_id', 'page-acme')
     WHERE organization_id = $1 AND connector_key = 'meta.facebook'
     RETURNING id`,
    [organizationId]
  );
  return updated.rows[0].id;
}

async function novaAuth(organizationId: string) {
  const cred = await app.inject({
    method: "POST",
    url: "/internal/v1/service-credentials",
    headers: { authorization: `Bearer ${platformToken}` },
    payload: {
      name: `nova-${randomUUID().slice(0, 8)}`,
      organization_id: organizationId,
      scopes: ["knowledge.read", "models.read", "executions.write"],
    },
  });
  return { authorization: `Bearer ${cred.json().token}` };
}

async function socialDraft(
  appInst: FastifyInstance,
  org: Awaited<ReturnType<typeof createOrg>>,
  auth: { authorization: string },
  message: string
) {
  const artifactHash = sha256(message);
  const opened = await appInst.inject({
    method: "POST",
    url: "/internal/v1/executions",
    headers: auth,
    payload: {
      organization_id: org.organization_id,
      actor_id: org.admin_user_id,
      skill_id: "nova.social.draft",
      risk_tier: "medium",
      request: { brand_id: "acme" },
    },
  });
  const executionId = opened.json().execution_id as string;
  await appInst.inject({
    method: "POST",
    url: `/internal/v1/executions/${executionId}/skill/start`,
    headers: auth,
    payload: { skill_id: "nova.social.draft", skill_version: "1.0.0", brand_id: "acme" },
  });
  await appInst.inject({
    method: "POST",
    url: `/internal/v1/executions/${executionId}/model/execute`,
    headers: auth,
    payload: {
      task: "nova.social.draft",
      risk_tier: "medium",
      data_classification: "internal",
      content: message,
      prefer_local: true,
    },
  });
  const member = await appInst.inject({
    method: "POST",
    url: "/v1/users",
    headers: sessionHeaders((await login(appInst, org.email, org.password)).cookie),
    payload: {
      email: `actor-${randomUUID().slice(0, 8)}@example.test`,
      password: "correct-horse-battery",
      display_name: "Requester",
      role_id: org.member_role_id,
    },
  });
  const requested = await appInst.inject({
    method: "POST",
    url: `/internal/v1/executions/${executionId}/approval/request`,
    headers: auth,
    payload: {
      skill_id: "nova.social.draft",
      requested_by: member.json().user_id,
      artifact_hash: artifactHash,
    },
  });
  return {
    executionId,
    artifactHash,
    requesterId: member.json().user_id as string,
    approvalId: requested.json().approval_id as string,
  };
}

async function approveDraft(
  auth: { authorization: string },
  org: Awaited<ReturnType<typeof createOrg>>,
  draft: Awaited<ReturnType<typeof socialDraft>>
) {
  await app.inject({
    method: "POST",
    url: `/internal/v1/executions/${draft.executionId}/approval/decide`,
    headers: auth,
    payload: {
      approval_id: draft.approvalId,
      actor_id: org.admin_user_id,
      allow: true,
      artifact_hash: draft.artifactHash,
    },
  });
}

describe("Phase 9 Connector Gateway", () => {
  it("runs the governed publish e2e exit gate", async () => {
    mode = "ok";
    calls.length = 0;
    const org = await createOrg(app, platformToken, "Phase9 Publish Org");
    const connectorId = await enableMeta(org.organization_id);
    const auth = await novaAuth(org.organization_id);
    const message = "Exact approved Facebook draft";
    const draft = await socialDraft(app, org, auth, message);
    await approveDraft(auth, org, draft);
    await pool.query(
      `INSERT INTO social.brands (id, organization_id, brand_id, display_name, active, config_version)
       VALUES ($1,$2,'acme','Acme', true, 1)`,
      [randomUUID(), org.organization_id]
    );
    await pool.query(
      `INSERT INTO social.content_items (
         id, organization_id, brand_id, platform, draft_text, status, artifact_hash, execution_id
       ) VALUES ($1,$2,'acme','facebook',$3,'approved',$4,$5)`,
      [randomUUID(), org.organization_id, message, draft.artifactHash, draft.executionId]
    );

    const published = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        connector_type: "meta.facebook",
        action: "publish_post",
        artifact_hash: draft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().status).toBe("succeeded");
    expect(published.json().external_action_id).toBe("111_222");
    expect(published.json().artifact_hash).toBe(draft.artifactHash);
    expect(JSON.stringify(published.json())).not.toContain("fake-page-token");
    const feed = calls.find((row) => row.body.includes("message="));
    const params = new URLSearchParams(feed?.body ?? "");
    expect(params.get("message")).toBe(message);
    expect(sha256(params.get("message") ?? "")).toBe(draft.artifactHash);
    expect(sha256(message)).toBe(draft.artifactHash);

    const loadedAction = await app.inject({
      method: "GET",
      url: `/internal/v1/executions/${draft.executionId}/connectors/actions/${published.json().action_id}`,
      headers: auth,
    });
    expect(loadedAction.statusCode).toBe(200);
    expect(loadedAction.json().external_action_id).toBe("111_222");
    expect(loadedAction.json().status).toBe("succeeded");
    expect(loadedAction.json().request_hash).toBeTruthy();

    const item = await pool.query<{ status: string; external_action_id: string | null }>(
      `SELECT status, external_action_id FROM social.content_items
       WHERE organization_id = $1 AND execution_id = $2`,
      [org.organization_id, draft.executionId]
    );
    expect(item.rows[0].status).toBe("posted");
    expect(item.rows[0].external_action_id).toBe("111_222");

    await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft.executionId}/skill/complete`,
      headers: auth,
      payload: {
        skill_id: "nova.social.draft",
        skill_version: "1.0.0",
        result_artifact_hash: draft.artifactHash,
      },
    });
    const finalized = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft.executionId}/finalize`,
      headers: auth,
      payload: { outcome: "completed" },
    });
    expect(finalized.statusCode).toBe(200);
    const events = await listExecutionEvents(pool, org.organization_id, draft.executionId);
    const types = events.map((event) => event.event_type);
    expect(types).toEqual(expect.arrayContaining(["tool.requested", "tool.authorized", "tool.completed"]));
    expect(events.some((event) => JSON.stringify(event.metadata).includes("fake-page-token"))).toBe(false);
    const completed = events.find((event) => event.event_type === "tool.completed");
    expect(completed?.metadata).toMatchObject({
      connector_type: "meta.facebook",
      action: "publish_post",
      external_action_id: "111_222",
    });
    const record = await app.inject({
      method: "GET",
      url: `/internal/v1/executions/${draft.executionId}/record`,
      headers: auth,
    });
    expect(record.statusCode).toBe(200);
    const bundle = await exportOrganizationEvidence(pool, org.organization_id);
    expect(verifyEvidenceBundle(bundle).valid).toBe(true);
    const session = sessionHeaders((await login(app, org.email, org.password)).cookie);
    const verified = await app.inject({
      method: "POST",
      url: `/v1/audit/records/${record.json().verity_record_id}/verify`,
      headers: session,
    });
    expect(verified.json().integrity_verified).toBe(true);
    expect(verified.json().provenance_verified).toBe(true);
    const health = await app.inject({
      method: "POST",
      url: `/internal/v1/connectors/${connectorId}/health`,
      headers: auth,
    });
    expect(health.json().ok).toBe(true);
    expect(health.json().page_name).toBe("Acme Page");
    expect(JSON.stringify(health.json())).not.toContain("fake-page-token");
    const loaded = await getExecution(pool, org.organization_id, draft.executionId);
    expect(loaded?.status).toBe("completed");
    expect(TEST_ORIGIN).toBeTruthy();
  });

  it("denies disabled, missing, rejected, mismatched, unauthorized, and cross-org connector use", async () => {
    mode = "ok";
    const org = await createOrg(app, platformToken, "Phase9 Deny Org");
    const other = await createOrg(app, platformToken, "Phase9 Other Org");
    const auth = await novaAuth(org.organization_id);
    const message = "Denied draft";
    const draft = await socialDraft(app, org, auth, message);
    await approveDraft(auth, org, draft);
    const disabled = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_type: "meta.facebook",
        action: "publish_post",
        artifact_hash: draft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().error.code).toBe("CONNECTOR_DISABLED");
    const deniedEvents = await listExecutionEvents(pool, org.organization_id, draft.executionId);
    expect(deniedEvents.some((event) => event.event_type === "tool.denied")).toBe(true);

    const connectorId = await enableMeta(org.organization_id);
    const waiting = await socialDraft(app, org, auth, message);
    const missing = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${waiting.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: waiting.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(missing.json().error.code).toBe("APPROVAL_MISSING");

    const rejectDraft = await socialDraft(app, org, auth, message);
    await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${rejectDraft.executionId}/approval/decide`,
      headers: auth,
      payload: {
        approval_id: rejectDraft.approvalId,
        actor_id: org.admin_user_id,
        allow: false,
        artifact_hash: rejectDraft.artifactHash,
      },
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${rejectDraft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: rejectDraft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(rejected.json().error.code).toBe("APPROVAL_MISSING");
    const rejectEvents = await listExecutionEvents(pool, org.organization_id, rejectDraft.executionId);
    expect(rejectEvents.some((event) => event.event_type.startsWith("tool."))).toBe(false);

    const draft2 = await socialDraft(app, org, auth, message);
    await approveDraft(auth, org, draft2);
    const mismatch = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft2.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: draft2.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message: "mutated after approval" },
      },
    });
    expect(mismatch.json().error.code).toBe("APPROVAL_ARTIFACT_MISMATCH");

    const unauthorized = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft2.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: draft2.artifactHash,
        actor_id: randomUUID(),
        payload: { message },
      },
    });
    expect(unauthorized.json().error.code).toBe("ACTOR_NOT_AUTHORIZED");

    const otherAuth = await novaAuth(other.organization_id);
    const cross = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft2.executionId}/connectors/actions`,
      headers: otherAuth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: draft2.artifactHash,
        actor_id: other.admin_user_id,
        payload: { message },
      },
    });
    expect(cross.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("enforces skill binding and classification on connector actions", async () => {
    mode = "ok";
    const org = await createOrg(app, platformToken, "Phase9 Policy Org");
    const connectorId = await enableMeta(org.organization_id);
    const auth = await novaAuth(org.organization_id);
    const message = "Policy draft";
    const draft = await socialDraft(app, org, auth, message);
    await approveDraft(auth, org, draft);

    await pool.query(
      `DELETE FROM command.skill_connectors
       WHERE organization_id = $1 AND skill_id = 'nova.social.draft' AND connector_key = 'meta.facebook'`,
      [org.organization_id]
    );
    const skillDenied = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: draft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(skillDenied.json().error.code).toBe("CONNECTOR_NOT_ALLOWED_FOR_SKILL");

    await pool.query(
      `INSERT INTO command.skill_connectors (organization_id, skill_id, connector_key, actions)
       VALUES ($1, 'nova.social.draft', 'meta.facebook', '["publish_post","schedule_post"]'::jsonb)`,
      [org.organization_id]
    );
    await pool.query(
      `UPDATE command.connectors
       SET allowed_data_classes_json = '["public"]'::jsonb
       WHERE id = $1`,
      [connectorId]
    );
    const classified = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: draft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(classified.json().error.code).toBe("CLASSIFICATION_BLOCKED");
  });

  it("persists the action before the network call and replays idempotently", async () => {
    mode = "ok";
    calls.length = 0;
    const org = await createOrg(app, platformToken, "Phase9 Idempotent Org");
    const connectorId = await enableMeta(org.organization_id);
    const auth = await novaAuth(org.organization_id);
    const message = "Idempotent draft";
    const draft = await socialDraft(app, org, auth, message);
    await approveDraft(auth, org, draft);
    const first = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: draft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(first.json().status).toBe("succeeded");
    const persisted = await pool.query<{ status: string }>(
      `SELECT status FROM command.connector_actions WHERE id = $1`,
      [first.json().action_id]
    );
    expect(persisted.rows[0].status).toBe("succeeded");
    const networkCalls = calls.filter((row) => row.method === "POST").length;
    const second = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: draft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(second.json().replayed).toBe(true);
    expect(second.json().action_id).toBe(first.json().action_id);
    expect(calls.filter((row) => row.method === "POST").length).toBe(networkCalls);
  });

  it("schedules, fails closed on provider errors, and marks timeout as needs_review without retry", async () => {
    const org = await createOrg(app, platformToken, "Phase9 Schedule Org");
    const connectorId = await enableMeta(org.organization_id);
    const auth = await novaAuth(org.organization_id);
    const message = "Scheduled draft";
    const draft = await socialDraft(app, org, auth, message);
    await approveDraft(auth, org, draft);
    await pool.query(
      `INSERT INTO social.content_items (
         id, organization_id, brand_id, platform, draft_text, status, artifact_hash, execution_id
       ) VALUES ($1,$2,'acme','facebook',$3,'approved',$4,$5)`,
      [randomUUID(), org.organization_id, message, draft.artifactHash, draft.executionId]
    );
    mode = "ok";
    const scheduledFor = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const scheduled = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${draft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "schedule_post",
        artifact_hash: draft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message, scheduled_for: scheduledFor },
      },
    });
    expect(scheduled.json().status).toBe("succeeded");
    const scheduledItem = await pool.query<{ status: string; scheduled_for: Date | null }>(
      `SELECT status, scheduled_for FROM social.content_items
       WHERE organization_id = $1 AND execution_id = $2`,
      [org.organization_id, draft.executionId]
    );
    expect(scheduledItem.rows[0].status).toBe("scheduled");
    expect(scheduledItem.rows[0].scheduled_for).toBeTruthy();

    const failDraft = await socialDraft(app, org, auth, message);
    await approveDraft(auth, org, failDraft);
    mode = "auth";
    const authFail = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${failDraft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: failDraft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(authFail.json().status).toBe("failed");
    expect(authFail.json().error_code).toBe("PROVIDER_AUTH_FAILED");

    const rejectDraft = await socialDraft(app, org, auth, message);
    await approveDraft(auth, org, rejectDraft);
    mode = "reject";
    const rejected = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${rejectDraft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: rejectDraft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message },
      },
    });
    expect(rejected.json().status).toBe("failed");
    expect(rejected.json().error_code).toBe("PROVIDER_REJECTED");

    const timeoutDraft = await socialDraft(app, org, auth, "Timeout draft");
    await approveDraft(auth, org, timeoutDraft);
    await pool.query(
      `INSERT INTO social.content_items (
         id, organization_id, brand_id, platform, draft_text, status, artifact_hash, execution_id
       ) VALUES ($1,$2,'acme','facebook',$3,'approved',$4,$5)`,
      [randomUUID(), org.organization_id, "Timeout draft", timeoutDraft.artifactHash, timeoutDraft.executionId]
    );
    const timeoutCalls = calls.filter((row) => row.method === "POST").length;
    mode = "timeout";
    const timed = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${timeoutDraft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: timeoutDraft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message: "Timeout draft" },
      },
    });
    expect(timed.json().status).toBe("needs_review");
    const timeoutItem = await pool.query<{ status: string }>(
      `SELECT status FROM social.content_items WHERE execution_id = $1`,
      [timeoutDraft.executionId]
    );
    expect(timeoutItem.rows[0].status).toBe("needs_review");
    const events = await listExecutionEvents(pool, org.organization_id, timeoutDraft.executionId);
    expect(events.some((event) => event.event_type === "tool.failed")).toBe(true);
    mode = "ok";
    const replay = await app.inject({
      method: "POST",
      url: `/internal/v1/executions/${timeoutDraft.executionId}/connectors/actions`,
      headers: auth,
      payload: {
        connector_id: connectorId,
        action: "publish_post",
        artifact_hash: timeoutDraft.artifactHash,
        actor_id: org.admin_user_id,
        payload: { message: "Timeout draft" },
      },
    });
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().status).toBe("needs_review");
    expect(calls.filter((row) => row.method === "POST").length).toBe(timeoutCalls + 1);
  });
});
