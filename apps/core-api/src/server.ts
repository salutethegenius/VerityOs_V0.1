import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { Pool } from "pg";
import pg from "pg";
import {
  decideApproval,
  evaluatePolicy,
  getPolicy,
  seedDefaultCommand,
} from "@verityos/command";
import type { DataClassification, KnowledgeMode, RiskTier } from "@verityos/contracts";
import {
  AuthError,
  SESSION_COOKIE,
  assertOrganizationScope,
  createOrganization,
  createServiceCredential,
  createSession,
  createUser,
  destroySession,
  listOrganizationRoles,
  requirePermission,
  resolveServiceToken,
  resolveSession,
  selectOrganization,
  EXECUTIONS_WRITE_SCOPE,
  PLATFORM_CROSS_ORG_SCOPE,
  type AuthContext,
  type ServiceContext,
} from "@verityos/identity";
import {
  KnowledgeError,
  approveSourceVersion,
  collectionIdForVersion,
  collectionIdsForRetrievalRun,
  createCollection,
  indexSourceVersion,
  reindexSourceVersion,
  requireCollectionPermission,
  uploadSourceVersion,
} from "@verityos/knowledge";
import { listModels, registerModel, routeModel } from "@verityos/model-router";
import {
  exportOrganizationEvidence,
  getExecution,
  getLedgerEntries,
  verifyEvidenceBundle,
} from "@verityos/audit-kernel";
import { recordKernelCheckpoint, withStandaloneExecution } from "./audit.js";
import { loadConfig } from "./config.js";
import { ApiError, publicMessage } from "./errors.js";
import { applySecurityHeaders } from "./security-headers.js";
import { enforceLimit, limiters } from "./rate-limit.js";
import { logEvent } from "./log.js";
import { metricsSnapshot, recordRequest } from "./metrics.js";
import {
  ExecutionError,
  executeModelForExecution,
  finalizeGovernedExecution,
  openGovernedExecution,
  retrieveForExecution,
} from "./execution/service.js";
import {
  decideExecutionApproval,
  recordSkillLifecycleEvent,
  requestExecutionApproval,
} from "./execution/lifecycle.js";
import { getVerityGraph, getVerityRecord, listVerityRecords } from "./execution/records.js";
import {
  envSecretResolver,
  createDefaultConnectorRegistry,
  type SecretResolver,
} from "@verityos/connectors";
import {
  getConnectorAction,
  healthCheckConnector,
  requestConnectorAction,
} from "./connectors/gateway.js";
import {
  collectionDetail,
  createNovaInvoker,
  homeSummary,
  listApprovals,
  listBrands,
  listCollectionsForShell,
  listCommandSkills,
  listConnectorsSafe,
  listPoliciesForShell,
  listRolesForShell,
  listUsersForShell,
  novaRunDetail,
  novaRuns,
  novaSkillCatalog,
  sessionConnectorAction,
  sessionConnectorHealth,
  sessionDecideApproval,
  sessionProfile,
  sourceDetail,
  systemStatus,
  type NovaInvoker,
} from "./shell.js";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    auth?: AuthContext;
    service?: ServiceContext;
  }
}

function cookieToken(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE];
  return raw || undefined;
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length).trim();
}

async function requireSession(pool: Pool, request: FastifyRequest): Promise<AuthContext> {
  const context = await resolveSession(pool, cookieToken(request));
  request.auth = context;
  return context;
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 12 * 60 * 60,
  });
}

export async function buildServer(
  options: {
    pool?: Pool;
    connectorFetch?: typeof fetch;
    secretResolver?: SecretResolver;
    novaInvoke?: NovaInvoker;
  } = {}
) {
  const config = loadConfig();
  const pool =
    options.pool ??
    new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const connectorRegistry = createDefaultConnectorRegistry({
    fetchImpl: options.connectorFetch,
  });
  const connectorSecrets = options.secretResolver ?? envSecretResolver();
  const novaInvoke = options.novaInvoke ?? createNovaInvoker();
  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    bodyLimit: 11 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.sessionSecret });
  const allowedOrigins = config.corsOrigin
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    allowedHeaders: ["content-type", "authorization", "x-request-id", "x-verity-organization-id"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 },
  });

  app.addHook("onRequest", async (request, reply) => {
    request.requestId =
      typeof request.headers["x-request-id"] === "string"
        ? request.headers["x-request-id"]
        : randomUUID();
    reply.header("x-request-id", request.requestId);
    applySecurityHeaders(reply, { https: config.cookieSecure });
    (request as FastifyRequest & { startedAt: number }).startedAt = Date.now();
    if (!unsafeMethods.has(request.method)) {
      return;
    }
    if (bearer(request)) {
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !allowedOrigins.includes(origin)) {
      throw new ApiError(403, "ORIGIN_DENIED", "origin is not allowed");
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const started = (request as FastifyRequest & { startedAt?: number }).startedAt ?? Date.now();
    const latency = Date.now() - started;
    recordRequest(reply.statusCode, latency, request.routeOptions.url);
    logEvent({
      request_id: request.requestId,
      route: request.routeOptions.url ?? request.url,
      method: request.method,
      status: reply.statusCode,
      organization_id: request.auth?.organizationId,
      actor_id: request.auth?.userId,
      latency_ms: latency,
    });
  });

  app.setErrorHandler((err, request, reply) => {
    const known =
      err instanceof AuthError ||
      err instanceof KnowledgeError ||
      err instanceof ExecutionError ||
      err instanceof ApiError;
    const mapped = known
      ? { statusCode: err.statusCode, code: err.code, message: err.message }
      : publicMessage(err);
    const status = mapped.statusCode >= 400 ? mapped.statusCode : 500;
    reply.status(status).send({
      error: {
        code: status >= 500 && !known ? "INTERNAL_ERROR" : mapped.code,
        message: status >= 500 && !known ? "internal error" : mapped.message,
        request_id: request.requestId,
      },
    });
  });

  app.get("/v1/health", async () => ({
    status: "ok",
    component: "core-api",
    phase: "11",
  }));
  app.get("/health/live", async () => ({ status: "ok", component: "core-api", phase: "11" }));
  app.get("/health/ready", async () => {
    await pool.query("SELECT 1");
    const migrations = await pool.query<{ name: string }>(
      `SELECT name FROM public.pgmigrations ORDER BY run_on DESC LIMIT 1`
    ).catch(() => ({ rows: [] as Array<{ name: string }> }));
    return {
      status: "ok",
      component: "core-api",
      phase: "11",
      database: true,
      latest_migration: migrations.rows[0]?.name ?? null,
    };
  });
  app.get("/v1/metrics", async () => metricsSnapshot());

  app.post("/v1/auth/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string; organization_id?: string };
    if (!body?.email || !body.password) {
      throw new ApiError(400, "INVALID_INPUT", "email and password are required");
    }
    const ip = request.ip || "unknown";
    enforceLimit(limiters.login, `login:${ip}`, "too many login attempts");
    try {
      const { token, context } = await createSession(pool, {
        email: body.email,
        password: body.password,
        organizationId: body.organization_id,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      setSessionCookie(reply, token, config.cookieSecure);
      return {
        user_id: context.userId,
        organization_id: context.organizationId,
        role: context.roleName,
        permissions: context.permissions,
      };
    } catch (err) {
      if (err instanceof AuthError && err.code === "INVALID_CREDENTIALS") {
        enforceLimit(
          limiters.loginFail,
          `loginfail:${ip}:${body.email.toLowerCase()}`,
          "too many login attempts"
        );
        throw new ApiError(401, "INVALID_CREDENTIALS", "invalid email or password");
      }
      throw err;
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    await destroySession(pool, cookieToken(request) ?? "");
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/auth/me", async (request) => {
    const auth = await requireSession(pool, request);
    return sessionProfile(pool, auth);
  });

  app.get("/v1/me", async (request) => {
    const auth = await requireSession(pool, request);
    return sessionProfile(pool, auth);
  });

  app.post("/v1/auth/select-organization", async (request) => {
    const auth = await requireSession(pool, request);
    const body = request.body as { organization_id?: string };
    if (!body.organization_id) {
      throw new ApiError(400, "INVALID_INPUT", "organization_id is required");
    }
    await selectOrganization(pool, auth.userId, auth.sessionId, body.organization_id);
    return { organization_id: body.organization_id };
  });

  app.post("/internal/v1/organizations", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    if (service.organizationId) {
      throw new ApiError(403, "FORBIDDEN", "platform service credential required");
    }
    if (!service.scopes.includes("organization.manage")) {
      throw new ApiError(403, "FORBIDDEN", "missing organization.manage scope");
    }
    const body = request.body as {
      name?: string;
      admin_email?: string;
      admin_password?: string;
      admin_name?: string;
    };
    if (!body.name || !body.admin_email || !body.admin_password) {
      throw new ApiError(400, "INVALID_INPUT", "name, admin_email, and admin_password are required");
    }
    const created = await createOrganization(pool, {
      name: body.name,
      adminEmail: body.admin_email,
      adminPassword: body.admin_password,
      adminName: body.admin_name,
    });
    await seedDefaultCommand(pool, {
      organizationId: created.organizationId,
      adminRoleId: created.adminRoleId,
      memberRoleId: created.memberRoleId,
    });
    return {
      organization_id: created.organizationId,
      admin_user_id: created.adminUserId,
      admin_role_id: created.adminRoleId,
      member_role_id: created.memberRoleId,
    };
  });

  app.post("/internal/v1/service-credentials", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    if (service.organizationId || !service.scopes.includes("organization.manage")) {
      throw new ApiError(403, "FORBIDDEN", "platform service credential required");
    }
    const body = request.body as {
      name?: string;
      organization_id?: string | null;
      scopes?: string[];
      secret?: string;
    };
    if (body.secret) {
      throw new ApiError(
        400,
        "SECRET_NOT_ACCEPTED",
        "caller-chosen secrets are not accepted; the server generates the credential"
      );
    }
    if (!body.name || !body.scopes) {
      throw new ApiError(400, "INVALID_INPUT", "name and scopes are required");
    }
    if (body.organization_id && body.scopes.includes(PLATFORM_CROSS_ORG_SCOPE)) {
      throw new ApiError(
        400,
        "INVALID_SCOPE",
        "organization-scoped credentials cannot include platform.cross_org"
      );
    }
    const created = await createServiceCredential(pool, {
      name: body.name,
      organizationId: body.organization_id ?? null,
      scopes: body.scopes,
    });
    return { id: created.id, token: created.token };
  });

  app.get("/v1/users", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "users.manage");
    return { users: await listUsersForShell(pool, auth.organizationId) };
  });

  app.post("/v1/users", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "users.manage");
    const body = request.body as {
      email?: string;
      password?: string;
      display_name?: string;
      role_id?: string;
      organization_id?: string;
    };
    assertOrganizationScope(auth.organizationId, body.organization_id);
    if (!body.email || !body.password || !body.display_name || !body.role_id) {
      throw new ApiError(400, "INVALID_INPUT", "email, password, display_name, and role_id are required");
    }
    const userId = await createUser(pool, {
      organizationId: auth.organizationId,
      roleId: body.role_id,
      email: body.email,
      password: body.password,
      displayName: body.display_name,
    });
    return { user_id: userId };
  });

  app.get("/v1/roles", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "roles.manage");
    return { roles: await listRolesForShell(pool, auth.organizationId) };
  });

  app.get("/v1/policies", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "policies.read");
    return { policies: await listPoliciesForShell(pool, auth.organizationId) };
  });

  app.get("/v1/policies/:policyId", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "policies.read");
    const { policyId } = request.params as { policyId: string };
    const policy = await getPolicy(pool, auth.organizationId, policyId);
    if (!policy) {
      throw new ApiError(404, "NOT_FOUND", "policy not found");
    }
    return policy;
  });

  app.post("/v1/policies/evaluate", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "policies.read");
    const body = request.body as {
      organization_id?: string;
      action: Parameters<typeof evaluatePolicy>[1]["action"];
    };
    assertOrganizationScope(auth.organizationId, body.organization_id);
    return evaluatePolicy(pool, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      roleId: auth.roleId,
      action: body.action,
    });
  });

  app.post("/v1/approvals/:approvalId/decide", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "approvals.decide");
    const { approvalId } = request.params as { approvalId: string };
    const body = request.body as { allow?: boolean; organization_id?: string };
    assertOrganizationScope(auth.organizationId, body.organization_id);
    const decision = await evaluatePolicy(pool, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      roleId: auth.roleId,
      action: { type: "approval.decide", approvalId },
    });
    if (decision.decision !== "allow") {
      throw new ApiError(403, decision.reason_code, "approval decision denied");
    }
    await decideApproval(pool, {
      organizationId: auth.organizationId,
      approvalId,
      decidedBy: auth.userId,
      allow: body.allow !== false,
    });
    return decision;
  });

  app.get("/v1/models", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "models.read");
    return { models: await listModels(pool, auth.organizationId) };
  });

  app.post("/v1/models", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "models.manage");
    const body = request.body as {
      organization_id?: string;
      model_key: string;
      provider: "mock" | "anthropic" | "openai" | "openai-compatible";
      deployment_type: "local" | "private" | "cloud";
      endpoint?: string | null;
      capabilities_json: string[];
      allowed_data_classes_json: DataClassification[];
      risk_ceiling: "low" | "medium" | "high";
      requires_internet?: boolean;
      enabled?: boolean;
    };
    assertOrganizationScope(auth.organizationId, body.organization_id);
    const id = await registerModel(pool, {
      organization_id: auth.organizationId,
      model_key: body.model_key,
      provider: body.provider,
      deployment_type: body.deployment_type,
      endpoint: body.endpoint ?? null,
      capabilities_json: body.capabilities_json,
      allowed_data_classes_json: body.allowed_data_classes_json,
      risk_ceiling: body.risk_ceiling,
      requires_internet: body.requires_internet ?? false,
      enabled: body.enabled ?? true,
    });
    return { model_id: id };
  });

  async function routeAndAudit(input: {
      organizationId: string;
      actorId: string;
      roleId: string;
      sessionId?: string;
      executionId?: string;
      task: string;
      riskTier: "low" | "medium" | "high";
      dataClassification: DataClassification;
      requiredCapabilities?: string[];
      preferLocal?: boolean;
    }
  ) {
    const routed = await withStandaloneExecution(
      pool,
      {
        organizationId: input.organizationId,
        actorId: input.actorId,
        sessionId: input.sessionId,
        skillId: "models.route",
        roleId: input.roleId,
        request: { task: input.task, classification: input.dataClassification },
        executionId: input.executionId,
      },
      async (executionId) =>
        routeModel(pool, {
          organizationId: input.organizationId,
          actorId: input.actorId,
          roleId: input.roleId,
          request: {
            execution_id: executionId,
            task: input.task,
            risk_tier: input.riskTier,
            data_classification: input.dataClassification,
            required_capabilities: input.requiredCapabilities ?? ["chat"],
            prefer_local: input.preferLocal ?? false,
          },
        })
    );
    return routed;
  }

  app.post("/v1/models/route", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "models.read");
    const body = request.body as {
      organization_id?: string;
      execution_id?: string;
      task: string;
      risk_tier: "low" | "medium" | "high";
      data_classification: DataClassification;
      required_capabilities?: string[];
      prefer_local?: boolean;
    };
    assertOrganizationScope(auth.organizationId, body.organization_id);
    return routeAndAudit({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      roleId: auth.roleId,
      sessionId: auth.sessionId,
      executionId: body.execution_id,
      task: body.task,
      riskTier: body.risk_tier,
      dataClassification: body.data_classification,
      requiredCapabilities: body.required_capabilities,
      preferLocal: body.prefer_local,
    });
  });

  app.get("/v1/knowledge/collections", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.read");
    return {
      collections: await listCollectionsForShell(pool, {
        organizationId: auth.organizationId,
        roleId: auth.roleId,
      }),
    };
  });

  app.post("/v1/knowledge/collections", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.manage");
    const body = request.body as {
      name?: string;
      classification?: DataClassification;
      organization_id?: string;
    };
    assertOrganizationScope(auth.organizationId, body.organization_id);
    if (!body.name || !body.classification) {
      throw new ApiError(400, "INVALID_INPUT", "name and classification are required");
    }
    const roles = await listOrganizationRoles(pool, auth.organizationId);
    const admin = roles.find((r) => r.name === "admin");
    const member = roles.find((r) => r.name === "member");
    if (!admin || !member) {
      throw new ApiError(500, "INTERNAL_ERROR", "internal error");
    }
    const id = await createCollection(pool, {
      organizationId: auth.organizationId,
      name: body.name,
      classification: body.classification,
      createdBy: auth.userId,
      adminRoleId: admin.id,
      memberRoleId: member.id,
    });
    return { collection_id: id };
  });

  app.post("/v1/knowledge/collections/:collectionId/sources", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.manage");
    enforceLimit(limiters.upload, `upload:${auth.userId}`, "too many uploads");
    const { collectionId } = request.params as { collectionId: string };
    await requireCollectionPermission(pool, {
      organizationId: auth.organizationId,
      collectionId,
      roleId: auth.roleId,
      capability: "can_manage",
    });
    const file = await request.file();
    if (!file) {
      throw new ApiError(400, "INVALID_INPUT", "file is required");
    }
    const bytes = await file.toBuffer();
    const title = (file.fields.title as { value?: string } | undefined)?.value ?? file.filename;
    const uploaded = await uploadSourceVersion(pool, {
      organizationId: auth.organizationId,
      collectionId,
      actorId: auth.userId,
      title,
      filename: file.filename,
      bytes,
    });
    await recordKernelCheckpoint(pool, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      sessionId: auth.sessionId,
      skillId: "knowledge.manage",
      roleId: auth.roleId,
      entryType: "action_completed",
      request: { collection_id: collectionId, filename: file.filename },
      response: { source_id: uploaded.sourceId, version_id: uploaded.versionId, content_hash: uploaded.contentHash },
    });
    return {
      source_id: uploaded.sourceId,
      version_id: uploaded.versionId,
      version_number: uploaded.versionNumber,
      content_hash: uploaded.contentHash,
    };
  });

  app.post("/v1/knowledge/versions/:versionId/approve", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.approve");
    const { versionId } = request.params as { versionId: string };
    const collectionId = await collectionIdForVersion(pool, {
      organizationId: auth.organizationId,
      versionId,
    });
    await requireCollectionPermission(pool, {
      organizationId: auth.organizationId,
      collectionId,
      roleId: auth.roleId,
      capability: "can_approve",
    });
    await approveSourceVersion(pool, {
      organizationId: auth.organizationId,
      versionId,
      actorId: auth.userId,
    });
    return { ok: true };
  });

  app.post("/v1/knowledge/versions/:versionId/index", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.manage");
    const { versionId } = request.params as { versionId: string };
    const collectionId = await collectionIdForVersion(pool, {
      organizationId: auth.organizationId,
      versionId,
    });
    await requireCollectionPermission(pool, {
      organizationId: auth.organizationId,
      collectionId,
      roleId: auth.roleId,
      capability: "can_manage",
    });
    const result = await indexSourceVersion(pool, {
      organizationId: auth.organizationId,
      versionId,
    });
    return result;
  });

  app.post("/v1/knowledge/versions/:versionId/reindex", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.manage");
    const { versionId } = request.params as { versionId: string };
    const collectionId = await collectionIdForVersion(pool, {
      organizationId: auth.organizationId,
      versionId,
    });
    await requireCollectionPermission(pool, {
      organizationId: auth.organizationId,
      collectionId,
      roleId: auth.roleId,
      capability: "can_manage",
    });
    const result = await reindexSourceVersion(pool, {
      organizationId: auth.organizationId,
      versionId,
    });
    return result;
  });

  async function handleRetrieve(request: FastifyRequest, actor: {
    organizationId: string;
    actorId: string;
    roleId: string;
    sessionId?: string;
  }) {
    const body = request.body as {
      execution_id?: string;
      organization_id?: string;
      actor_id?: string;
      query?: string;
      collection_ids?: string[];
      mode?: KnowledgeMode;
      top_k?: number;
      classification_ceiling?: DataClassification;
    };
    assertOrganizationScope(actor.organizationId, body.organization_id);
    if (body.actor_id && body.actor_id !== actor.actorId) {
      throw new ApiError(403, "ACTOR_MISMATCH", "actor_id does not match authenticated context");
    }
    if (!body.query || !body.collection_ids?.length) {
      throw new ApiError(400, "INVALID_INPUT", "query and collection_ids are required");
    }
    const payload = {
      query: body.query,
      collectionIds: body.collection_ids,
      mode: body.mode ?? "strict" as KnowledgeMode,
      topK: body.top_k ?? 8,
      classificationCeiling: body.classification_ceiling ?? "internal" as DataClassification,
    };
    if (body.execution_id) {
      const execution = await getExecution(pool, actor.organizationId, body.execution_id);
      if (!execution) {
        throw new ApiError(404, "NOT_FOUND", "execution not found");
      }
      return retrieveForExecution(pool, { executionId: body.execution_id, ...payload });
    }
    return withStandaloneExecution(
      pool,
      {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        sessionId: actor.sessionId,
        skillId: "knowledge.retrieve",
        roleId: actor.roleId,
        request: { query: body.query, mode: payload.mode, collection_ids: body.collection_ids },
      },
      async (executionId) => retrieveForExecution(pool, { executionId, ...payload })
    );
  }

  app.post("/v1/knowledge/retrieve", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.read");
    return handleRetrieve(request, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      roleId: auth.roleId,
      sessionId: auth.sessionId,
    });
  });

  app.post("/internal/v1/knowledge/retrieve", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    const body = request.body as {
      organization_id?: string;
      actor_id?: string;
    };
    const organizationId = service.organizationId
      ? assertOrganizationScope(service.organizationId, body.organization_id)
      : body.organization_id;
    if (!organizationId || !body.actor_id) {
      throw new ApiError(400, "INVALID_INPUT", "organization_id and actor_id are required");
    }
    if (!service.scopes.includes("knowledge.read")) {
      throw new ApiError(403, "FORBIDDEN", "missing knowledge.read scope");
    }
    const membership = await pool.query<{ role_id: string }>(
      `SELECT role_id FROM auth.memberships WHERE user_id = $1 AND organization_id = $2`,
      [body.actor_id, organizationId]
    );
    if (!membership.rows[0]) {
      throw new ApiError(403, "NOT_A_MEMBER", "actor is not a member of that organization");
    }
    return handleRetrieve(request, {
      organizationId,
      actorId: body.actor_id,
      roleId: membership.rows[0].role_id,
    });
  });

  app.post("/internal/v1/models/route", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    if (!service.scopes.includes("models.read")) {
      throw new ApiError(403, "FORBIDDEN", "missing models.read scope");
    }
    const body = request.body as {
      organization_id?: string;
      actor_id?: string;
      execution_id: string;
      task: string;
      risk_tier: "low" | "medium" | "high";
      data_classification: DataClassification;
      required_capabilities?: string[];
      prefer_local?: boolean;
    };
    const organizationId = service.organizationId
      ? assertOrganizationScope(service.organizationId, body.organization_id)
      : body.organization_id;
    if (!organizationId || !body.actor_id) {
      throw new ApiError(400, "INVALID_INPUT", "organization_id and actor_id are required");
    }
    const membership = await pool.query<{ role_id: string }>(
      `SELECT role_id FROM auth.memberships WHERE user_id = $1 AND organization_id = $2`,
      [body.actor_id, organizationId]
    );
    if (!membership.rows[0]) {
      throw new ApiError(403, "NOT_A_MEMBER", "actor is not a member of that organization");
    }
    return routeAndAudit({
      organizationId,
      actorId: body.actor_id,
      roleId: membership.rows[0].role_id,
      executionId: body.execution_id,
      task: body.task,
      riskTier: body.risk_tier,
      dataClassification: body.data_classification,
      requiredCapabilities: body.required_capabilities,
      preferLocal: body.prefer_local,
    });
  });

  app.get("/v1/audit/entries", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "audit.read");
    return { entries: await getLedgerEntries(pool, auth.organizationId) };
  });

  app.get("/v1/audit/export", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "audit.export");
    enforceLimit(limiters.audit, `export:${auth.userId}`, "too many exports");
    const policy = await evaluatePolicy(pool, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      roleId: auth.roleId,
      action: {
        type: "skill.use",
        skillId: "audit.export",
        classification: "restricted",
        riskTier: "high",
      },
    });
    if (policy.decision === "deny") {
      throw new ApiError(403, policy.reason_code, "audit export denied");
    }
    if (policy.decision === "approval_required") {
      throw new ApiError(403, "APPROVAL_REQUIRED", "audit export requires approval");
    }
    return exportOrganizationEvidence(pool, auth.organizationId);
  });

  app.get("/v1/knowledge/runs/:runId", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.read");
    const { runId } = request.params as { runId: string };
    const collectionIds = await collectionIdsForRetrievalRun(pool, {
      organizationId: auth.organizationId,
      runId,
    });
    for (const collectionId of collectionIds) {
      await requireCollectionPermission(pool, {
        organizationId: auth.organizationId,
        collectionId,
        roleId: auth.roleId,
        capability: "can_read",
      });
    }
    const run = await pool.query(
      `SELECT * FROM knowledge.retrieval_runs WHERE id = $1 AND organization_id = $2`,
      [runId, auth.organizationId]
    );
    if (!run.rows[0]) {
      throw new ApiError(404, "NOT_FOUND", "retrieval run not found");
    }
    return run.rows[0];
  });

  app.get("/v1/knowledge/sources/:sourceId", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.read");
    const { sourceId } = request.params as { sourceId: string };
    return sourceDetail(pool, auth, sourceId);
  });

  async function requireScopedExecution(service: ServiceContext, executionId: string) {
    if (!service.organizationId && !service.scopes.includes(PLATFORM_CROSS_ORG_SCOPE)) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "platform credentials require platform.cross_org to access executions across organizations"
      );
    }
    if (service.organizationId) {
      const execution = await getExecution(pool, service.organizationId, executionId);
      if (!execution) {
        throw new ApiError(404, "NOT_FOUND", "execution not found");
      }
      return execution;
    }
    const result = await pool.query(
      `SELECT * FROM audit.executions WHERE id = $1`,
      [executionId]
    );
    if (!result.rows[0]) {
      throw new ApiError(404, "NOT_FOUND", "execution not found");
    }
    return result.rows[0];
  }

  app.post("/internal/v1/executions", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    const body = request.body as {
      organization_id?: string;
      actor_id?: string;
      skill_id?: string;
      risk_tier?: RiskTier;
      retention_mode?: string;
      request?: unknown;
    };
    const organizationId = service.organizationId
      ? assertOrganizationScope(service.organizationId, body.organization_id)
      : body.organization_id;
    if (!organizationId || !body.actor_id || !body.skill_id) {
      throw new ApiError(400, "INVALID_INPUT", "organization_id, actor_id, and skill_id are required");
    }
    const membership = await pool.query<{ role_id: string }>(
      `SELECT role_id FROM auth.memberships WHERE user_id = $1 AND organization_id = $2`,
      [body.actor_id, organizationId]
    );
    if (!membership.rows[0]) {
      throw new ApiError(403, "NOT_A_MEMBER", "actor is not a member of that organization");
    }
    const execution = await openGovernedExecution(pool, {
      organizationId,
      actorId: body.actor_id,
      skillId: body.skill_id,
      riskTier: body.risk_tier ?? "low",
      retentionMode: body.retention_mode ?? "standard",
      request: body.request ?? {},
      roleId: membership.rows[0].role_id,
    });
    return {
      execution_id: execution.id,
      verity_record_id: execution.verity_record_id,
      status: execution.status,
    };
  });

  app.post("/internal/v1/executions/:executionId/knowledge/retrieve", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    const { executionId } = request.params as { executionId: string };
    await requireScopedExecution(service, executionId);
    if (!service.scopes.includes("knowledge.read")) {
      throw new ApiError(403, "FORBIDDEN", "missing knowledge.read scope");
    }
    const body = request.body as {
      query?: string;
      collection_ids?: string[];
      mode?: KnowledgeMode;
      top_k?: number;
      classification_ceiling?: DataClassification;
    };
    if (!body.query || !body.collection_ids?.length) {
      throw new ApiError(400, "INVALID_INPUT", "query and collection_ids are required");
    }
    return retrieveForExecution(pool, {
      executionId,
      query: body.query,
      collectionIds: body.collection_ids,
      mode: body.mode ?? "strict",
      topK: body.top_k,
      classificationCeiling: body.classification_ceiling ?? "internal",
    });
  });

  app.post("/internal/v1/executions/:executionId/model/execute", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    const { executionId } = request.params as { executionId: string };
    await requireScopedExecution(service, executionId);
    if (!service.scopes.includes("models.read")) {
      throw new ApiError(403, "FORBIDDEN", "missing models.read scope");
    }
    const body = request.body as {
      task?: string;
      risk_tier?: RiskTier;
      data_classification?: DataClassification;
      required_capabilities?: string[];
      prefer_local?: boolean;
      content?: string;
      retrieval_run_id?: string;
      context_chunk_ids?: string[];
    };
    if (!body.task || !body.content || !body.risk_tier || !body.data_classification) {
      throw new ApiError(400, "INVALID_INPUT", "task, content, risk_tier, and data_classification are required");
    }
    return executeModelForExecution(pool, {
      executionId,
      task: body.task,
      riskTier: body.risk_tier,
      dataClassification: body.data_classification,
      requiredCapabilities: body.required_capabilities,
      preferLocal: body.prefer_local,
      content: body.content,
      retrievalRunId: body.retrieval_run_id,
      contextChunkIds: body.context_chunk_ids,
    });
  });

  app.post("/internal/v1/executions/:executionId/finalize", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    const { executionId } = request.params as { executionId: string };
    const execution = await requireScopedExecution(service, executionId);
    const body = request.body as {
      outcome?: "completed" | "failed" | "blocked";
      inject_failure?: boolean;
    };
    return finalizeGovernedExecution(pool, {
      executionId,
      organizationId: execution.organization_id,
      outcome: body.outcome ?? "completed",
      injectFailure:
        body.inject_failure === true && process.env.VERITY_ALLOW_FAILURE_INJECTION === "true",
    });
  });

  function requireExecutionsWrite(service: ServiceContext) {
    if (!service.scopes.includes(EXECUTIONS_WRITE_SCOPE)) {
      throw new ApiError(403, "FORBIDDEN", "missing executions.write scope");
    }
  }

  app.post("/internal/v1/executions/:executionId/skill/start", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    requireExecutionsWrite(service);
    const execution = await requireScopedExecution(service, (request.params as { executionId: string }).executionId);
    const body = request.body as {
      skill_id?: string;
      skill_version?: string;
      brand_id?: string;
      config_hash?: string;
    };
    if (!body.skill_id || !body.skill_version) {
      throw new ApiError(400, "INVALID_INPUT", "skill_id and skill_version are required");
    }
    return recordSkillLifecycleEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      phase: "start",
      skillId: body.skill_id,
      skillVersion: body.skill_version,
      brandId: body.brand_id,
      configHash: body.config_hash,
    });
  });

  app.post("/internal/v1/executions/:executionId/skill/complete", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    requireExecutionsWrite(service);
    const execution = await requireScopedExecution(service, (request.params as { executionId: string }).executionId);
    const body = request.body as {
      skill_id?: string;
      skill_version?: string;
      brand_id?: string;
      config_hash?: string;
      result_artifact_hash?: string;
    };
    if (!body.skill_id || !body.skill_version) {
      throw new ApiError(400, "INVALID_INPUT", "skill_id and skill_version are required");
    }
    return recordSkillLifecycleEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      phase: "complete",
      skillId: body.skill_id,
      skillVersion: body.skill_version,
      brandId: body.brand_id,
      configHash: body.config_hash,
      resultArtifactHash: body.result_artifact_hash,
    });
  });

  app.post("/internal/v1/executions/:executionId/skill/fail", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    requireExecutionsWrite(service);
    const execution = await requireScopedExecution(service, (request.params as { executionId: string }).executionId);
    const body = request.body as {
      skill_id?: string;
      skill_version?: string;
      reason_code?: string;
    };
    if (!body.skill_id || !body.skill_version) {
      throw new ApiError(400, "INVALID_INPUT", "skill_id and skill_version are required");
    }
    return recordSkillLifecycleEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      phase: "fail",
      skillId: body.skill_id,
      skillVersion: body.skill_version,
      reasonCode: body.reason_code,
    });
  });

  app.post("/internal/v1/executions/:executionId/approval/request", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    requireExecutionsWrite(service);
    const execution = await requireScopedExecution(service, (request.params as { executionId: string }).executionId);
    const body = request.body as {
      skill_id?: string;
      requested_by?: string;
      artifact_hash?: string;
    };
    if (!body.skill_id || !body.requested_by || !body.artifact_hash) {
      throw new ApiError(400, "INVALID_INPUT", "skill_id, requested_by, and artifact_hash are required");
    }
    return requestExecutionApproval(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      skillId: body.skill_id,
      requestedBy: body.requested_by,
      artifactHash: body.artifact_hash,
    });
  });

  app.post("/internal/v1/executions/:executionId/approval/decide", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    requireExecutionsWrite(service);
    const execution = await requireScopedExecution(service, (request.params as { executionId: string }).executionId);
    const body = request.body as {
      approval_id?: string;
      actor_id?: string;
      allow?: boolean;
      artifact_hash?: string;
    };
    if (!body.approval_id || !body.actor_id || !body.artifact_hash || typeof body.allow !== "boolean") {
      throw new ApiError(400, "INVALID_INPUT", "approval_id, actor_id, allow, and artifact_hash are required");
    }
    return decideExecutionApproval(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      approvalId: body.approval_id,
      actorId: body.actor_id,
      allow: body.allow,
      artifactHash: body.artifact_hash,
    });
  });

  app.get("/internal/v1/executions/:executionId/record", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    const execution = await requireScopedExecution(service, (request.params as { executionId: string }).executionId);
    return getVerityRecord(pool, execution.organization_id, execution.verity_record_id);
  });

  app.post("/internal/v1/executions/:executionId/connectors/actions", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    requireExecutionsWrite(service);
    const execution = await requireScopedExecution(
      service,
      (request.params as { executionId: string }).executionId
    );
    const body = request.body as {
      connector_id?: string;
      connector_type?: string;
      action?: string;
      artifact_id?: string;
      artifact_hash?: string;
      actor_id?: string;
      payload?: Record<string, unknown>;
    };
    if (!body.action || !body.artifact_hash || !body.actor_id) {
      throw new ApiError(400, "INVALID_INPUT", "action, artifact_hash, and actor_id are required");
    }
    return requestConnectorAction(
      pool,
      { registry: connectorRegistry, secrets: connectorSecrets },
      {
        organizationId: execution.organization_id,
        executionId: execution.id,
        actorId: body.actor_id,
        connectorId: body.connector_id,
        connectorType: body.connector_type ?? "meta.facebook",
        action: body.action,
        artifactId: body.artifact_id,
        artifactHash: body.artifact_hash,
        payload: body.payload ?? {},
      }
    );
  });

  app.get("/internal/v1/executions/:executionId/connectors/actions/:actionId", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    const { executionId, actionId } = request.params as { executionId: string; actionId: string };
    const execution = await requireScopedExecution(service, executionId);
    return getConnectorAction(pool, execution.organization_id, execution.id, actionId);
  });

  app.post("/internal/v1/connectors/:connectorId/health", async (request) => {
    const service = await resolveServiceToken(pool, bearer(request));
    requireExecutionsWrite(service);
    const { connectorId } = request.params as { connectorId: string };
    if (!service.organizationId) {
      throw new ApiError(403, "FORBIDDEN", "connector health requires an organization-scoped credential");
    }
    return healthCheckConnector(
      pool,
      { registry: connectorRegistry, secrets: connectorSecrets },
      { organizationId: service.organizationId, connectorId }
    );
  });

  app.get("/v1/audit/records", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "audit.read");
    return { records: await listVerityRecords(pool, auth.organizationId) };
  });

  app.get("/v1/audit/records/:verityRecordId", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "audit.read");
    const { verityRecordId } = request.params as { verityRecordId: string };
    return getVerityRecord(pool, auth.organizationId, verityRecordId);
  });

  app.get("/v1/audit/records/:verityRecordId/graph", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "audit.read");
    const { verityRecordId } = request.params as { verityRecordId: string };
    return getVerityGraph(pool, auth.organizationId, verityRecordId);
  });

  app.post("/v1/audit/records/:verityRecordId/verify", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "audit.read");
    enforceLimit(limiters.audit, `verify:${auth.userId}`, "too many verification requests");
    const { verityRecordId } = request.params as { verityRecordId: string };
    const record = await getVerityRecord(pool, auth.organizationId, verityRecordId);
    const bundle = await exportOrganizationEvidence(pool, auth.organizationId);
    const verification = verifyEvidenceBundle(bundle);
    const provenanceVerified =
      verification.valid && record.provenance_status === "linked";
    return {
      verity_record_id: verityRecordId,
      integrity_verified: verification.valid,
      provenance_verified: provenanceVerified,
      integrity_status: verification.valid ? "verified" : "failed",
      provenance_status: provenanceVerified ? "verified" : record.provenance_status,
      integrity_label: verification.valid ? "Integrity Verified" : "Not Verified",
      provenance_label: provenanceVerified ? "Provenance Verified" : record.provenance_status === "linked" ? "Linked" : record.provenance_status === "unlinked" ? "Unlinked" : "Not Verified",
      issues: verification.issues,
    };
  });

  app.get("/v1/home/summary", async (request) => {
    const auth = await requireSession(pool, request);
    return homeSummary(pool, auth);
  });

  app.get("/v1/system/status", async (request) => {
    const auth = await requireSession(pool, request);
    return systemStatus(pool, novaInvoke, auth.organizationId);
  });

  app.get("/v1/command/skills", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "policies.read");
    return { skills: await listCommandSkills(pool, auth.organizationId) };
  });

  app.get("/v1/connectors", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "connectors.manage");
    return { connectors: await listConnectorsSafe(pool, auth.organizationId) };
  });

  app.post("/v1/connectors/:connectorId/health", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "connectors.manage");
    const { connectorId } = request.params as { connectorId: string };
    return sessionConnectorHealth(
      pool,
      { registry: connectorRegistry, secrets: connectorSecrets },
      auth,
      connectorId
    );
  });

  app.get("/v1/approvals", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "approvals.read");
    const status = (request.query as { status?: string }).status;
    return { approvals: await listApprovals(pool, auth.organizationId, status) };
  });

  app.get("/v1/knowledge/collections/:collectionId", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "knowledge.read");
    const { collectionId } = request.params as { collectionId: string };
    return collectionDetail(pool, auth, collectionId);
  });

  app.get("/v1/social/brands", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "nova.use");
    return { brands: await listBrands(pool, auth.organizationId) };
  });

  app.get("/v1/nova/skills", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "nova.use");
    const catalog = novaSkillCatalog();
    if (!novaInvoke) {
      return { skills: catalog, source: "command" };
    }
    try {
      const live = (await novaInvoke("/internal/v1/skills")) as { skills?: typeof catalog };
      return { skills: live.skills?.length ? live.skills : catalog, source: "nova" };
    } catch {
      return { skills: catalog, source: "command" };
    }
  });

  app.post("/v1/nova/skills/:skillId/execute", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "nova.use");
    enforceLimit(limiters.nova, `nova:${auth.userId}`, "too many Nova executions");
    if (!novaInvoke) {
      throw new ApiError(503, "NOVA_UNAVAILABLE", "Nova runtime is not configured");
    }
    const { skillId } = request.params as { skillId: string };
    if (skillId === "nova.social.draft") {
      requirePermission(auth, "social.draft");
    }
    const skillPolicy = await evaluatePolicy(pool, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      roleId: auth.roleId,
      action: {
        type: "skill.use",
        skillId,
        classification: "internal",
        riskTier: "medium",
      },
    });
    if (skillPolicy.decision === "deny") {
      throw new ApiError(403, skillPolicy.reason_code, "skill execution denied");
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if ("actor_id" in body || "organization_id" in body) {
      throw new ApiError(400, "UNTRUSTED_ACTOR", "actor and organization are derived from the session");
    }
    try {
      return await novaInvoke(`/internal/v1/skills/${encodeURIComponent(skillId)}/execute`, {
        method: "POST",
        requestId: request.requestId,
        body: {
          ...body,
          actor_id: auth.userId,
          organization_id: auth.organizationId,
        },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err && typeof err === "object" && "statusCode" in err && "code" in err) {
        const mapped = err as { statusCode: number; code: string; message?: string };
        throw new ApiError(mapped.statusCode, mapped.code, mapped.message ?? "nova request failed");
      }
      throw new ApiError(503, "NOVA_UNAVAILABLE", "nova request failed");
    }
  });

  app.get("/v1/nova/runs", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "nova.use");
    return { runs: await novaRuns(pool, auth.organizationId) };
  });

  app.get("/v1/nova/runs/:executionId", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "nova.use");
    const { executionId } = request.params as { executionId: string };
    return novaRunDetail(pool, auth.organizationId, executionId);
  });

  app.post("/v1/nova/runs/:executionId/approvals/:approvalId/decide", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "approvals.decide");
    enforceLimit(limiters.approval, `approval:${auth.userId}`, "too many approval decisions");
    const { executionId, approvalId } = request.params as { executionId: string; approvalId: string };
    const body = request.body as { allow?: boolean; artifact_hash?: string };
    if (typeof body.allow !== "boolean" || !body.artifact_hash) {
      throw new ApiError(400, "INVALID_INPUT", "allow and artifact_hash are required");
    }
    return sessionDecideApproval(pool, auth, executionId, approvalId, body.allow, body.artifact_hash);
  });

  app.post("/v1/nova/runs/:executionId/publish", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "nova.use");
    if (!novaInvoke) {
      throw new ApiError(503, "NOVA_UNAVAILABLE", "Nova runtime is not configured");
    }
    const { executionId } = request.params as { executionId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    return novaInvoke("/publish", {
      method: "POST",
      body: {
        execution_id: executionId,
        actor_id: auth.userId,
        organization_id: auth.organizationId,
        action: body.action ?? "publish_post",
        scheduled_for: body.scheduled_for,
      },
    });
  });

  app.post("/v1/executions/:executionId/connectors/actions", async (request) => {
    const auth = await requireSession(pool, request);
    requirePermission(auth, "nova.use");
    enforceLimit(limiters.connector, `connector:${auth.userId}`, "too many connector actions");
    requirePermission(auth, "social.draft");
    const { executionId } = request.params as { executionId: string };
    const body = request.body as {
      connector_id?: string;
      connector_type?: string;
      action?: string;
      artifact_hash?: string;
      payload?: Record<string, unknown>;
    };
    if (!body.action || !body.artifact_hash) {
      throw new ApiError(400, "INVALID_INPUT", "action and artifact_hash are required");
    }
    return sessionConnectorAction(
      pool,
      { registry: connectorRegistry, secrets: connectorSecrets },
      auth,
      executionId,
      {
        connector_id: body.connector_id,
        connector_type: body.connector_type,
        action: body.action,
        artifact_hash: body.artifact_hash,
        payload: body.payload,
      }
    );
  });

  return { app, pool };
}
