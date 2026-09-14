import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRole,
  createServiceCredential,
  revokeServiceCredential,
  tokenHash,
} from "@verityos/identity";
import {
  TEST_ORIGIN,
  createOrg,
  createPool,
  filePart,
  login,
  markdownPart,
  seedPlatformService,
  sessionHeaders,
  startApp,
} from "./helpers.js";
import { flateTextPdf } from "../../../packages/knowledge/test/pdf-fixture.js";

const pool = createPool();
const app = await startApp(pool);
let serviceToken = "";

const FACT =
  "The capital of France is Paris. Verity Knowledge records that Paris is the capital of France for sovereign retrieval tests.";

beforeAll(async () => {
  await pool.query("SELECT 1");
  serviceToken = await seedPlatformService(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function uploadApproved(
  cookie: string,
  collectionId: string,
  body: Buffer | string,
  filename: string,
  contentType: string
) {
  const payload = Buffer.isBuffer(body)
    ? filePart(filename, body, filename, contentType)
    : markdownPart(filename, body, filename);
  const uploaded = await app.inject({
    method: "POST",
    url: `/v1/knowledge/collections/${collectionId}/sources`,
    headers: sessionHeaders(cookie, {
      "content-type": `multipart/form-data; boundary=----veritytest`,
    }),
    payload,
  });
  expect(uploaded.statusCode).toBe(200);
  const versionId = uploaded.json().version_id as string;
  const sourceId = uploaded.json().source_id as string;
  const approved = await app.inject({
    method: "POST",
    url: `/v1/knowledge/versions/${versionId}/approve`,
    headers: sessionHeaders(cookie),
  });
  expect(approved.statusCode).toBe(200);
  const indexed = await app.inject({
    method: "POST",
    url: `/v1/knowledge/versions/${versionId}/index`,
    headers: sessionHeaders(cookie),
  });
  expect(indexed.statusCode).toBe(200);
  return { versionId, sourceId };
}

describe("collection ACL is authoritative", () => {
  it("hides collections from same-org roles that have global knowledge.read but no can_read grant", async () => {
    const org = await createOrg(app, serviceToken, "ACL Org");
    const admin = await login(app, org.email, org.password);
    const collection = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(admin.cookie),
      payload: { name: "Restricted Policies", classification: "internal" },
    });
    expect(collection.statusCode).toBe(200);
    const collectionId = collection.json().collection_id as string;
    const { sourceId, versionId } = await uploadApproved(
      admin.cookie,
      collectionId,
      FACT,
      "france.md",
      "text/markdown"
    );

    const roleId = await createRole(pool, {
      organizationId: org.organization_id,
      name: `reader-no-acl-${randomUUID().slice(0, 6)}`,
      permissions: ["knowledge.read", "knowledge.manage", "knowledge.approve", "nova.use"],
    });
    const email = `no-acl-${randomUUID().slice(0, 8)}@example.test`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: sessionHeaders(admin.cookie),
      payload: {
        email,
        password: "member-horse-battery",
        display_name: "No ACL",
        role_id: roleId,
      },
    });
    expect(created.statusCode).toBe(200);
    await pool.query(
      `INSERT INTO command.skill_policy_roles (skill_policy_id, role_id, organization_id)
       SELECT id, $2, $1 FROM command.skill_policies
       WHERE organization_id = $1 AND skill_id IN ('knowledge.retrieve', 'knowledge.manage')`,
      [org.organization_id, roleId]
    );
    const outsider = await login(app, email, "member-horse-battery");

    const listed = await app.inject({
      method: "GET",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(outsider.cookie),
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().collections.every((c: { id: string }) => c.id !== collectionId)
    ).toBe(true);

    const source = await app.inject({
      method: "GET",
      url: `/v1/knowledge/sources/${sourceId}`,
      headers: sessionHeaders(outsider.cookie),
    });
    expect(source.statusCode).toBe(404);

    const retrieve = await app.inject({
      method: "POST",
      url: "/v1/knowledge/retrieve",
      headers: sessionHeaders(outsider.cookie),
      payload: {
        query: "What is the capital of France?",
        collection_ids: [collectionId],
        mode: "strict",
        classification_ceiling: "internal",
      },
    });
    expect(retrieve.statusCode).toBe(404);

    const upload = await app.inject({
      method: "POST",
      url: `/v1/knowledge/collections/${collectionId}/sources`,
      headers: sessionHeaders(outsider.cookie, {
        "content-type": "multipart/form-data; boundary=----veritytest",
      }),
      payload: markdownPart("other.md", "other", "other"),
    });
    expect(upload.statusCode).toBe(404);

    const approve = await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${versionId}/approve`,
      headers: sessionHeaders(outsider.cookie),
    });
    expect(approve.statusCode).toBe(404);

    const index = await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${versionId}/index`,
      headers: sessionHeaders(outsider.cookie),
    });
    expect(index.statusCode).toBe(404);
  });
});

describe("knowledge approval and provenance", () => {
  it("retrieves only approved versions in general mode and never sets included_in_context", async () => {
    const org = await createOrg(app, serviceToken, "Approval Org");
    const admin = await login(app, org.email, org.password);
    const collection = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(admin.cookie),
      payload: { name: "Facts", classification: "internal" },
    });
    const collectionId = collection.json().collection_id as string;

    const unapproved = await app.inject({
      method: "POST",
      url: `/v1/knowledge/collections/${collectionId}/sources`,
      headers: sessionHeaders(admin.cookie, {
        "content-type": "multipart/form-data; boundary=----veritytest",
      }),
      payload: markdownPart("draft.md", FACT, "Draft France"),
    });
    expect(unapproved.statusCode).toBe(200);
    const unapprovedVersion = unapproved.json().version_id as string;
    const indexed = await app.inject({
      method: "POST",
      url: `/v1/knowledge/versions/${unapprovedVersion}/index`,
      headers: sessionHeaders(admin.cookie),
    });
    expect(indexed.statusCode).toBe(200);

    const generalDraft = await app.inject({
      method: "POST",
      url: "/v1/knowledge/retrieve",
      headers: sessionHeaders(admin.cookie),
      payload: {
        query: "What is the capital of France?",
        collection_ids: [collectionId],
        mode: "general",
        classification_ceiling: "internal",
      },
    });
    expect(generalDraft.statusCode).toBe(200);
    expect(generalDraft.json().hits).toEqual([]);

    await uploadApproved(admin.cookie, collectionId, FACT, "france.md", "text/markdown");

    const retrieved = await app.inject({
      method: "POST",
      url: "/v1/knowledge/retrieve",
      headers: sessionHeaders(admin.cookie),
      payload: {
        query: "What is the capital of France?",
        collection_ids: [collectionId],
        mode: "general",
        classification_ceiling: "internal",
      },
    });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().hits.length).toBeGreaterThan(0);
    expect(retrieved.json().hits[0].text).toMatch(/Paris/);
    expect(retrieved.json().hits.every((h: { source_version_id: string }) => h.source_version_id !== unapprovedVersion)).toBe(
      true
    );

    const runId = retrieved.json().retrieval_run_id as string;
    const hits = await pool.query<{
      included_in_context: boolean;
      returned_to_caller: boolean;
      ranked: boolean;
      retrieved: boolean;
    }>(
      `SELECT included_in_context, returned_to_caller, ranked, retrieved
       FROM knowledge.retrieval_hits WHERE retrieval_run_id = $1`,
      [runId]
    );
    expect(hits.rows.length).toBeGreaterThan(0);
    expect(hits.rows.every((row) => row.included_in_context === false)).toBe(true);
    expect(hits.rows.some((row) => row.returned_to_caller === true)).toBe(true);
    expect(hits.rows.some((row) => row.ranked === true)).toBe(true);
    expect(hits.rows.every((row) => row.retrieved === true)).toBe(true);

    const run = await pool.query<{ embedding_provider_key: string; embedding_dimensions: number }>(
      `SELECT embedding_provider_key, embedding_dimensions FROM knowledge.retrieval_runs WHERE id = $1`,
      [runId]
    );
    expect(run.rows[0].embedding_provider_key).toBe("mock");
    expect(run.rows[0].embedding_dimensions).toBe(768);
  });

  it("indexes a compressed native-text PDF", async () => {
    const org = await createOrg(app, serviceToken, "PDF Org");
    const admin = await login(app, org.email, org.password);
    const collection = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(admin.cookie),
      payload: { name: "PDF Facts", classification: "internal" },
    });
    const collectionId = collection.json().collection_id as string;
    const pdf = flateTextPdf(FACT);
    await uploadApproved(admin.cookie, collectionId, pdf, "france.pdf", "application/pdf");
    const retrieved = await app.inject({
      method: "POST",
      url: "/v1/knowledge/retrieve",
      headers: sessionHeaders(admin.cookie),
      payload: {
        query: "capital of France",
        collection_ids: [collectionId],
        mode: "strict",
        classification_ceiling: "internal",
      },
    });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().insufficient_evidence).toBe(false);
    expect(retrieved.json().hits[0].text).toMatch(/Paris/);
  });
});

describe("service credentials and CSRF", () => {
  it("generates a one-time token, stores only the hash, and scopes/revokes correctly", async () => {
    const orgA = await createOrg(app, serviceToken, "Cred A");
    const orgB = await createOrg(app, serviceToken, "Cred B");
    const created = await app.inject({
      method: "POST",
      url: "/internal/v1/service-credentials",
      headers: { authorization: `Bearer ${serviceToken}` },
      payload: {
        name: "org-a-reader",
        organization_id: orgA.organization_id,
        scopes: ["knowledge.read", "models.read"],
      },
    });
    expect(created.statusCode).toBe(200);
    const token = created.json().token as string;
    const id = created.json().id as string;
    expect(token.startsWith("vsvc_")).toBe(true);
    const entropy = Buffer.from(token.slice("vsvc_".length), "base64url");
    expect(entropy.length).toBeGreaterThanOrEqual(32);

    const stored = await pool.query<{ secret_hash: string }>(
      `SELECT secret_hash FROM auth.service_credentials WHERE id = $1`,
      [id]
    );
    expect(stored.rows[0].secret_hash).toBe(tokenHash(token));
    expect(stored.rows[0].secret_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(stored.rows[0].secret_hash).not.toContain(token);
    expect(JSON.stringify(stored.rows[0])).not.toContain(token);

    const wrong = await app.inject({
      method: "POST",
      url: "/internal/v1/models/route",
      headers: { authorization: "Bearer vsvc_this-is-not-the-token" },
      payload: {
        organization_id: orgA.organization_id,
        actor_id: orgA.admin_user_id,
        execution_id: randomUUID(),
        task: "summarize",
        risk_tier: "low",
        data_classification: "internal",
      },
    });
    expect(wrong.statusCode).toBe(401);

    const escaped = await app.inject({
      method: "POST",
      url: "/internal/v1/knowledge/retrieve",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        organization_id: orgB.organization_id,
        actor_id: orgB.admin_user_id,
        query: "capital",
        collection_ids: [randomUUID()],
        mode: "strict",
      },
    });
    expect(escaped.statusCode).toBe(403);

    await revokeServiceCredential(pool, id);
    const revoked = await app.inject({
      method: "POST",
      url: "/internal/v1/models/route",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        organization_id: orgA.organization_id,
        actor_id: orgA.admin_user_id,
        execution_id: randomUUID(),
        task: "summarize",
        risk_tier: "low",
        data_classification: "internal",
      },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("records a Kernel checkpoint for the internal model route", async () => {
    const org = await createOrg(app, serviceToken, "Internal Route Org");
    const before = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.ledger_entries WHERE organization_id = $1`,
      [org.organization_id]
    );
    const routed = await app.inject({
      method: "POST",
      url: "/internal/v1/models/route",
      headers: { authorization: `Bearer ${serviceToken}` },
      payload: {
        organization_id: org.organization_id,
        actor_id: org.admin_user_id,
        task: "summarize",
        risk_tier: "low",
        data_classification: "internal",
        required_capabilities: ["chat"],
        prefer_local: true,
      },
    });
    expect(routed.statusCode).toBe(200);
    expect(routed.json().provider).toBe("mock");
    const after = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.ledger_entries WHERE organization_id = $1`,
      [org.organization_id]
    );
    expect(Number(after.rows[0].n)).toBeGreaterThan(Number(before.rows[0].n));
    const entry = await pool.query<{ skill_id: string }>(
      `SELECT e.skill_id
       FROM audit.executions e
       JOIN audit.ledger_entries l ON l.execution_id = e.id
       WHERE e.organization_id = $1 AND e.skill_id = 'models.route'
       ORDER BY l.created_at DESC LIMIT 1`,
      [org.organization_id]
    );
    expect(entry.rows[0]?.skill_id).toBe("models.route");
  });

  it("rejects a disallowed Origin on cookie-authenticated unsafe methods", async () => {
    const org = await createOrg(app, serviceToken, "CSRF Org");
    const admin = await login(app, org.email, org.password);
    const denied = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(admin.cookie, { origin: "https://evil.example" }),
      payload: { name: "stolen", classification: "internal" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("ORIGIN_DENIED");

    const missing = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: { cookie: admin.cookie },
      payload: { name: "stolen", classification: "internal" },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe("ORIGIN_DENIED");

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/knowledge/collections",
      headers: sessionHeaders(admin.cookie, { origin: TEST_ORIGIN }),
      payload: { name: "ok", classification: "internal" },
    });
    expect(allowed.statusCode).toBe(200);
  });
});
