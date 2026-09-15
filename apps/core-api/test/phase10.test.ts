import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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

const pool = createPool();
let app: FastifyInstance;
let platformToken = "";

beforeAll(async () => {
  await pool.query("SELECT 1");
  platformToken = await seedPlatformService(pool);
  app = await startApp(pool, {
    novaInvoke: async (path, init) => {
      if (path === "/health") {
        return { status: "ok", phase: "10", version: "0.10.0" };
      }
      if (path === "/internal/v1/skills") {
        return {
          skills: [
            {
              id: "nova.research",
              name: "Institutional Research",
              version: "1.0.0",
              risk_tier: "medium",
              knowledge_mode: "strict",
              approval: false,
            },
          ],
        };
      }
      if (path.endsWith("/execute")) {
        return {
          execution_id: randomUUID(),
          verity_record_id: randomUUID(),
          status: "completed",
          artifact: "Paris is the capital of France.",
          citations: [{ title: "Fact sheet" }],
        };
      }
      return { ok: true, path, method: init?.method ?? "GET" };
    },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("Phase 10 Core shell facade", () => {
  it("returns session profile without secrets", async () => {
    const org = await createOrg(app, platformToken, "Shell Me");
    const session = await login(app, org.email, org.password);
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: sessionHeaders(session.cookie),
    });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user_id).toBe(org.admin_user_id);
    expect(body.email).toBe(org.email);
    expect(body.display_name).toContain("Admin");
    expect(body.organization_id).toBe(org.organization_id);
    expect(body.organization).toBeTruthy();
    expect(body.role).toBe("admin");
    expect(body.permissions).toContain("audit.read");
    expect(JSON.stringify(body)).not.toMatch(/password_hash|scrypt|DATABASE_URL/);
  });

  it("returns empty home summary from backend counts", async () => {
    const org = await createOrg(app, platformToken, "Shell Home Empty");
    const session = await login(app, org.email, org.password);
    const summary = await app.inject({
      method: "GET",
      url: "/v1/home/summary",
      headers: sessionHeaders(session.cookie),
    });
    expect(summary.statusCode).toBe(200);
    const body = summary.json();
    expect(body.knowledge.approved_sources).toBe(0);
    expect(body.knowledge.collections).toBe(0);
    expect(body.approvals.pending).toBe(0);
    expect(body.audit.recent_records).toEqual([]);
    expect(body.system.database).toBe(true);
  });

  it("lists Nova skills from the command catalog when Nova is unconfigured", async () => {
    const isolated = await startApp(pool);
    const org = await createOrg(isolated, platformToken, "Shell Skills");
    const session = await login(isolated, org.email, org.password);
    const skills = await isolated.inject({
      method: "GET",
      url: "/v1/nova/skills",
      headers: sessionHeaders(session.cookie),
    });
    expect(skills.statusCode).toBe(200);
    expect(skills.json().source).toBe("command");
    expect(skills.json().skills.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining(["nova.research", "nova.drafting", "nova.social.draft"])
    );
    await isolated.close();
  });

  it("rejects client-supplied actor or organization on Nova execute", async () => {
    const org = await createOrg(app, platformToken, "Shell Untrusted");
    const session = await login(app, org.email, org.password);
    const forged = await app.inject({
      method: "POST",
      url: "/v1/nova/skills/nova.research/execute",
      headers: sessionHeaders(session.cookie),
      payload: { question: "hi", actor_id: randomUUID(), organization_id: randomUUID() },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe("UNTRUSTED_ACTOR");
    expect(forged.json().error.request_id).toBeTruthy();
  });

  it("derives actor from the session when executing Nova", async () => {
    const org = await createOrg(app, platformToken, "Shell Execute");
    const session = await login(app, org.email, org.password);
    const executed = await app.inject({
      method: "POST",
      url: "/v1/nova/skills/nova.research/execute",
      headers: sessionHeaders(session.cookie),
      payload: { question: "What is the capital of France?" },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().status).toBe("completed");
    expect(executed.json().artifact).toContain("Paris");
  });

  it("omits blob paths from source detail and reports request_id on errors", async () => {
    const org = await createOrg(app, platformToken, "Shell Source");
    const session = await login(app, org.email, org.password);
    const created = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(session.cookie),
      payload: { name: "Policy", classification: "internal" },
    });
    const collectionId = created.json().collection_id as string;
    const uploaded = await app.inject({
      method: "POST",
      url: `/v1/knowledge/collections/${collectionId}/sources`,
      headers: {
        ...sessionHeaders(session.cookie),
        "content-type": "multipart/form-data; boundary=----veritytest",
      },
      payload: markdownPart("policy.md", "Institutional policy text.", "Policy"),
    });
    const sourceId = uploaded.json().source_id as string;
    const detail = await app.inject({
      method: "GET",
      url: `/v1/knowledge/sources/${sourceId}`,
      headers: sessionHeaders(session.cookie),
    });
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json())).not.toMatch(/blob_uri|\/data\//);
    expect(detail.json().versions[0].content_hash).toBeTruthy();

    const missing = await app.inject({
      method: "GET",
      url: `/v1/knowledge/sources/${randomUUID()}`,
      headers: sessionHeaders(session.cookie),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.request_id).toBeTruthy();
  });

  it("returns safe system status and connector views without secrets", async () => {
    const org = await createOrg(app, platformToken, "Shell System");
    const session = await login(app, org.email, org.password);
    const status = await app.inject({
      method: "GET",
      url: "/v1/system/status",
      headers: sessionHeaders(session.cookie),
    });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.core.phase).toBe("11");
    expect(body.nova.status).toBe("ok");
    expect(JSON.stringify(body)).not.toMatch(
      /DATABASE_URL|NOVA_INTERNAL_TOKEN|META_PAGE_ACCESS_TOKEN|password_hash|xoxb-/
    );

    const connectors = await app.inject({
      method: "GET",
      url: "/v1/connectors",
      headers: sessionHeaders(session.cookie),
    });
    expect(connectors.statusCode).toBe(200);
    const dumped = JSON.stringify(connectors.json());
    expect(dumped).not.toMatch(/access_token|Bearer |page_access/);
    expect(connectors.json().connectors[0].name).toBe("meta.facebook");
  });

  it("does not render another organization's records on home or audit", async () => {
    const orgA = await createOrg(app, platformToken, "Shell Org A");
    const orgB = await createOrg(app, platformToken, "Shell Org B");
    const adminA = await login(app, orgA.email, orgA.password);
    const adminB = await login(app, orgB.email, orgB.password);
    await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(adminA.cookie),
      payload: { name: "A only", classification: "internal" },
    });
    const homeB = await app.inject({
      method: "GET",
      url: "/v1/home/summary",
      headers: sessionHeaders(adminB.cookie),
    });
    expect(homeB.json().knowledge.collections).toBe(0);
    const collectionsB = await app.inject({
      method: "GET",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(adminB.cookie),
    });
    expect(
      collectionsB.json().collections.every((c: { name: string }) => c.name !== "A only")
    ).toBe(true);
    const usersB = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: sessionHeaders(adminB.cookie),
    });
    expect(usersB.json().users.every((u: { email: string }) => u.email !== orgA.email)).toBe(true);
  });

  it("hides command user management from members", async () => {
    const org = await createOrg(app, platformToken, "Shell Member");
    const admin = await login(app, org.email, org.password);
    const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
    await app.inject({
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
    const member = await login(app, memberEmail, "member-horse-battery");
    const denied = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: sessionHeaders(member.cookie),
    });
    expect(denied.statusCode).toBe(403);
    const home = await app.inject({
      method: "GET",
      url: "/v1/home/summary",
      headers: sessionHeaders(member.cookie),
    });
    expect(home.statusCode).toBe(200);
  });

  it("requires origin on cookie-authenticated writes", async () => {
    const org = await createOrg(app, platformToken, "Shell Origin");
    const session = await login(app, org.email, org.password);
    const denied = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: session.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("ORIGIN_DENIED");
    const ok = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: sessionHeaders(session.cookie),
    });
    expect(ok.statusCode).toBe(200);
  });
});
