import type { Pool } from "pg";
import {
  appendExecutionEvent,
  appendLedgerEntry,
  getExecution,
  listExecutionEvents,
  openExecution,
  sealExecution,
  sha256Hex,
  type AppendExecutionEventInput,
  type ExecutionEventRow,
} from "@verityos/audit-kernel";
import { evaluatePolicy } from "@verityos/command";
import type {
  DataClassification,
  KnowledgeMode,
  RiskTier,
} from "@verityos/contracts";
import { AuthError } from "@verityos/identity";
import {
  loadRetrievalRun,
  loadReturnedChunks,
  markChunksIncludedInContext,
  retrieve,
} from "@verityos/knowledge";
import {
  adapterFor,
  getModel,
  routeModel,
} from "@verityos/model-router";
import { ApiError } from "../errors.js";
import { loadConfig } from "../config.js";
import { buildGovernedPrompt } from "./prompt.js";

export class ExecutionError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function lastEventId(
  pool: Pool,
  organizationId: string,
  executionId: string
): Promise<string | undefined> {
  const events = await listExecutionEvents(pool, organizationId, executionId);
  return events.at(-1)?.id;
}

export async function openGovernedExecution(
  pool: Pool,
  input: {
    organizationId: string;
    actorId: string;
    sessionId?: string | null;
    skillId: string;
    riskTier: RiskTier;
    retentionMode?: string | null;
    request: unknown;
    roleId: string;
  }
) {
  const execution = await openExecution(pool, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    sessionId: input.sessionId ?? null,
    skillId: input.skillId,
    riskTier: input.riskTier,
    retentionMode: input.retentionMode ?? "standard",
  });
  const created = await appendExecutionEvent(pool, {
    organizationId: input.organizationId,
    executionId: execution.id,
    eventType: "execution.created",
    status: "recorded",
    metadata: { skill_id: input.skillId, risk_tier: input.riskTier },
  });
  await appendExecutionEvent(pool, {
    organizationId: input.organizationId,
    executionId: execution.id,
    eventType: "identity.authenticated",
    status: "ok",
    parentEventIds: [created.id],
    metadata: { actor_id: input.actorId, role_id: input.roleId },
  });
  const requestHash = sha256Hex(JSON.stringify(input.request ?? {}));
  await appendLedgerEntry(pool, {
    organizationId: input.organizationId,
    executionId: execution.id,
    entryType: "request_opened",
    requestHash,
    responseHash: null,
    executionGraphHash: null,
  });
  const running = await getExecution(pool, input.organizationId, execution.id);
  return running ?? execution;
}

export async function retrieveForExecution(
  pool: Pool,
  input: {
    executionId: string;
    query: string;
    collectionIds: string[];
    mode: KnowledgeMode;
    topK?: number;
    classificationCeiling: DataClassification;
  }
) {
  const execution = await requireOpenExecution(pool, input.executionId);
  const actorId = execution.actor_id;
  if (!actorId) {
    throw new ExecutionError("NO_ACTOR", "execution has no actor", 400);
  }
  const membership = await pool.query<{ role_id: string }>(
    `SELECT role_id FROM auth.memberships WHERE user_id = $1 AND organization_id = $2`,
    [actorId, execution.organization_id]
  );
  if (!membership.rows[0]) {
    throw new AuthError("NOT_A_MEMBER", "actor is not a member of that organization", 403);
  }
  const roleId = membership.rows[0].role_id;
  const parent = await lastEventId(pool, execution.organization_id, execution.id);
  const authStarted = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: "authorization.started",
    status: "started",
    parentEventIds: parent ? [parent] : [],
    metadata: { action: "knowledge.read" },
  });
  const policy = await evaluatePolicy(pool, {
    organizationId: execution.organization_id,
    actorId,
    roleId,
    action: { type: "knowledge.read", classification: input.classificationCeiling },
  });
  if (policy.decision !== "allow") {
    await appendExecutionEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "authorization.denied",
      status: "denied",
      parentEventIds: [authStarted.id],
      metadata: { reason_code: policy.reason_code, policy_id: policy.policy_id },
    });
    throw new ApiError(403, policy.reason_code, "knowledge retrieve denied");
  }
  const authAllowed = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: "authorization.allowed",
    status: "ok",
    parentEventIds: [authStarted.id],
    metadata: { reason_code: policy.reason_code, policy_id: policy.policy_id },
  });
  const classified = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: "risk.classified",
    status: "recorded",
    parentEventIds: [authAllowed.id],
    metadata: {
      risk_tier: execution.risk_tier,
      classification: input.classificationCeiling,
    },
  });
  const started = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: "knowledge.retrieval.started",
    status: "started",
    parentEventIds: [classified.id],
    inputHash: sha256Hex(input.query),
    metadata: {
      mode: input.mode,
      collection_ids: input.collectionIds,
    },
  });
  const result = await retrieve(pool, {
    organizationId: execution.organization_id,
    actorId,
    roleId,
    executionId: execution.id,
    query: input.query,
    collectionIds: input.collectionIds,
    mode: input.mode,
    topK: input.topK ?? 8,
    classificationCeiling: input.classificationCeiling,
  });
  const eventType = result.insufficient_evidence
    ? "knowledge.retrieval.insufficient"
    : "knowledge.retrieval.completed";
  await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType,
    status: result.insufficient_evidence ? "insufficient" : "ok",
    parentEventIds: [started.id],
    outputHash: sha256Hex(result.retrieval_run_id),
    metadata: {
      retrieval_run_id: result.retrieval_run_id,
      collection_ids: input.collectionIds,
      source_version_ids: [...new Set(result.hits.map((h) => h.source_version_id))],
      chunk_ids: result.hits.map((h) => h.chunk_id),
      classification: input.classificationCeiling,
      mode: result.mode,
      insufficient_evidence: result.insufficient_evidence,
    },
  });
  return result;
}

export async function executeModelForExecution(
  pool: Pool,
  input: {
    executionId: string;
    task: string;
    riskTier: RiskTier;
    dataClassification: DataClassification;
    requiredCapabilities?: string[];
    preferLocal?: boolean;
    content: string;
    retrievalRunId?: string;
    contextChunkIds?: string[];
  }
) {
  const execution = await requireOpenExecution(pool, input.executionId);
  const actorId = execution.actor_id;
  if (!actorId) {
    throw new ExecutionError("NO_ACTOR", "execution has no actor", 400);
  }
  const membership = await pool.query<{ role_id: string }>(
    `SELECT role_id FROM auth.memberships WHERE user_id = $1 AND organization_id = $2`,
    [actorId, execution.organization_id]
  );
  if (!membership.rows[0]) {
    throw new AuthError("NOT_A_MEMBER", "actor is not a member of that organization", 403);
  }
  const roleId = membership.rows[0].role_id;
  const parent = await lastEventId(pool, execution.organization_id, execution.id);
  const authStarted = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: "authorization.started",
    status: "started",
    parentEventIds: parent ? [parent] : [],
    metadata: { action: "model.execute" },
  });
  const policy = await evaluatePolicy(pool, {
    organizationId: execution.organization_id,
    actorId,
    roleId,
    action: {
      type: "skill.use",
      skillId: "models.route",
      classification: input.dataClassification,
      riskTier: input.riskTier,
    },
  });
  if (policy.decision !== "allow") {
    await appendExecutionEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "authorization.denied",
      status: "denied",
      parentEventIds: [authStarted.id],
      metadata: { reason_code: policy.reason_code, policy_id: policy.policy_id },
    });
    throw new ApiError(403, policy.reason_code, "model execution denied");
  }
  const authAllowed = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: "authorization.allowed",
    status: "ok",
    parentEventIds: [authStarted.id],
    metadata: { reason_code: policy.reason_code, policy_id: policy.policy_id },
  });

  let knowledgeChunks: Array<{ chunk_id: string; text: string; source_version_id: string }> = [];
  if (input.retrievalRunId) {
    const run = await loadRetrievalRun(pool, {
      organizationId: execution.organization_id,
      retrievalRunId: input.retrievalRunId,
    });
    if (run.execution_id !== execution.id) {
      throw new ExecutionError("RETRIEVAL_MISMATCH", "retrieval run does not belong to this execution", 403);
    }
    if (run.mode === "strict" && run.insufficient_evidence) {
      await appendExecutionEvent(pool, {
        organizationId: execution.organization_id,
        executionId: execution.id,
        eventType: "release.blocked",
        status: "blocked",
        parentEventIds: [authAllowed.id],
        metadata: {
          reason_code: "INSUFFICIENT_EVIDENCE",
          retrieval_run_id: run.id,
        },
      });
      throw new ExecutionError("INSUFFICIENT_EVIDENCE", "strict knowledge is insufficient", 409);
    }
    const requestedIds = input.contextChunkIds ?? [];
    if (requestedIds.length > 0) {
      const returned = await loadReturnedChunks(pool, {
        organizationId: execution.organization_id,
        retrievalRunId: input.retrievalRunId,
        chunkIds: requestedIds,
      });
      if (returned.length !== requestedIds.length) {
        throw new ExecutionError("INVALID_CONTEXT_CHUNK", "context chunk is not part of the retrieval run", 400);
      }
      if (returned.some((chunk) => !chunk.returned_to_caller)) {
        throw new ExecutionError("INVALID_CONTEXT_CHUNK", "context chunk was not returned to caller", 400);
      }
      knowledgeChunks = returned.map((chunk) => ({
        chunk_id: chunk.chunk_id,
        text: chunk.text,
        source_version_id: chunk.source_version_id,
      }));
    }
  } else if (input.contextChunkIds?.length) {
    throw new ExecutionError("INVALID_CONTEXT_CHUNK", "retrieval_run_id is required with context_chunk_ids", 400);
  }

  const routingStarted = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: "model.routing.started",
    status: "started",
    parentEventIds: [authAllowed.id],
    metadata: { task: input.task },
  });
  const routed = await routeModel(pool, {
    organizationId: execution.organization_id,
    actorId,
    roleId,
    request: {
      execution_id: execution.id,
      task: input.task,
      risk_tier: input.riskTier,
      data_classification: input.dataClassification,
      required_capabilities: input.requiredCapabilities ?? ["chat"],
      prefer_local: input.preferLocal ?? false,
    },
  });
  if (!routed.model_id || !routed.provider || !routed.deployment_type) {
    await appendExecutionEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "model.routing.failed",
      status: "failed",
      parentEventIds: [routingStarted.id],
      metadata: { selection_reason_code: routed.selection_reason_code },
    });
    throw new ExecutionError("NO_ALLOWED_MODEL", routed.selection_reason_code, 409);
  }
  const selected = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: "model.selected",
    status: "ok",
    parentEventIds: [routingStarted.id],
    metadata: {
      model_id: routed.model_id,
      provider: routed.provider,
      deployment_type: routed.deployment_type,
      selection_reason_code: routed.selection_reason_code,
    },
  });
  const model = await getModel(pool, execution.organization_id, routed.model_id);
  if (!model) {
    throw new ExecutionError("NO_ALLOWED_MODEL", "selected model not found", 409);
  }
  const built = buildGovernedPrompt({
    skillId: execution.skill_id ?? "models.route",
    userContent: input.content,
    knowledgeChunks,
  });
  if (input.retrievalRunId && built.includedChunkIds.length > 0) {
    await markChunksIncludedInContext(pool, {
      organizationId: execution.organization_id,
      retrievalRunId: input.retrievalRunId,
      chunkIds: built.includedChunkIds,
    });
  }
  const execStarted = await appendExecutionEvent(pool, {
    organizationId: execution.organization_id,
    executionId: execution.id,
    eventType: "model.execution.started",
    status: "started",
    parentEventIds: [selected.id],
    inputHash: built.promptHash,
    metadata: {
      retrieval_run_id: input.retrievalRunId ?? null,
      included_chunk_ids: built.includedChunkIds,
      source_version_ids: [...new Set(knowledgeChunks.map((c) => c.source_version_id))],
      prompt_hash: built.promptHash,
    },
  });
  const config = loadConfig();
  const startedAt = Date.now();
  try {
    const adapter = adapterFor(model.provider, {
      openai: config.openaiKey,
      anthropic: config.anthropicKey,
      compatible: config.compatibleKey,
    });
    const completion = await adapter.complete({
      model,
      prompt: built.prompt,
      executionId: execution.id,
    });
    const latencyMs = Math.max(0, Math.round(Date.now() - startedAt));
    const outputHash = sha256Hex(completion.text);
    await appendExecutionEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "model.execution.completed",
      status: "ok",
      parentEventIds: [execStarted.id],
      inputHash: built.promptHash,
      outputHash,
      metadata: {
        provider: completion.provider,
        model_id: model.id,
        deployment_type: model.deployment_type,
        latency_ms: latencyMs,
        input_tokens: completion.usage.input_tokens,
        output_tokens: completion.usage.output_tokens,
        prompt_hash: built.promptHash,
        output_hash: outputHash,
      },
    });
    return {
      text: completion.text,
      prompt_hash: built.promptHash,
      output_hash: outputHash,
      model_id: model.id,
      provider: model.provider,
      deployment_type: model.deployment_type,
      latency_ms: latencyMs,
      usage: completion.usage,
      included_chunk_ids: built.includedChunkIds,
    };
  } catch {
    await appendExecutionEvent(pool, {
      organizationId: execution.organization_id,
      executionId: execution.id,
      eventType: "model.execution.failed",
      status: "failed",
      parentEventIds: [execStarted.id],
      metadata: { reason_code: "PROVIDER_FAILURE" },
    });
    throw new ExecutionError("PROVIDER_FAILURE", "model provider failed", 502);
  }
}

export async function finalizeGovernedExecution(
  pool: Pool,
  input: {
    executionId: string;
    organizationId?: string;
    outcome: "completed" | "failed" | "blocked";
    response?: unknown;
    injectFailure?: boolean;
  }
) {
  const execution = input.organizationId
    ? await getExecution(pool, input.organizationId, input.executionId)
    : await requireExecutionById(pool, input.executionId);
  if (!execution) {
    throw new ExecutionError("NOT_FOUND", "execution not found", 404);
  }
  if (["completed", "failed", "blocked", "cancelled"].includes(execution.status)) {
    throw new ExecutionError("INVALID_EXECUTION_TRANSITION", "execution already terminal", 409);
  }
  const parent = await lastEventId(pool, execution.organization_id, execution.id);
  const parentEventIds = parent ? [parent] : [];
  const prelude: Array<Omit<AppendExecutionEventInput, "organizationId" | "executionId">> = [
    {
      eventType: "validation.started",
      status: "started",
      parentEventIds,
      metadata: {},
    },
    {
      eventType: input.outcome === "completed" ? "validation.passed" : "validation.failed",
      status: input.outcome === "completed" ? "ok" : "failed",
      parentEventIds: [],
      metadata: { outcome: input.outcome },
    },
    {
      eventType:
        input.outcome === "completed"
          ? "execution.completed"
          : input.outcome === "blocked"
            ? "execution.blocked"
            : "execution.failed",
      status: input.outcome === "completed" ? "ok" : input.outcome,
      parentEventIds: [],
      metadata: {},
    },
  ];
  if (input.outcome === "completed") {
    prelude.push(
      {
        eventType: "release.started",
        status: "started",
        parentEventIds: [],
        metadata: {},
      },
      {
        eventType: "release.completed",
        status: "ok",
        parentEventIds: [],
        metadata: {},
      }
    );
  } else {
    prelude.push({
      eventType: "release.blocked",
      status: "blocked",
      parentEventIds: [],
      metadata: { outcome: input.outcome },
    });
  }
  const requestHash = sha256Hex(execution.id);
  const responseHash = input.response === undefined ? null : sha256Hex(JSON.stringify(input.response));
  const sealed = await sealExecution(
    pool,
    {
      organizationId: execution.organization_id,
      executionId: execution.id,
      entryType: input.outcome === "completed" ? "final" : "failure",
      executionStatus: input.outcome,
      requestHash,
      responseHash,
      parentEventIds,
      preludeEvents: prelude,
    },
    input.injectFailure
      ? {
          beforeCommit: async () => {
            throw new Error("injected finalization failure");
          },
        }
      : {}
  );
  return {
    execution_id: execution.id,
    verity_record_id: execution.verity_record_id,
    status: input.outcome,
    execution_graph_hash: sealed.graphHash,
    graph: sealed.graph,
    final_entry_id: sealed.entry.id,
  };
}

async function requireOpenExecution(pool: Pool, executionId: string) {
  const execution = await requireExecutionById(pool, executionId);
  if (["completed", "failed", "blocked", "cancelled"].includes(execution.status)) {
    throw new ExecutionError("INVALID_EXECUTION_TRANSITION", "execution is terminal", 409);
  }
  return execution;
}

async function requireExecutionById(pool: Pool, executionId: string) {
  const result = await pool.query(
    `SELECT * FROM audit.executions WHERE id = $1`,
    [executionId]
  );
  if (!result.rows[0]) {
    throw new ExecutionError("NOT_FOUND", "execution not found", 404);
  }
  return result.rows[0];
}

export function summarizeEvents(events: ExecutionEventRow[]) {
  const knowledge = events.filter((e) => e.event_type.startsWith("knowledge.retrieval"));
  const model = events.filter((e) => e.event_type.startsWith("model."));
  const approval = events.filter((e) => e.event_type.startsWith("approval."));
  return {
    knowledge: knowledge.at(-1)?.metadata ?? null,
    model: model.at(-1)?.metadata ?? null,
    approval: approval.at(-1)?.metadata ?? null,
  };
}
