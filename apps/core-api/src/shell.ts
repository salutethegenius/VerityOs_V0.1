import { existsSync } from "node:fs";
import type { Pool } from "pg";
import {
  getExecution,
  listExecutionEvents,
  listExecutions,
} from "@verityos/audit-kernel";
import { decideExecutionApproval } from "./execution/lifecycle.js";
import { finalizeGovernedExecution } from "./execution/service.js";
import { getVerityRecord, listVerityRecords } from "./execution/records.js";
import { requestConnectorAction, healthCheckConnector } from "./connectors/gateway.js";
import { ApiError } from "./errors.js";
import type { ConnectorRegistry, SecretResolver } from "@verityos/connectors";
import { listModels } from "@verityos/model-router";
import {
  collectionIdForSource,
  listReadableCollections,
  requireCollectionPermission,
} from "@verityos/knowledge";
import type { AuthContext } from "@verityos/identity";
import { PRODUCTION_EMBEDDING_DIMENSIONS } from "@verityos/knowledge";
import { loadPermissions } from "@verityos/identity";

export type NovaInvoker = (
  path: string,
  init?: { method?: string; body?: unknown; requestId?: string }
) => Promise<unknown>;

export function createNovaInvoker(baseUrl?: string, token?: string): NovaInvoker | undefined {
  const url = (baseUrl ?? process.env.NOVA_INTERNAL_URL ?? "").replace(/\/$/, "");
  const secret = token ?? process.env.NOVA_INTERNAL_TOKEN ?? "";
  if (!url || !secret) {
    return undefined;
  }
  return async (path, init) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    };
    if (init?.requestId) {
      headers["x-request-id"] = init.requestId;
    }
    const response = await fetch(`${url}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: { code: "NOVA_UNAVAILABLE", message: text || "nova returned non-JSON" } };
    }
    if (!response.ok) {
      const err = payload as { detail?: { code?: string; message?: string }; error?: { code?: string; message?: string } };
      const code = err.error?.code ?? err.detail?.code ?? "NOVA_UNAVAILABLE";
      const message = err.error?.message ?? err.detail?.message ?? "nova request failed";
      throw new ApiError(response.status >= 400 ? response.status : 502, code, message);
    }
    return payload;
  };
}

export async function sessionProfile(pool: Pool, auth: AuthContext) {
  const row = await pool.query<{
    email: string;
    display_name: string;
    organization_name: string;
  }>(
    `SELECT u.email, u.display_name, o.name AS organization_name
     FROM auth.users u
     JOIN auth.organizations o ON o.id = $2
     WHERE u.id = $1`,
    [auth.userId, auth.organizationId]
  );
  const profile = row.rows[0];
  return {
    user_id: auth.userId,
    display_name: profile?.display_name ?? "",
    email: profile?.email ?? "",
    organization_id: auth.organizationId,
    organization: profile?.organization_name ?? "",
    role: auth.roleName,
    permissions: auth.permissions,
  };
}

export async function homeSummary(pool: Pool, auth: AuthContext) {
  const [
    collections,
    approved,
    pending,
    models,
    connectors,
    records,
    skills,
    chain,
  ] = await Promise.all([
    listReadableCollections(pool, { organizationId: auth.organizationId, roleId: auth.roleId }),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM knowledge.source_versions v
       JOIN knowledge.sources s ON s.id = v.source_id
       JOIN knowledge.collections c ON c.id = s.collection_id
       JOIN knowledge.collection_permissions p
         ON p.collection_id = c.id AND p.role_id = $2 AND p.can_read = true
       WHERE v.organization_id = $1 AND v.approved_at IS NOT NULL`,
      [auth.organizationId, auth.roleId]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM command.approvals
       WHERE organization_id = $1 AND status = 'pending'`,
      [auth.organizationId]
    ),
    listModels(pool, auth.organizationId),
    pool.query<{ count: string; enabled: string }>(
      `SELECT COUNT(*)::text AS count,
              COUNT(*) FILTER (WHERE enabled)::text AS enabled
       FROM command.connectors WHERE organization_id = $1`,
      [auth.organizationId]
    ),
    listVerityRecords(pool, auth.organizationId),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM command.skill_policies
       WHERE organization_id = $1 AND skill_id LIKE 'nova.%'`,
      [auth.organizationId]
    ),
    pool.query<{ seq: string | null }>(
      `SELECT MAX(organization_sequence)::text AS seq
       FROM audit.ledger_entries WHERE organization_id = $1`,
      [auth.organizationId]
    ),
  ]);
  const db = await pool.query("SELECT 1 AS ok");
  return {
    system: { status: db.rows[0] ? "healthy" : "unavailable", database: Boolean(db.rows[0]) },
    nova: { enabled_skills: Number(skills.rows[0]?.count ?? 0) },
    knowledge: {
      collections: collections.length,
      approved_sources: Number(approved.rows[0]?.count ?? 0),
    },
    approvals: { pending: Number(pending.rows[0]?.count ?? 0) },
    models: { available: models.filter((m) => m.enabled).length, total: models.length },
    connectors: {
      configured: Number(connectors.rows[0]?.count ?? 0),
      enabled: Number(connectors.rows[0]?.enabled ?? 0),
    },
    audit: {
      latest_chain_sequence: chain.rows[0]?.seq ? Number(chain.rows[0].seq) : null,
      recent_records: records.slice(0, 8),
    },
  };
}

export async function systemStatus(
  pool: Pool,
  novaInvoke: NovaInvoker | undefined,
  organizationId: string
) {
  const db = await pool.query("SELECT 1 AS ok");
  let nova: { status: string; phase?: string; version?: string } = { status: "unconfigured" };
  if (novaInvoke) {
    try {
      const health = (await novaInvoke("/health", { method: "GET" })) as {
        status?: string;
        phase?: string;
        version?: string;
      };
      nova = { status: health.status ?? "ok", phase: health.phase, version: health.version };
    } catch {
      nova = { status: "unavailable" };
    }
  }
  const models = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM command.models WHERE organization_id = $1`,
    [organizationId]
  );
  const connectors = await pool.query<{ connector_key: string; enabled: boolean }>(
    `SELECT connector_key, enabled FROM command.connectors
     WHERE organization_id = $1 ORDER BY connector_key`,
    [organizationId]
  );
  const dataDir = process.env.VERITY_DATA_DIR ?? "./data";
  return {
    core: { status: "ok", phase: "11", database: Boolean(db.rows[0]) },
    nova,
    kernel: {
      version: process.env.AUDIT_KERNEL_VERSION ?? "0.2.0",
      hash_format_version: "2",
      execution_graph_schema_version: "2",
    },
    storage: { configured: existsSync(dataDir), provider: "filesystem" },
    embeddings: {
      provider: process.env.VERITY_EMBEDDING_PROVIDER ?? "mock",
      dimensions: PRODUCTION_EMBEDDING_DIMENSIONS,
    },
    models: { count: Number(models.rows[0]?.count ?? 0) },
    connectors: connectors.rows.map((row) => ({
      key: row.connector_key,
      enabled: row.enabled,
    })),
    deployment_profile: process.env.VERITY_PROFILE ?? process.env.VERITY_DEPLOYMENT_PROFILE ?? "development",
  };
}

const NOVA_SKILL_CATALOG = [
  {
    id: "nova.research",
    name: "Research",
    version: "1.0.0",
    risk_tier: "medium",
    knowledge_mode: "strict",
    required_permissions: ["nova.use", "knowledge.read"],
    approval: false,
  },
  {
    id: "nova.drafting",
    name: "Drafting",
    version: "1.0.0",
    risk_tier: "medium",
    knowledge_mode: "grounded",
    required_permissions: ["nova.use"],
    approval: false,
  },
  {
    id: "nova.social.draft",
    name: "Social Draft",
    version: "1.0.0",
    risk_tier: "medium",
    knowledge_mode: "grounded",
    required_permissions: ["nova.use", "social.draft"],
    approval: true,
  },
] as const;

export function novaSkillCatalog() {
  return NOVA_SKILL_CATALOG.map((skill) => ({ ...skill }));
}

export async function listCommandSkills(pool: Pool, organizationId: string) {
  const result = await pool.query<{
    skill_id: string;
    requires_approval: boolean;
    classification_ceiling: string;
    risk_ceiling: string;
  }>(
    `SELECT skill_id, requires_approval, classification_ceiling, risk_ceiling
     FROM command.skill_policies
     WHERE organization_id = $1
     ORDER BY skill_id`,
    [organizationId]
  );
  const catalog = new Map<string, (typeof NOVA_SKILL_CATALOG)[number]>(
    NOVA_SKILL_CATALOG.map((skill) => [skill.id, skill])
  );
  return result.rows.map((row) => {
    const meta = catalog.get(row.skill_id);
    return {
      id: row.skill_id,
      name: meta?.name ?? row.skill_id,
      version: meta?.version ?? "1.0.0",
      risk_tier: row.risk_ceiling,
      knowledge_mode: meta?.knowledge_mode ?? null,
      required_permissions: meta?.required_permissions ?? [],
      approval_policy: row.requires_approval ? "required_for_external_action" : "none",
      classification_ceiling: row.classification_ceiling,
      requires_approval: row.requires_approval,
    };
  });
}

export async function listUsersForShell(pool: Pool, organizationId: string) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, r.name AS role,
            CASE WHEN u.disabled_at IS NULL THEN 'active' ELSE 'disabled' END AS status
     FROM auth.memberships m
     JOIN auth.users u ON u.id = m.user_id
     JOIN auth.roles r ON r.id = m.role_id
     WHERE m.organization_id = $1
     ORDER BY u.email`,
    [organizationId]
  );
  return result.rows;
}

export async function listRolesForShell(pool: Pool, organizationId: string) {
  const roles = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM auth.roles WHERE organization_id = $1 ORDER BY name`,
    [organizationId]
  );
  return Promise.all(
    roles.rows.map(async (role) => ({
      id: role.id,
      name: role.name,
      description: role.name,
      permissions: await loadPermissions(pool, role.id),
    }))
  );
}

export async function listPoliciesForShell(pool: Pool, organizationId: string) {
  const result = await pool.query(
    `SELECT p.id, p.name, p.version, p.status, p.rules, p.created_at,
            COALESCE(
              json_agg(
                json_build_object('id', b.id, 'skill_id', b.skill_id)
              ) FILTER (WHERE b.id IS NOT NULL),
              '[]'::json
            ) AS bindings
     FROM command.policies p
     LEFT JOIN command.policy_bindings b
       ON b.policy_id = p.id AND b.organization_id = p.organization_id
     WHERE p.organization_id = $1
     GROUP BY p.id
     ORDER BY p.name, p.version DESC`,
    [organizationId]
  );
  return result.rows.map((row) => ({
    ...row,
    rules_summary: summarizePolicyRules(row.rules),
  }));
}

function summarizePolicyRules(rules: unknown) {
  if (!rules || typeof rules !== "object") {
    return [];
  }
  const typed = rules as {
    leave_device?: Record<string, boolean>;
    cloud_models?: Record<string, boolean>;
  };
  const summary: string[] = [];
  for (const [classification, allowed] of Object.entries(typed.leave_device ?? {})) {
    summary.push(
      allowed
        ? `${classification} may leave device`
        : `${classification} must remain on device`
    );
  }
  for (const [classification, allowed] of Object.entries(typed.cloud_models ?? {})) {
    summary.push(
      allowed ? `${classification} may use cloud models` : `${classification} cannot use cloud models`
    );
  }
  return summary;
}

export async function listCollectionsForShell(
  pool: Pool,
  input: { organizationId: string; roleId: string }
) {
  const result = await pool.query(
    `SELECT c.id, c.name, c.classification, c.created_at,
            p.can_read, p.can_manage, p.can_approve,
            COUNT(s.id)::int AS source_count
     FROM knowledge.collections c
     JOIN knowledge.collection_permissions p
       ON p.collection_id = c.id
      AND p.organization_id = c.organization_id
      AND p.role_id = $2
      AND p.can_read = true
     LEFT JOIN knowledge.sources s
       ON s.collection_id = c.id AND s.organization_id = c.organization_id
     WHERE c.organization_id = $1
     GROUP BY c.id, p.can_read, p.can_manage, p.can_approve
     ORDER BY c.name`,
    [input.organizationId, input.roleId]
  );
  return result.rows;
}

export async function listConnectorsSafe(pool: Pool, organizationId: string) {
  const result = await pool.query(
    `SELECT id, connector_key, connector_type, enabled, capabilities, requires_approval,
            version, secret_ref, page_config
     FROM command.connectors
     WHERE organization_id = $1
     ORDER BY connector_key`,
    [organizationId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.connector_key,
    type: row.connector_type,
    enabled: row.enabled,
    capabilities: row.capabilities,
    requires_approval: row.requires_approval,
    version: row.version,
    secret_ref: row.secret_ref,
    page_id: (row.page_config as { page_id?: string } | null)?.page_id ?? null,
  }));
}

export async function listApprovals(pool: Pool, organizationId: string, status?: string) {
  const dbStatus = status === "rejected" ? "denied" : status;
  const result = await pool.query(
    `SELECT a.id, a.execution_id, a.skill_id, a.requested_by, a.decided_by, a.status,
            a.reason_code, a.artifact_hash, a.created_at, a.decided_at,
            e.risk_tier, e.verity_record_id, e.status AS execution_status,
            ru.display_name AS requested_by_name, ru.email AS requested_by_email,
            du.display_name AS decided_by_name, du.email AS decided_by_email
     FROM command.approvals a
     JOIN audit.executions e
       ON e.id = a.execution_id AND e.organization_id = a.organization_id
     LEFT JOIN auth.users ru ON ru.id = a.requested_by
     LEFT JOIN auth.users du ON du.id = a.decided_by
     WHERE a.organization_id = $1
       AND ($2::text IS NULL OR a.status = $2)
     ORDER BY a.created_at DESC`,
    [organizationId, dbStatus ?? null]
  );
  return result.rows;
}

export async function collectionDetail(
  pool: Pool,
  auth: AuthContext,
  collectionId: string
) {
  await requireCollectionPermission(pool, {
    organizationId: auth.organizationId,
    collectionId,
    roleId: auth.roleId,
    capability: "can_read",
  });
  const collection = await pool.query(
    `SELECT c.id, c.name, c.classification, c.created_at,
            p.can_read, p.can_manage, p.can_approve
     FROM knowledge.collections c
     JOIN knowledge.collection_permissions p
       ON p.collection_id = c.id AND p.role_id = $3
     WHERE c.id = $1 AND c.organization_id = $2`,
    [collectionId, auth.organizationId, auth.roleId]
  );
  if (!collection.rows[0]) {
    throw new ApiError(404, "NOT_FOUND", "collection not found");
  }
  const sources = await pool.query(
    `SELECT s.id, s.title, s.created_at,
            COUNT(v.id)::int AS version_count,
            COUNT(v.id) FILTER (WHERE v.approved_at IS NOT NULL)::int AS approved_versions,
            COUNT(ch.id)::int AS indexed_chunks
     FROM knowledge.sources s
     LEFT JOIN knowledge.source_versions v ON v.source_id = s.id
     LEFT JOIN knowledge.chunks ch ON ch.source_version_id = v.id
     WHERE s.collection_id = $1 AND s.organization_id = $2
     GROUP BY s.id
     ORDER BY s.created_at DESC`,
    [collectionId, auth.organizationId]
  );
  return { collection: collection.rows[0], sources: sources.rows };
}

export async function sourceDetail(pool: Pool, auth: AuthContext, sourceId: string) {
  const collectionId = await collectionIdForSource(pool, {
    organizationId: auth.organizationId,
    sourceId,
  });
  await requireCollectionPermission(pool, {
    organizationId: auth.organizationId,
    collectionId,
    roleId: auth.roleId,
    capability: "can_read",
  });
  const source = await pool.query(
    `SELECT id, organization_id, collection_id, title, created_by, created_at
     FROM knowledge.sources WHERE id = $1 AND organization_id = $2`,
    [sourceId, auth.organizationId]
  );
  if (!source.rows[0]) {
    throw new ApiError(404, "NOT_FOUND", "source not found");
  }
  const versions = await pool.query(
    `SELECT id, version_number, content_hash, mime_type, original_filename, parser_version,
            effective_at, uploaded_by, approved_by, approved_at, created_at,
            EXISTS (SELECT 1 FROM knowledge.chunks c WHERE c.source_version_id = v.id) AS indexed
     FROM knowledge.source_versions v
     WHERE source_id = $1 AND organization_id = $2
     ORDER BY version_number DESC`,
    [sourceId, auth.organizationId]
  );
  return { source: source.rows[0], versions: versions.rows, collection_id: collectionId };
}

export async function novaRuns(pool: Pool, organizationId: string, actorId?: string) {
  const executions = await listExecutions(pool, organizationId);
  return executions
    .filter((row) => (row.skill_id ?? "").startsWith("nova."))
    .filter((row) => !actorId || row.actor_id === actorId)
    .slice(0, 50)
    .map((row) => ({
      execution_id: row.id,
      verity_record_id: row.verity_record_id,
      skill_id: row.skill_id,
      status: row.status,
      risk_tier: row.risk_tier,
      actor_id: row.actor_id,
      started_at: row.started_at,
      completed_at: row.completed_at,
    }));
}

export async function novaRunDetail(pool: Pool, organizationId: string, executionId: string) {
  const execution = await getExecution(pool, organizationId, executionId);
  if (!execution) {
    throw new ApiError(404, "NOT_FOUND", "execution not found");
  }
  const events = await listExecutionEvents(pool, organizationId, executionId);
  const record = execution.verity_record_id
    ? await getVerityRecord(pool, organizationId, execution.verity_record_id)
    : null;
  const item = await pool.query(
    `SELECT id, brand_id, platform, draft_text, status, artifact_hash, approval_id,
            connector_action_id, scheduled_for, external_action_id
     FROM social.content_items
     WHERE organization_id = $1 AND execution_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [organizationId, executionId]
  );
  const approval = await pool.query(
    `SELECT a.id, a.status, a.artifact_hash, a.requested_by, a.decided_by, a.created_at, a.decided_at,
            ru.display_name AS requested_by_name, ru.email AS requested_by_email,
            du.display_name AS decided_by_name, du.email AS decided_by_email
     FROM command.approvals a
     LEFT JOIN auth.users ru ON ru.id = a.requested_by
     LEFT JOIN auth.users du ON du.id = a.decided_by
     WHERE a.organization_id = $1 AND a.execution_id = $2
     ORDER BY a.created_at DESC LIMIT 1`,
    [organizationId, executionId]
  );
  return {
    execution,
    events: events.map((event) => ({
      id: event.id,
      event_type: event.event_type,
      status: event.status,
      created_at: event.created_at,
      metadata: event.metadata,
    })),
    record,
    social_item: item.rows[0] ?? null,
    approval: approval.rows[0] ?? null,
    citations: await citationsFromRetrievalEvents(pool, organizationId, events),
  };
}

async function citationsFromRetrievalEvents(
  pool: Pool,
  organizationId: string,
  events: Array<{ event_type: string; metadata: Record<string, unknown> | null }>
) {
  const retrieval = [...events]
    .reverse()
    .find(
      (event) =>
        event.event_type === "knowledge.retrieval.completed" ||
        event.event_type === "knowledge.retrieval.insufficient"
    );
  if (!retrieval?.metadata) {
    return [];
  }
  const chunkIds = Array.isArray(retrieval.metadata.chunk_ids)
    ? retrieval.metadata.chunk_ids.filter((id): id is string => typeof id === "string")
    : [];
  if (chunkIds.length === 0) {
    return [];
  }
  const rows = await pool.query<{
    source_id: string;
    source_version_id: string;
    title: string;
    chunk_count: number;
  }>(
    `SELECT s.id AS source_id, v.id AS source_version_id, s.title, COUNT(*)::int AS chunk_count
     FROM knowledge.chunks c
     JOIN knowledge.source_versions v
       ON v.id = c.source_version_id AND v.organization_id = c.organization_id
     JOIN knowledge.sources s
       ON s.id = v.source_id AND s.organization_id = c.organization_id
     WHERE c.organization_id = $1 AND c.id = ANY($2::uuid[])
     GROUP BY s.id, v.id, s.title
     ORDER BY s.title`,
    [organizationId, chunkIds]
  );
  return rows.rows;
}

export async function listBrands(pool: Pool, organizationId: string) {
  const result = await pool.query(
    `SELECT brand_id, display_name, active, config_version, platforms
     FROM social.brands WHERE organization_id = $1 ORDER BY brand_id`,
    [organizationId]
  );
  return result.rows;
}

export async function sessionConnectorAction(
  pool: Pool,
  deps: { registry: ConnectorRegistry; secrets: SecretResolver },
  auth: AuthContext,
  executionId: string,
  body: {
    connector_id?: string;
    connector_type?: string;
    action: string;
    artifact_hash: string;
    payload?: Record<string, unknown>;
  }
) {
  const result = await requestConnectorAction(pool, deps, {
    organizationId: auth.organizationId,
    executionId,
    actorId: auth.userId,
    connectorId: body.connector_id,
    connectorType: body.connector_type,
    action: body.action,
    artifactHash: body.artifact_hash,
    payload: body.payload ?? {},
  });
  const status = (result as { status?: string }).status;
  if (status === "succeeded") {
    const execution = await getExecution(pool, auth.organizationId, executionId);
    if (execution && !["completed", "failed", "blocked", "cancelled"].includes(execution.status)) {
      try {
        await finalizeGovernedExecution(pool, {
          executionId,
          organizationId: auth.organizationId,
          outcome: "completed",
          response: { connector_action: status },
        });
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
        if (code !== "INVALID_EXECUTION_TRANSITION") {
          throw err;
        }
      }
    }
  }
  return result;
}

export async function sessionConnectorHealth(
  pool: Pool,
  deps: { registry: ConnectorRegistry; secrets: SecretResolver },
  auth: AuthContext,
  connectorId: string
) {
  return healthCheckConnector(pool, deps, {
    organizationId: auth.organizationId,
    connectorId,
  });
}

export async function sessionDecideApproval(
  pool: Pool,
  auth: AuthContext,
  executionId: string,
  approvalId: string,
  allow: boolean,
  artifactHash: string
) {
  const decision = await decideExecutionApproval(pool, {
    organizationId: auth.organizationId,
    executionId,
    approvalId,
    actorId: auth.userId,
    allow,
    artifactHash,
  });
  await pool.query(
    `UPDATE social.content_items
     SET status = $4
     WHERE organization_id = $1
       AND execution_id = $2
       AND artifact_hash = $3
       AND status IN ('pending_approval', 'approved')`,
    [auth.organizationId, executionId, artifactHash, allow ? "approved" : "rejected"]
  );
  return decision;
}
