import { describe, expect, it } from "vitest";
import {
  InvalidEvidenceInputError,
  assertCanonicalUtcTimestamp,
  assertLedgerHashFields,
  assertSha256Hex,
} from "../src/hashing/evidence.js";
import { sha256Hex } from "../src/hashing/hash.js";

const valid = sha256Hex("fixture");

describe("Hash Format V2 evidence input validation", () => {
  it("accepts lowercase 64-character SHA-256 hex and JSON null", () => {
    expect(valid).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertSha256Hex("request_hash", valid)).not.toThrow();
    expect(() => assertSha256Hex("request_hash", null)).not.toThrow();
    expect(() =>
      assertLedgerHashFields({
        requestHash: valid,
        responseHash: null,
        executionGraphHash: null,
      })
    ).not.toThrow();
  });

  it("rejects placeholders, uppercase hex, and wrong lengths", () => {
    expect(() => assertSha256Hex("request_hash", "req-1")).toThrow(
      InvalidEvidenceInputError
    );
    expect(() => assertSha256Hex("request_hash", valid.toUpperCase())).toThrow(
      InvalidEvidenceInputError
    );
    expect(() => assertSha256Hex("request_hash", valid.slice(0, 63))).toThrow(
      InvalidEvidenceInputError
    );
    expect(() => assertSha256Hex("request_hash", `${valid}aa`)).toThrow(
      InvalidEvidenceInputError
    );
    expect(() => assertSha256Hex("request_hash", "")).toThrow(
      InvalidEvidenceInputError
    );
  });

  it("accepts Date#toISOString UTC form and rejects other timestamp encodings", () => {
    expect(() =>
      assertCanonicalUtcTimestamp("created_at_canonical", "2026-09-14T20:00:00.123Z")
    ).not.toThrow();
    expect(() =>
      assertCanonicalUtcTimestamp("created_at_canonical", "2026-09-14 20:00:00.123+00")
    ).toThrow(InvalidEvidenceInputError);
    expect(() =>
      assertCanonicalUtcTimestamp("created_at_canonical", "2026-09-14T20:00:00.123+00:00")
    ).toThrow(InvalidEvidenceInputError);
    expect(() =>
      assertCanonicalUtcTimestamp("created_at_canonical", "2026-09-14T20:00:00Z")
    ).toThrow(InvalidEvidenceInputError);
    expect(() =>
      assertCanonicalUtcTimestamp("created_at_canonical", "2026-02-31T00:00:00.000Z")
    ).toThrow(InvalidEvidenceInputError);
  });
});
