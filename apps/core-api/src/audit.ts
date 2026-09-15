import type { Pool } from "pg";
import { getExecution, sha256Hex } from "@verityos/audit-kernel";
import type { LedgerEntryType } from "@verityos/contracts";
import {
  ExecutionError,
  finalizeGovernedExecution,
  openGovernedExecution,
} from "./execution/service.js";

export async function withStandaloneExecution<T>(
  pool: Pool,
  input: {
    organizationId: string;
    actorId: string;
    sessionId?: string | null;
    skillId: string;
    roleId: string;
    request: unknown;
    executionId?: string;
  },
  fn: (executionId: string) => Promise<T>
): Promise<T & { execution_id: string; verity_record_id: string }> {
  if (input.executionId) {
    const existing = await getExecution(pool, input.organizationId, input.executionId);
    if (!existing) {
      throw new ExecutionError("NOT_FOUND", "execution not found", 404);
    }
    const result = await fn(input.executionId);
    return Object.assign(result as T & object, {
      execution_id: existing.id,
      verity_record_id: existing.verity_record_id,
    });
  }
  const execution = await openGovernedExecution(pool, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    skillId: input.skillId,
    riskTier: "low",
    request: input.request,
    roleId: input.roleId,
  });
  try {
    const result = await fn(execution.id);
    const sealed = await finalizeGovernedExecution(pool, {
      executionId: execution.id,
      organizationId: input.organizationId,
      outcome: "completed",
      response: result,
    });
    return Object.assign(result as T & object, {
      execution_id: execution.id,
      verity_record_id: sealed.verity_record_id,
    });
  } catch (err) {
    await finalizeGovernedExecution(pool, {
      executionId: execution.id,
      organizationId: input.organizationId,
      outcome: "failed",
    }).catch(() => undefined);
    throw err;
  }
}

export async function recordKernelCheckpoint(
  pool: Pool,
  input: {
    organizationId: string;
    actorId: string;
    sessionId?: string | null;
    skillId: string;
    roleId: string;
    entryType: LedgerEntryType;
    request: unknown;
    response?: unknown;
    executionId?: string;
  }
): Promise<string> {
  const wrapped = await withStandaloneExecution(
    pool,
    {
      organizationId: input.organizationId,
      actorId: input.actorId,
      sessionId: input.sessionId,
      skillId: input.skillId,
      roleId: input.roleId,
      request: input.request,
      executionId: input.executionId,
    },
    async () => ({
      request_hash: sha256Hex(JSON.stringify(input.request)),
      response_hash:
        input.response === undefined ? null : sha256Hex(JSON.stringify(input.response)),
      entry_type: input.entryType,
    })
  );
  return wrapped.execution_id;
}
