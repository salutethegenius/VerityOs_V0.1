import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertDemoResetAllowed,
  ConfigError,
  DEFAULT_SESSION_SECRET,
  loadConfig,
} from "../src/runtime-config.js";
import { redact } from "../src/log.js";
import { createRole } from "@verityos/identity";
import { limiters } from "../src/rate-limit.js";
import { wipeOrganization } from "../src/demo-wipe.js";
import {
  TEST_ORIGIN,
  createOrg,
  createPool,
  login,
  markdownPart,
  seedPlatformService,
  sessionCookie,
  sessionHeaders,
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

describe("startup config validation", () => {
  it("rejects invalid profiles and silent mock fallback outside development", () => {
    expect(() => loadConfig({ VERITY_PROFILE: "prod" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        VERITY_PROFILE: "demo",
        DATABASE_URL: "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit",
        CORS_ORIGIN: "http://127.0.0.1:3000",
        SESSION_SECRET: "abcdefghijklmnopqrstuvwxyz012345",
        VERITY_DATA_DIR: "/tmp/verity-data",
      })
    ).toThrow(/VERITY_EMBEDDING_PROVIDER/);
    expect(() =>
      loadConfig({
        VERITY_PROFILE: "sovereign",
        DATABASE_URL: "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit",
        CORS_ORIGIN: "http://127.0.0.1:3000",
        SESSION_SECRET: "abcdefghijklmnopqrstuvwxyz012345",
        VERITY_DATA_DIR: "/tmp/verity-data",
        VERITY_EMBEDDING_PROVIDER: "mock",
      })
    ).toThrow(/VERITY_ALLOW_MOCK/);
    expect(() =>
      loadConfig({
        VERITY_PROFILE: "demo",
        DATABASE_URL: "not-a-url",
        CORS_ORIGIN: "http://127.0.0.1:3000",
        SESSION_SECRET: "abcdefghijklmnopqrstuvwxyz012345",
        VERITY_DATA_DIR: "/tmp/verity-data",
        VERITY_EMBEDDING_PROVIDER: "mock",
      })
    ).toThrow(/postgres URL/);
    expect(() =>
      loadConfig({
        VERITY_PROFILE: "demo",
        DATABASE_URL: "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit",
        CORS_ORIGIN: "http://127.0.0.1:3000",
        SESSION_SECRET: DEFAULT_SESSION_SECRET,
        VERITY_DATA_DIR: "/tmp/verity-data",
        VERITY_EMBEDDING_PROVIDER: "mock",
      })
    ).toThrow(/SESSION_SECRET/);
    expect(() =>
      loadConfig({
        VERITY_PROFILE: "demo",
        DATABASE_URL: "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit",
        CORS_ORIGIN: "http://127.0.0.1:3000",
        SESSION_SECRET: "abcdefghijklmnopqrstuvwxyz012345",
        VERITY_DATA_DIR: "/tmp/verity-data",
        VERITY_EMBEDDING_PROVIDER: "mock",
        VERITY_EMBEDDING_DIMENSIONS: "64",
      })
    ).toThrow(/768/);
    const demo = loadConfig({
      VERITY_PROFILE: "demo",
      DATABASE_URL: "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit",
      CORS_ORIGIN: "https://shell.example.test",
      SESSION_SECRET: "abcdefghijklmnopqrstuvwxyz012345",
      VERITY_DATA_DIR: "/tmp/verity-data",
      VERITY_EMBEDDING_PROVIDER: "mock",
    });
    expect(demo.cookieSecure).toBe(true);
    expect(demo.embeddingProvider).toBe("mock");
    expect(demo.profile).toBe("demo");
  });

  it("refuses demo reset unless the environment is explicitly marked", () => {
    expect(() => assertDemoResetAllowed({ VERITY_PROFILE: "sovereign", VERITY_DEMO_RESET: "1" })).toThrow(
      /demo reset refused/
    );
    expect(() => assertDemoResetAllowed({ VERITY_PROFILE: "demo" })).toThrow(/VERITY_DEMO_RESET/);
    expect(() => assertDemoResetAllowed({ VERITY_PROFILE: "demo", VERITY_DEMO_RESET: "1" })).not.toThrow();
    expect(() => assertDemoResetAllowed({ VERITY_PROFILE: "development", VERITY_DEMO_RESET: "1" })).not.toThrow();
  });

  it("resolves seed files against the repository root, not apps/core-api cwd", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { repoRootFromModuleUrl } = await import("../src/seed-paths.js");
    const root = repoRootFromModuleUrl();
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(true);
    expect(root.endsWith("apps/core-api")).toBe(false);
  });

  it("can wipe a demo org that already has append-only Audit rows", async () => {
    const org = await createOrg(app, serviceToken, "Wipe Audit Org");
    const executionId = randomUUID();
    await pool.query(
      `INSERT INTO audit.executions (id, verity_record_id, organization_id, status, risk_tier)
       VALUES ($1, $2, $3, 'created', 'low')`,
      [executionId, `vr-${executionId}`, org.organization_id]
    );
    await pool.query(
      `INSERT INTO audit.execution_events (
         id, organization_id, execution_id, event_sequence, event_type, status,
         occurred_at, occurred_at_canonical
       ) VALUES ($1, $2, $3, 1, 'execution.created', 'ok', now(), to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
      [randomUUID(), org.organization_id, executionId]
    );
    await wipeOrganization(pool, org.organization_id);
    const leftover = await pool.query(`SELECT 1 FROM auth.organizations WHERE id = $1`, [org.organization_id]);
    expect(leftover.rowCount).toBe(0);

    const leftoverOrg = await createOrg(app, serviceToken, "Append Only Still On");
    const leftoverExecution = randomUUID();
    await pool.query(
      `INSERT INTO audit.executions (id, verity_record_id, organization_id, status, risk_tier)
       VALUES ($1, $2, $3, 'created', 'low')`,
      [leftoverExecution, `vr-${leftoverExecution}`, leftoverOrg.organization_id]
    );
    await pool.query(
      `INSERT INTO audit.execution_events (
         id, organization_id, execution_id, event_sequence, event_type, status,
         occurred_at, occurred_at_canonical
       ) VALUES ($1, $2, $3, 1, 'execution.created', 'ok', now(), to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
      [randomUUID(), leftoverOrg.organization_id, leftoverExecution]
    );
    await expect(
      pool.query(`DELETE FROM audit.execution_events WHERE organization_id = $1`, [leftoverOrg.organization_id])
    ).rejects.toThrow(/append-only/);
  });
});

describe("security headers, request ids, health", () => {
  it("sets security headers and echoes request_id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { "x-request-id": "req-phase11" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().phase).toBe("11");
    expect(response.headers["x-request-id"]).toBe("req-phase11");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(String(response.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });

  it("distinguishes liveness from readiness", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe("ok");
    expect(ready.statusCode).toBe(200);
    expect(ready.json().database).toBe(true);
    expect(JSON.stringify(ready.json())).not.toMatch(/postgres:\/\/|password|SESSION_SECRET/);
  });

  it("does not leak secrets from system status or metrics", async () => {
    const org = await createOrg(app, serviceToken, "System Secrets");
    const session = await login(app, org.email, org.password);
    const status = await app.inject({
      method: "GET",
      url: "/v1/system/status",
      headers: sessionHeaders(session.cookie),
    });
    expect(status.statusCode).toBe(200);
    const blob = JSON.stringify(status.json());
    expect(blob).not.toMatch(/SESSION_SECRET|DATABASE_URL|password_hash|NOVA_INTERNAL_TOKEN|sk-|xoxb-/);
    const metrics = await app.inject({ method: "GET", url: "/v1/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(JSON.stringify(metrics.json())).not.toMatch(/postgres:\/\/|authorization/i);
  });
});

describe("login abuse and session lifecycle", () => {
  it("returns a generic invalid-credential message", async () => {
    const org = await createOrg(app, serviceToken, "Login Generic");
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email: "nobody@example.test", password: "wrong-password-value" },
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email: org.email, password: "wrong-password-value" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe("invalid email or password");
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    expect(unknown.json().error.request_id).toBeTruthy();
  });

  it("rejects missing, invalid, and cross-origin unsafe requests", async () => {
    const org = await createOrg(app, serviceToken, "Origin Gate");
    const session = await login(app, org.email, org.password);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: session.cookie },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: session.cookie, origin: "http://evil.example" },
    });
    expect(missing.statusCode).toBe(403);
    expect(invalid.statusCode).toBe(403);
    expect(missing.json().error.code).toBe("ORIGIN_DENIED");
    expect(invalid.json().error.code).toBe("ORIGIN_DENIED");
  });

  it("rejects forged cookies, expired sessions, and reuse after logout", async () => {
    const org = await createOrg(app, serviceToken, "Session Lifecycle");
    const session = await login(app, org.email, org.password);
    const forged = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: sessionHeaders("verity_session=deadbeefdeadbeefdeadbeefdeadbeef"),
    });
    expect(forged.statusCode).toBe(401);

    await pool.query(`UPDATE auth.sessions SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1`, [
      org.admin_user_id,
    ]);
    const expired = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: sessionHeaders(session.cookie),
    });
    expect(expired.statusCode).toBe(401);

    const fresh = await login(app, org.email, org.password);
    const loggedOut = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: sessionHeaders(fresh.cookie),
    });
    expect(loggedOut.statusCode).toBe(200);
    const reused = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: sessionHeaders(fresh.cookie),
    });
    expect(reused.statusCode).toBe(401);
  });

  it("sets HttpOnly SameSite session cookies", async () => {
    const org = await createOrg(app, serviceToken, "Cookie Flags");
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { origin: TEST_ORIGIN },
      payload: { email: org.email, password: org.password },
    });
    const raw = String(response.headers["set-cookie"]);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(sessionCookie(response)).toMatch(/^verity_session=/);
  });

  it("rate-limits login and Nova execute when enabled", async () => {
    process.env.VERITY_RATE_LIMIT = "1";
    limiters.login.reset();
    limiters.loginFail.reset();
    limiters.nova.reset();
    const isolated = await startApp(pool);
    try {
      const org = await createOrg(isolated, serviceToken, "Rate Limit");
      const session = await login(isolated, org.email, org.password);
      let limited = 0;
      for (let i = 0; i < 22; i += 1) {
        const response = await isolated.inject({
          method: "POST",
          url: "/v1/auth/login",
          headers: { origin: TEST_ORIGIN },
          payload: { email: org.email, password: "wrong-password-value" },
        });
        if (response.statusCode === 429) {
          limited += 1;
        }
      }
      expect(limited).toBeGreaterThan(0);

      const novaApp = await startApp(pool, {
        novaInvoke: async () => ({ status: "completed", execution_id: randomUUID() }),
      });
      try {
        let novaLimited = 0;
        for (let i = 0; i < 35; i += 1) {
          const response = await novaApp.inject({
            method: "POST",
            url: "/v1/nova/skills/nova.research/execute",
            headers: sessionHeaders(session.cookie),
            payload: { question: "ping" },
          });
          if (response.statusCode === 429) {
            novaLimited += 1;
          }
        }
        expect(novaLimited).toBeGreaterThan(0);
      } finally {
        await novaApp.close();
      }
    } finally {
      delete process.env.VERITY_RATE_LIMIT;
      await isolated.close();
    }
  });
});

describe("tenant isolation consolidated suite", () => {
  it("keeps Org B off Org A identity, knowledge, nova, approvals, connectors, records, and exports", async () => {
    const orgA = await createOrg(app, serviceToken, "Tenant A");
    const orgB = await createOrg(app, serviceToken, "Tenant B");
    const adminA = await login(app, orgA.email, orgA.password);
    const adminB = await login(app, orgB.email, orgB.password);
    const forgedId = randomUUID();

    const collection = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(adminA.cookie),
      payload: { name: "Org A Secrets", classification: "internal" },
    });
    const collectionId = collection.json().collection_id as string;
    const uploaded = await app.inject({
      method: "POST",
      url: `/v1/knowledge/collections/${collectionId}/sources`,
      headers: sessionHeaders(adminA.cookie, {
        "content-type": "multipart/form-data; boundary=----veritytest",
      }),
      payload: markdownPart("policy.md", "Org A only flood shelter policy.", "Org A policy"),
    });
    const versionId = uploaded.json().version_id as string;
    const sourceId = uploaded.json().source_id as string;
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${versionId}/approve`,
      headers: sessionHeaders(adminA.cookie),
    });
    await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${versionId}/index`,
      headers: sessionHeaders(adminA.cookie),
    });

    const users = await app.inject({
      method: "GET",
      url: "/v1/users",
      headers: sessionHeaders(adminB.cookie),
    });
    expect(users.json().users.every((u: { email: string }) => u.email !== orgA.email)).toBe(true);

    for (const url of [
      `/v1/knowledge/collections/${collectionId}`,
      `/v1/knowledge/collections/${forgedId}`,
      `/v1/knowledge/sources/${sourceId}`,
    ]) {
      const denied = await app.inject({
        method: "GET",
        url,
        headers: sessionHeaders(adminB.cookie),
      });
      expect([403, 404]).toContain(denied.statusCode);
    }

    const retrieve = await app.inject({
      method: "POST",
      url: "/v1/knowledge/retrieve",
      headers: sessionHeaders(adminB.cookie),
      payload: {
        query: "flood shelter",
        collection_ids: [collectionId],
        mode: "grounded",
        classification_ceiling: "internal",
      },
    });
    expect([403, 404]).toContain(retrieve.statusCode);

    const nova = await app.inject({
      method: "GET",
      url: `/v1/nova/runs/${forgedId}`,
      headers: sessionHeaders(adminB.cookie),
    });
    expect([403, 404]).toContain(nova.statusCode);

    const record = await app.inject({
      method: "GET",
      url: `/v1/audit/records/${forgedId}`,
      headers: sessionHeaders(adminB.cookie),
    });
    expect([403, 404]).toContain(record.statusCode);

    const exported = await app.inject({
      method: "GET",
      url: "/v1/audit/export",
      headers: sessionHeaders(adminB.cookie),
    });
    expect([200, 403]).toContain(exported.statusCode);
    expect(JSON.stringify(exported.json())).not.toContain(orgA.organization_id);

    const backup = await app.inject({
      method: "GET",
      url: "/v1/system/backup",
      headers: sessionHeaders(adminB.cookie),
    });
    expect([401, 403, 404]).toContain(backup.statusCode);
  });
});

describe("permission bypass attempts", () => {
  it("rejects member admin actions even when IDs are supplied in the body", async () => {
    const org = await createOrg(app, serviceToken, "Perm Bypass");
    const admin = await login(app, org.email, org.password);
    const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: sessionHeaders(admin.cookie),
      payload: {
        email: memberEmail,
        password: "member-horse-battery",
        display_name: "Member",
        role_id: org.member_role_id,
        organization_id: org.organization_id,
      },
    });
    expect(created.statusCode).toBe(200);
    const member = await login(app, memberEmail, "member-horse-battery");

    const analystRole = await createRole(pool, {
      organizationId: org.organization_id,
      name: `analyst-${randomUUID().slice(0, 6)}`,
      permissions: ["nova.use", "knowledge.read", "models.read", "policies.read", "audit.read"],
    });
    const analystEmail = `analyst-${randomUUID().slice(0, 8)}@example.test`;
    const analystCreated = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: sessionHeaders(admin.cookie),
      payload: {
        email: analystEmail,
        password: "analyst-horse-battery",
        display_name: "Analyst",
        role_id: analystRole,
      },
    });
    expect(analystCreated.statusCode).toBe(200);
    const analyst = await login(app, analystEmail, "analyst-horse-battery");

    const users = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: sessionHeaders(member.cookie),
      payload: {
        email: `x-${randomUUID().slice(0, 6)}@example.test`,
        password: "nope",
        display_name: "Nope",
        role_id: org.admin_role_id,
        organization_id: org.organization_id,
        actor_id: org.admin_user_id,
      },
    });
    expect(users.statusCode).toBe(403);

    const social = await startApp(pool, {
      novaInvoke: async () => ({ status: "completed", execution_id: randomUUID() }),
    });
    try {
      const deniedSkill = await social.inject({
        method: "POST",
        url: "/v1/nova/skills/nova.social.draft/execute",
        headers: sessionHeaders(analyst.cookie),
        payload: { brand_id: "civil-protection" },
      });
      expect(deniedSkill.statusCode).toBe(403);

      const connector = await social.inject({
        method: "POST",
        url: `/v1/executions/${randomUUID()}/connectors/actions`,
        headers: sessionHeaders(analyst.cookie),
        payload: {
          connector_type: "meta.facebook",
          action: "publish_post",
          artifact_hash: "a".repeat(64),
          payload: { message: "nope" },
        },
      });
      expect(connector.statusCode).toBe(403);
      expect(connector.json().error.code).not.toBe("completed");

      const unauth = await social.inject({
        method: "GET",
        url: "/v1/users",
      });
      expect(unauth.statusCode).toBe(401);
    } finally {
      await social.close();
    }
  });
});

describe("failure modes and persistence", () => {
  it("does not fake success when Nova is unavailable", async () => {
    const isolated = await startApp(pool);
    const org = await createOrg(isolated, serviceToken, "Nova Down");
    const session = await login(isolated, org.email, org.password);
    const executed = await isolated.inject({
      method: "POST",
      url: "/v1/nova/skills/nova.research/execute",
      headers: sessionHeaders(session.cookie),
      payload: { question: "anything" },
    });
    expect(executed.statusCode).toBe(503);
    expect(executed.json().error.code).toBe("NOVA_UNAVAILABLE");
    expect(executed.json().status).not.toBe("completed");
    await isolated.close();
  });

  it("surfaces model-unavailable from Nova without a completed artifact", async () => {
    const isolated = await startApp(pool, {
      novaInvoke: async (path) => {
        if (String(path).endsWith("/execute")) {
          throw new ApiError(503, "MODEL_UNAVAILABLE", "model provider timed out");
        }
        return { status: "ok" };
      },
    });
    const org = await createOrg(isolated, serviceToken, "Model Down");
    const session = await login(isolated, org.email, org.password);
    const executed = await isolated.inject({
      method: "POST",
      url: "/v1/nova/skills/nova.research/execute",
      headers: sessionHeaders(session.cookie),
      payload: { question: "storm advisory" },
    });
    expect(executed.statusCode).toBe(503);
    expect(String(executed.json().error.code)).toMatch(/UNAVAILABLE/);
    expect(executed.json().status).not.toBe("completed");
    await isolated.close();
  });

  it("preserves Knowledge after a Core process restart", async () => {
    const first = await startApp(pool);
    const org = await createOrg(first, serviceToken, "Restart Org");
    const session = await login(first, org.email, org.password);
    const collection = await first.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(session.cookie),
      payload: { name: "Restart Facts", classification: "internal" },
    });
    const collectionId = collection.json().collection_id as string;
    const uploaded = await first.inject({
      method: "POST",
      url: `/v1/knowledge/collections/${collectionId}/sources`,
      headers: sessionHeaders(session.cookie, {
        "content-type": "multipart/form-data; boundary=----veritytest",
      }),
      payload: markdownPart("fact.md", "Designated public shelters remain listed after restart.", "Restart fact"),
    });
    const versionId = uploaded.json().version_id as string;
    await first.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${versionId}/approve`,
      headers: sessionHeaders(session.cookie),
    });
    await first.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${versionId}/index`,
      headers: sessionHeaders(session.cookie),
    });
    await first.close();

    const second = await startApp(pool);
    const again = await login(second, org.email, org.password);
    const listed = await second.inject({
      method: "GET",
      url: `/v1/knowledge/collections/${collectionId}`,
      headers: sessionHeaders(again.cookie),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().collection.name).toBe("Restart Facts");
    await second.close();
  });
});

describe("operational logging redaction", () => {
  it("redacts secret-like keys", () => {
    const redacted = redact({
      password: "secret",
      session_token: "abc",
      route: "/v1/health",
    });
    expect(redacted).toMatchObject({ password: "[redacted]", session_token: "[redacted]", route: "/v1/health" });
  });
});
