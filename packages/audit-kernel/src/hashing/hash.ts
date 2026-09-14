import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { LedgerEntryType } from "@verityos/contracts";
import { canonicalize } from "./canonicalize.js";

export const HASH_FORMAT_VERSION = "2" as const;
export const KERNEL_VERSION = "0.2.0";

export function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}

export function hashContent(content: string): string {
  return sha256Hex(content);
}

/**
 * UTC RFC 3339 timestamp with millisecond precision and Z suffix.
 * Callers must persist this exact string as created_at_canonical.
 */
export function canonicalTimestampNow(): string {
  return new Date().toISOString();
}

export interface V2HashPayload {
  hash_format_version: typeof HASH_FORMAT_VERSION;
  organization_id: string;
  ledger_sequence: number;
  execution_id: string;
  entry_type: LedgerEntryType;
  request_hash: string | null;
  response_hash: string | null;
  execution_graph_hash: string | null;
  previous_entry_hash: string | null;
  kernel_version: string;
  created_at: string;
}

export interface HashFieldInput {
  organizationId: string;
  ledgerSequence: number;
  executionId: string;
  entryType: LedgerEntryType;
  requestHash: string | null;
  responseHash: string | null;
  executionGraphHash: string | null;
  previousEntryHash: string | null;
  kernelVersion?: string;
  createdAtCanonical: string;
}

/**
 * Build the V2 hash payload. Every key is always present. Unavailable hashes
 * are JSON null — never omitted and never empty strings.
 */
export function buildHashPayload(input: HashFieldInput): V2HashPayload {
  return {
    hash_format_version: HASH_FORMAT_VERSION,
    organization_id: input.organizationId,
    ledger_sequence: input.ledgerSequence,
    execution_id: input.executionId,
    entry_type: input.entryType,
    request_hash: input.requestHash,
    response_hash: input.responseHash,
    execution_graph_hash: input.executionGraphHash,
    previous_entry_hash: input.previousEntryHash,
    kernel_version: input.kernelVersion ?? KERNEL_VERSION,
    created_at: input.createdAtCanonical,
  };
}

export function computeEntryHash(payload: V2HashPayload): string {
  return sha256Hex(canonicalize(payload));
}
