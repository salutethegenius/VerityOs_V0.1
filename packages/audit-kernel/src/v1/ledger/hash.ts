/**
 * V1 characterization copy from
 * salutethegenius/VerityOS-Sovereign-Audit-Kernel@a18419c66002648224f3def6291b7ed2caa90997
 * Do not use for new ledger writes.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

export function sha256Hex(input: string): string {
  const bytes = sha256(new TextEncoder().encode(input));
  return bytesToHex(bytes);
}

export interface ChainInput {
  verityAuditId: string;
  requestHash: string;
  responseHash: string;
  executionGraphHash: string;
  modelId: string;
  modelProvider: string;
  riskTier: string;
  kernelVersion: string;
  previousEntryHash: string | null;
  createdAt: string;
}

export function computeEntryHash(input: ChainInput): string {
  const payload =
    input.verityAuditId +
    input.requestHash +
    input.responseHash +
    input.executionGraphHash +
    input.modelId +
    input.modelProvider +
    input.riskTier +
    input.kernelVersion +
    (input.previousEntryHash ?? "") +
    input.createdAt;
  return sha256Hex(payload);
}

export function hashContent(content: string): string {
  return sha256Hex(content);
}

export { bytesToHex } from "@noble/hashes/utils";
export { hexToBytes } from "@noble/hashes/utils";
