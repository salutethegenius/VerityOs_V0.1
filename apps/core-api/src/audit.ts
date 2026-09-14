import type { Pool } from "pg";
import {
  appendLedgerEntry,
  openExecution,
  sha256Hex,
} from "@verityos/audit-kernel";
import type { LedgerEntryType } from "@verityos/contracts";

export async function recordKernelCheckpoint(
  pool: Pool,
  input: {
    organizationId: string;
    actorId: string;
    sessionId?: string | null;
    skillId: string;
    entryType: LedgerEntryType;
    request: unknown;
    response?: unknown;
  }
): Promise<string> {
  const execution = await openExecution(pool, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    sessionId: input.sessionId ?? null,
    skillId: input.skillId,
  });
  const requestHash = sha256Hex(JSON.stringify(input.request));
  const responseHash = input.response === undefined ? null : sha256Hex(JSON.stringify(input.response));
  await appendLedgerEntry(pool, {
    organizationId: input.organizationId,
    executionId: execution.id,
    entryType: input.entryType,
    requestHash,
    responseHash,
    executionGraphHash: null,
  });
  return execution.id;
}
