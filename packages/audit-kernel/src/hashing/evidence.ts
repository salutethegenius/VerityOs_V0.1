/**
 * Validation for Hash Format V2 evidence inputs.
 * Invalid values must be rejected before a ledger append.
 */

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Exact created_at representation hashed by Hash Format V2:
 * ES2022 Date#toISOString — UTC, year-month-day, `T`, hour:minute:second,
 * three millisecond digits, `Z`. No `+00:00`, no space separator, no omitted
 * milliseconds.
 */
export const CANONICAL_UTC_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export class InvalidEvidenceInputError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "InvalidEvidenceInputError";
    this.field = field;
  }
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}

export function assertSha256Hex(field: string, value: string | null): void {
  if (value === null) {
    return;
  }
  if (typeof value !== "string" || !isSha256Hex(value)) {
    throw new InvalidEvidenceInputError(
      field,
      `${field} must be a lowercase 64-character SHA-256 hex string or JSON null`
    );
  }
}

/**
 * Accepts the hashed timestamp string only if it already is the V2 canonical
 * form. Date is used as a calendar check that the string is that form, not as
 * a value that gets re-serialized into the hash.
 */
export function assertCanonicalUtcTimestamp(field: string, value: string): void {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new InvalidEvidenceInputError(
      field,
      `${field} must be UTC YYYY-MM-DDTHH:mm:ss.sssZ (Date#toISOString form)`
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new InvalidEvidenceInputError(
      field,
      `${field} is not a valid V2 canonical UTC timestamp`
    );
  }
}

export function assertLedgerHashFields(input: {
  requestHash: string | null;
  responseHash: string | null;
  executionGraphHash: string | null;
  previousEntryHash?: string | null;
}): void {
  assertSha256Hex("request_hash", input.requestHash);
  assertSha256Hex("response_hash", input.responseHash);
  assertSha256Hex("execution_graph_hash", input.executionGraphHash);
  if (input.previousEntryHash !== undefined) {
    assertSha256Hex("previous_entry_hash", input.previousEntryHash);
  }
}
