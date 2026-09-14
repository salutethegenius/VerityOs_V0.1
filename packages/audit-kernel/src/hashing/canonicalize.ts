/**
 * Verity Canonical Hash Format V2 (VCHF-2).
 *
 * This is the frozen canonicalization used when `hash_format_version` is `"2"`.
 * It is a restricted JSON Canonicalization Scheme (RFC 8785 / JCS) domain, not
 * a complete general-purpose RFC 8785 implementation.
 *
 * Do not change the output of this function for values inside the V2 domain
 * without incrementing `hash_format_version`.
 *
 * Domain (accepted values):
 * - JSON null
 * - JSON boolean
 * - finite safe integers (`Number.isSafeInteger`)
 * - JSON strings
 * - arrays of domain values
 * - objects whose values are domain values
 *
 * Rejected (throw):
 * - undefined, bigint, symbol, function
 * - NaN, Infinity, non-integers, non-safe integers
 * - class instances are treated as plain objects via enumerable keys
 *
 * Serialization rules for accepted values match RFC 8785 JCS for this domain:
 * - no insignificant whitespace
 * - object keys sorted by UTF-16 code unit order
 * - integers as JSON numbers without a decimal or exponent
 * - strings via ECMA-262 `JSON.stringify` (sufficient for the V2 payload
 *   alphabet: UUIDs, lowercase hex, ASCII identifiers, ISO-8601 UTC stamps)
 *
 * V2 ledger payloads never contain floating-point numbers. Official RFC 8785
 * number vectors that include floats, NaN, Infinity, or 2^53
 * (`9007199254740992`, Appendix B "Max pos int") are out of domain.
 */
export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("VCHF-2 only accepts finite safe integers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encode).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key])}`)
      .join(",");
    return `{${body}}`;
  }
  throw new Error(`unsupported VCHF-2 type: ${typeof value}`);
}
