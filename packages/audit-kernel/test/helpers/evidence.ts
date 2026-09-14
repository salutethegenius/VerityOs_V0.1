import { sha256Hex } from "../../src/hashing/hash.js";

/** Deterministic SHA-256 hex for test evidence. Not a placeholder string. */
export function contentHash(label: string): string {
  return sha256Hex(label);
}
