import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/hashing/canonicalize.js";
import {
  buildHashPayload,
  computeEntryHash,
  sha256Hex,
} from "../src/hashing/hash.js";

describe("VCHF-2 domain (restricted RFC 8785 / JCS)", () => {
  it("matches RFC 8785 §3.2.2 literals", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize([null, true, false])).toBe("[null,true,false]");
    expect(canonicalize({ literals: [null, true, false] })).toBe(
      '{"literals":[null,true,false]}'
    );
  });

  it("matches RFC 8785 Appendix B integer samples that are in domain", () => {
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(1)).toBe("1");
    expect(canonicalize(-1)).toBe("-1");
    expect(canonicalize(9007199254740991)).toBe("9007199254740991");
  });

  it("matches RFC 8785 §3.2.3 UTF-16 property-name sort order", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    const keys = Object.keys(input).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(keys.map((k) => input[k as keyof typeof input])).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
    expect(canonicalize(input)).toBe(
      `{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}`
    );
  });

  it("rejects RFC 8785 Appendix B values that are outside the V2 domain", () => {
    expect(() => canonicalize(1.5)).toThrow(/safe integers/);
    expect(() => canonicalize(0.002)).toThrow(/safe integers/);
    expect(() => canonicalize(Number.NaN)).toThrow(/safe integers/);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/safe integers/);
    expect(() => canonicalize(9007199254740992)).toThrow(/safe integers/);
    expect(() => canonicalize(2 ** 53)).toThrow(/safe integers/);
  });

  it("rejects undefined", () => {
    expect(() => canonicalize(undefined)).toThrow(/unsupported VCHF-2 type/);
  });
});

describe("frozen V2 ledger payload vector", () => {
  it("hashes the documented 11-key payload with JSON null hashes", () => {
    const requestHash = sha256Hex("aa");
    expect(requestHash).toBe(
      "961b6dd3ede3cb8ecbaacbd68de040cd78eb2ed5889130cceb4c49268ea4d506"
    );
    const payload = buildHashPayload({
      organizationId: "22222222-2222-2222-2222-222222222222",
      ledgerSequence: 1,
      executionId: "33333333-3333-3333-3333-333333333333",
      entryType: "request_opened",
      requestHash,
      responseHash: null,
      executionGraphHash: null,
      previousEntryHash: null,
      createdAtCanonical: "2026-09-14T20:00:00.000Z",
    });
    const json = canonicalize(payload);
    expect(json).toBe(
      '{"created_at":"2026-09-14T20:00:00.000Z","entry_type":"request_opened","execution_graph_hash":null,"execution_id":"33333333-3333-3333-3333-333333333333","hash_format_version":"2","kernel_version":"0.2.0","ledger_sequence":1,"organization_id":"22222222-2222-2222-2222-222222222222","previous_entry_hash":null,"request_hash":"961b6dd3ede3cb8ecbaacbd68de040cd78eb2ed5889130cceb4c49268ea4d506","response_hash":null}'
    );
    expect(computeEntryHash(payload)).toBe(
      "dd865a13890abb157cfce6a25db436eff5dfb0e21098e1ee2cd31a3e7fb2ac9f"
    );
  });
});
