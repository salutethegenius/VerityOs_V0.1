import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import pg from "pg";
import {
  appendExecutionEvent,
  appendExecutionEventInTransaction,
  getExecution,
  listExecutionEvents,
} from "@verityos/audit-kernel";
import {
  evaluateConnectorAction,
  getConnector,
  getConnectorByType,
  getPendingApprovalForExecution,
  type ConnectorRow,
} from "@verityos/command";
import {
  ConnectorError,
  requestHash,
  sha256Hex,
  type ConnectorActionResult,
  type ConnectorRegistry,
  type SecretResolver,
} from "@verityos/connectors";
import { ExecutionError } from "../execution/service.js";

export interface ConnectorGatewayDeps {
  registry: ConnectorRegistry;
  secrets: SecretResolver;
}

export interface RequestConnectorActionInput {
  organizationId: string;
  executionId: string;
  actorId: string;
  connectorId?: string;
  connectorType?: string;
  action: string;
  artifactId?: string;
  artifactHash: string;
  payload: Record<string, unknown>;
  classification?: "public" | "internal" | "confidential" | "restricted";
}

type ActionRow = {
  id: string;
  organization_id: string;
  execution_id: string;
  connector_id: string;
  action: string;
  artifact_hash: string;
  idempotency_key: string;
  status: string;
  external_action_id: string | null;
  request_hash: string | null;
  response_hash: string | null;
  requested_by: string;
  approved_by: string | null;
  error_code: string | null;
  scheduled_for: Date | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

function publicAction(row: ActionRow, extras: Record<string, unknown> = {}) {
  return {
    action_id: row.id,
    organization_id: row.organization_id,
    execution_id: row.execution_id,
    connector_id: row.connector_id,
    action: row.action,
    artifact_hash: row.artifact_hash,
    idempotency_key: row.idempotency_key,
    status: row.status,
    external_action_id: row.external_action_id,
    request_hash: row.request_hash,
    response_hash: row.response_hash,
    requested_by: row.requested_by,
    approved_by: row.approved_by,
    error_code: row.error_code,
    scheduled_for: row.scheduled_for?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    started_at: row.started_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    ...extras,
  };
}

async function lastEventId(pool: Pool, organizationId: string, executionId: string) {
  const events = await listExecutionEvents(pool, organizationId, executionId);
  return events.at(-1)?.id;
}

async function appendToolEvent(
  db: Pool | PoolClient,
  input: {
    organizationId: string;
    executionId: string;
    eventType: "tool.requested" | "tool.authorized" | "tool.denied" | "tool.completed" | "tool.failed";
    status: string;
    artifactHash: string;
    metadata: Record<string, unknown>;
    outputHash?: string | null;
  }
) {
  let parent: string | undefined;
  if (db instanceof pg.Pool) {
    parent = await lastEventId(db, input.organizationId, input.executionId);
  } else {
    parent = (
      await db.query<{ id: string }>(
        `SELECT id FROM audit.execution_events
         WHERE organization_id = $1 AND execution_id = $2
         ORDER BY event_sequence DESC LIMIT 1`,
        [input.organizationId, input.executionId]
      )
    ).rows[0]?.id;
  }
  const payload = {
    organizationId: input.organizationId,
    executionId: input.executionId,
    eventType: input.eventType,
    status: input.status,
    parentEventIds: parent ? [parent] : [],
    outputHash: input.outputHash ?? input.artifactHash,
    metadata: input.metadata,
  };
  if (db instanceof pg.Pool) {
    await appendExecutionEvent(db, payload);
  } else {
    await appendExecutionEventInTransaction(db, payload);
  }
}

async function loadAction(client: Pool | PoolClient, organizationId: string, actionId: string) {
  const result = await client.query<ActionRow>(
    `SELECT * FROM command.connector_actions WHERE organization_id = $1 AND id = $2`,
    [organizationId, actionId]
  );
  return result.rows[0] ?? null;
}

async function loadActionByKey(client: Pool | PoolClient, organizationId: string, key: string) {
  const result = await client.query<ActionRow>(
    `SELECT * FROM command.connector_actions WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, key]
  );
  return result.rows[0] ?? null;
}

async function updateSocialItem(
  pool: Pool,
  organizationId: string,
  executionId: string,
  patch: {
    status: string;
    connectorActionId: string;
    externalActionId?: string | null;
    scheduledFor?: string | null;
  }
) {
  await pool.query(
    `UPDATE social.content_items
     SET status = $3,
         connector_action_id = $4,
         external_action_id = COALESCE($5, external_action_id),
         scheduled_for = COALESCE($6::timestamptz, scheduled_for)
     WHERE organization_id = $1 AND execution_id = $2`,
    [
      organizationId,
      executionId,
      patch.status,
      patch.connectorActionId,
      patch.externalActionId ?? null,
      patch.scheduledFor ?? null,
    ]
  );
}

export async function healthCheckConnector(
  pool: Pool,
  deps: ConnectorGatewayDeps,
  input: { organizationId: string; connectorId: string }
) {
  const connector = await getConnector(pool, input.organizationId, input.connectorId);
  if (!connector || connector.organization_id !== input.organizationId) {
    throw new ExecutionError("NOT_FOUND", "connector not found", 404);
  }
  const implementation = deps.registry.resolve(connector.connector_type);
  const secret = connector.secret_ref ? deps.secrets(connector.secret_ref) : undefined;
  const pageId = String(connector.page_config.page_id ?? "");
  if (!connector.enabled) {
    return {
      ok: false,
      connector_id: connector.id,
      connector_type: connector.connector_type,
      reason_code: "CONNECTOR_DISABLED",
    };
  }
  if (!secret || !pageId) {
    return {
      ok: false,
      connector_id: connector.id,
      connector_type: connector.connector_type,
      reason_code: "CONNECTOR_NOT_CONFIGURED",
    };
  }
  return implementation.health({ connectorId: connector.id, pageId, secret });
}

export async function getConnectorAction(
  pool: Pool,
  organizationId: string,
  executionId: string,
  actionId: string
) {
  const execution = await getExecution(pool, organizationId, executionId);
  if (!execution) {
    throw new ExecutionError("NOT_FOUND", "execution not found", 404);
  }
  const row = await loadAction(pool, organizationId, actionId);
  if (!row || row.execution_id !== executionId) {
    throw new ExecutionError("NOT_FOUND", "connector action not found", 404);
  }
  return publicAction(row);
}

export async function requestConnectorAction(
  pool: Pool,
  deps: ConnectorGatewayDeps,
  input: RequestConnectorActionInput
) {
  if (!/^[0-9a-f]{64}$/.test(input.artifactHash)) {
    throw new ExecutionError("INVALID_INPUT", "artifact_hash must be a lowercase SHA-256 hex string", 400);
  }
  const execution = await getExecution(pool, input.organizationId, input.executionId);
  if (!execution) {
    throw new ExecutionError("NOT_FOUND", "execution not found", 404);
  }
  if (execution.organization_id !== input.organizationId) {
    throw new ExecutionError("CROSS_ORGANIZATION_DENIED", "organization mismatch", 403);
  }
  if (["completed", "failed", "blocked", "cancelled"].includes(execution.status)) {
    throw new ExecutionError("INVALID_EXECUTION_TRANSITION", "execution is terminal", 409);
  }
  if (execution.status === "waiting_approval") {
    throw new ExecutionError("APPROVAL_MISSING", "approval is required before connector execution", 409);
  }

  const membership = await pool.query<{ role_id: string }>(
    `SELECT role_id FROM auth.memberships WHERE user_id = $1 AND organization_id = $2`,
    [input.actorId, execution.organization_id]
  );
  if (!membership.rows[0]) {
    throw new ExecutionError("ACTOR_NOT_AUTHORIZED", "actor is not a member of this organization", 403);
  }

  let connector: ConnectorRow | null = null;
  if (input.connectorId) {
    connector = await getConnector(pool, execution.organization_id, input.connectorId);
  } else if (input.connectorType) {
    connector = await getConnectorByType(pool, execution.organization_id, input.connectorType);
  }
  if (!connector || connector.organization_id !== execution.organization_id) {
    throw new ExecutionError("NOT_FOUND", "connector not found", 404);
  }

  const pageId = String(connector.page_config.page_id ?? "");
  const message = String(input.payload.message ?? "");
  if (sha256Hex(message) !== input.artifactHash) {
    throw new ExecutionError("APPROVAL_ARTIFACT_MISMATCH", "payload message does not match artifact hash", 409);
  }

  const item = await pool.query<{
    id: string;
    status: string;
    artifact_hash: string;
    draft_text: string;
  }>(
    `SELECT id, status, artifact_hash, draft_text
     FROM social.content_items
     WHERE organization_id = $1 AND execution_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [execution.organization_id, execution.id]
  );
  const social = item.rows[0];
  if (social) {
    if (social.artifact_hash !== input.artifactHash || social.draft_text !== message) {
      throw new ExecutionError("APPROVAL_ARTIFACT_MISMATCH", "social artifact does not match approved bytes", 409);
    }
    if (social.status === "pending_approval") {
      throw new ExecutionError("APPROVAL_MISSING", "content is not approved", 409);
    }
  }

  if (!execution.skill_id) {
    throw new ExecutionError("CONNECTOR_NOT_ALLOWED_FOR_SKILL", "execution has no skill", 403);
  }

  const approval = await getPendingApprovalForExecution(pool, execution.organization_id, execution.id);
  const policy = await evaluateConnectorAction(pool, {
    organizationId: execution.organization_id,
    actorId: input.actorId,
    roleId: membership.rows[0].role_id,
    skillId: execution.skill_id,
    connectorKey: connector.connector_key,
    action: input.action,
    classification: input.classification ?? "internal",
    approvalStatus: approval?.status ?? null,
    approvalArtifactHash: approval?.artifact_hash ?? null,
    requestedArtifactHash: input.artifactHash,
  });

  const scheduledFor = typeof input.payload.scheduled_for === "string" ? input.payload.scheduled_for : null;
  const idempotencyKey = requestHash({
    organization_id: execution.organization_id,
    execution_id: execution.id,
    connector_id: connector.id,
    action: input.action,
    artifact_hash: input.artifactHash,
    scheduled_for: scheduledFor,
  });

  const existing = await loadActionByKey(pool, execution.organization_id, idempotencyKey);
  if (existing) {
    return publicAction(existing, { replayed: true, policy_reason_code: "CONNECTOR_ALLOWED" });
  }

  const toolMeta = {
    connector_id: connector.id,
    connector_type: connector.connector_type,
    action: input.action,
    artifact_hash: input.artifactHash,
    policy_id: policy.policy_id,
    policy_reason_code: policy.reason_code,
  };

  if (policy.decision !== "allow") {
    await appendToolEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "tool.requested",
      status: "started",
      artifactHash: input.artifactHash,
      metadata: toolMeta,
    });
    await appendToolEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "tool.denied",
      status: "denied",
      artifactHash: input.artifactHash,
      metadata: { ...toolMeta, policy_reason_code: policy.reason_code },
    });
    throw new ExecutionError(policy.reason_code, "connector action denied", 403);
  }

  const actionId = randomUUID();
  const hashedRequest = requestHash({
    action: input.action,
    artifact_hash: input.artifactHash,
    message,
    page_id: pageId || null,
    scheduled_for: scheduledFor,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const approvedBy =
      approval?.status === "approved"
        ? (
            await client.query<{ decided_by: string | null }>(
              `SELECT decided_by FROM command.approvals WHERE id = $1`,
              [approval.id]
            )
          ).rows[0]?.decided_by ?? null
        : null;
    await client.query(
      `INSERT INTO command.connector_actions (
         id, organization_id, execution_id, connector_id, action, artifact_hash,
         idempotency_key, status, request_hash, requested_by, approved_by, scheduled_for, started_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'authorized',$8,$9,$10,$11::timestamptz, now())`,
      [
        actionId,
        execution.organization_id,
        execution.id,
        connector.id,
        input.action,
        input.artifactHash,
        idempotencyKey,
        hashedRequest,
        input.actorId,
        approvedBy,
        scheduledFor,
      ]
    );
    await appendToolEvent(client, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "tool.requested",
      status: "started",
      artifactHash: input.artifactHash,
      metadata: toolMeta,
    });
    await appendToolEvent(client, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "tool.authorized",
      status: "ok",
      artifactHash: input.artifactHash,
      metadata: toolMeta,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    const duplicate = err as { code?: string };
    if (duplicate.code === "23505") {
      const replayed = await loadActionByKey(pool, execution.organization_id, idempotencyKey);
      if (replayed) {
        return publicAction(replayed, { replayed: true });
      }
    }
    throw err;
  } finally {
    client.release();
  }

  if (social && (social.status === "approved" || social.status === "publishing")) {
    await pool.query(
      `UPDATE social.content_items SET status = $3, connector_action_id = $4
       WHERE id = $1 AND organization_id = $2 AND status IN ('approved','publishing')`,
      [social.id, execution.organization_id, input.action === "schedule_post" ? "scheduling" : "publishing", actionId]
    );
  }

  const secret = connector.secret_ref ? deps.secrets(connector.secret_ref) : undefined;
  if (!secret || !pageId) {
    await finishAction(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      actionId,
      status: "failed",
      errorCode: "CONNECTOR_NOT_CONFIGURED",
      artifactHash: input.artifactHash,
      metadata: toolMeta,
      socialStatus: "error",
    });
    throw new ExecutionError("CONNECTOR_NOT_CONFIGURED", "connector secret or page is not configured", 503);
  }

  await pool.query(
    `UPDATE command.connector_actions SET status = 'executing', started_at = COALESCE(started_at, now())
     WHERE id = $1 AND organization_id = $2`,
    [actionId, execution.organization_id]
  );

  const implementation = deps.registry.resolve(connector.connector_type);
  let result: ConnectorActionResult;
  try {
    result = await implementation.execute({
      connectorId: connector.id,
      connectorType: connector.connector_type,
      action: input.action,
      artifactHash: input.artifactHash,
      payload: input.payload,
      secret,
      pageId,
      scheduledFor,
    });
  } catch (err) {
    const connectorErr = err instanceof ConnectorError ? err : null;
    const ambiguous = connectorErr?.ambiguous === true;
    const errorCode = connectorErr?.code ?? "PROVIDER_REJECTED";
    const status = ambiguous ? "needs_review" : "failed";
    await finishAction(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      actionId,
      status,
      errorCode,
      artifactHash: input.artifactHash,
      metadata: {
        ...toolMeta,
        http_class: connectorErr?.httpClass ?? null,
      },
      socialStatus: ambiguous ? "needs_review" : "error",
    });
    const row = await loadAction(pool, execution.organization_id, actionId);
    return publicAction(row!, { policy_reason_code: policy.reason_code });
  }

  const socialStatus = input.action === "schedule_post" ? "scheduled" : "posted";
  await finishAction(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    actionId,
    status: "succeeded",
    errorCode: null,
    artifactHash: input.artifactHash,
    metadata: { ...toolMeta, http_class: result.metadata.http_class ?? "2xx" },
    externalActionId: result.external_action_id,
    requestHash: result.request_hash,
    responseHash: result.response_hash,
    socialStatus,
    scheduledFor,
    eventType: "tool.completed",
  });
  const row = await loadAction(pool, execution.organization_id, actionId);
  return publicAction(row!, { policy_reason_code: policy.reason_code, message_hash: sha256Hex(message) });
}

async function finishAction(
  pool: Pool,
  input: {
    organizationId: string;
    executionId: string;
    actionId: string;
    status: string;
    errorCode: string | null;
    artifactHash: string;
    metadata: Record<string, unknown>;
    externalActionId?: string | null;
    requestHash?: string | null;
    responseHash?: string | null;
    socialStatus: string;
    scheduledFor?: string | null;
    eventType?: "tool.completed" | "tool.failed";
  }
) {
  await pool.query(
    `UPDATE command.connector_actions
     SET status = $3,
         error_code = $4,
         external_action_id = COALESCE($5, external_action_id),
         request_hash = COALESCE($6, request_hash),
         response_hash = COALESCE($7, response_hash),
         completed_at = now()
     WHERE id = $1 AND organization_id = $2`,
    [
      input.actionId,
      input.organizationId,
      input.status,
      input.errorCode,
      input.externalActionId ?? null,
      input.requestHash ?? null,
      input.responseHash ?? null,
    ]
  );
  const eventType = input.eventType ?? "tool.failed";
  await appendToolEvent(pool, {
    organizationId: input.organizationId,
    executionId: input.executionId,
    eventType,
    status: input.status === "succeeded" ? "ok" : input.status === "needs_review" ? "failed" : "failed",
    artifactHash: input.artifactHash,
    metadata: {
      ...input.metadata,
      external_action_id: input.externalActionId ?? null,
      error_code: input.errorCode,
    },
    outputHash: input.responseHash ?? input.artifactHash,
  });
  await updateSocialItem(pool, input.organizationId, input.executionId, {
    status: input.socialStatus,
    connectorActionId: input.actionId,
    externalActionId: input.externalActionId ?? null,
    scheduledFor: input.scheduledFor ?? null,
  });
}
