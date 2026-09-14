import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/hashing/canonicalize.js";
import {
  buildHashPayload,
  computeEntryHash,
  hashContent,
} from "../src/hashing/hash.js";
import * as v1 from "../src/v1/ledger/hash.js";

const baseV1 = {
  verityAuditId: "11111111-1111-1111-1111-111111111111",
  requestHash: "r",
  responseHash: "s",
  executionGraphHash: "g",
  modelId: "gpt-4o-mini",
  modelProvider: "openai",
  riskTier: "low",
  kernelVersion: "0.1.0",
  createdAt: "2026-02-27T00:00:00.000Z",
};

describe("V1 hash characterization", () => {
  it("is deterministic for the concatenation payload", () => {
    const a = v1.computeEntryHash({ ...baseV1, previousEntryHash: "abc" });
    const b = v1.computeEntryHash({ ...baseV1, previousEntryHash: "abc" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats null previous hash as an empty string (known V1 defect)", () => {
    const fromNull = v1.computeEntryHash({ ...baseV1, previousEntryHash: null });
    const fromEmpty = v1.computeEntryHash({ ...baseV1, previousEntryHash: "" });
    expect(fromNull).toBe(fromEmpty);
  });

  it("changes when any concatenated field changes", () => {
    const original = v1.computeEntryHash({ ...baseV1, previousEntryHash: null });
    const changed = v1.computeEntryHash({
      ...baseV1,
      previousEntryHash: null,
      requestHash: "r2",
    });
    expect(changed).not.toBe(original);
  });
});

describe("V2 canonical hashing", () => {
  const payload = buildHashPayload({
    organizationId: "22222222-2222-2222-2222-222222222222",
    ledgerSequence: 1,
    executionId: "33333333-3333-3333-3333-333333333333",
    entryType: "request_opened",
    requestHash: "aa",
    responseHash: null,
    executionGraphHash: null,
    previousEntryHash: null,
    createdAtCanonical: "2026-09-14T20:00:00.000Z",
  });

  it("emits RFC 8785 key order and JSON null for missing hashes", () => {
    const json = canonicalize(payload);
    expect(json).toContain('"request_hash":"aa"');
    expect(json).toContain('"response_hash":null');
    expect(json).toContain('"execution_graph_hash":null');
    expect(json).toContain('"previous_entry_hash":null');
    expect(json.startsWith("{")).toBe(true);
    const keys = [...json.matchAll(/"([^"]+)":/g)].map((m) => m[1]);
    const objectKeys = keys.filter((k) =>
      [
        "created_at",
        "entry_type",
        "execution_graph_hash",
        "execution_id",
        "hash_format_version",
        "kernel_version",
        "ledger_sequence",
        "organization_id",
        "previous_entry_hash",
        "request_hash",
        "response_hash",
      ].includes(k)
    );
    expect(objectKeys).toEqual([...objectKeys].sort((a, b) => (a < b ? -1 : 1)));
  });

  it("never omits hash fields on checkpoint-style payloads", () => {
    expect(Object.keys(payload).sort()).toEqual(
      [
        "created_at",
        "entry_type",
        "execution_graph_hash",
        "execution_id",
        "hash_format_version",
        "kernel_version",
        "ledger_sequence",
        "organization_id",
        "previous_entry_hash",
        "request_hash",
        "response_hash",
      ].sort()
    );
    expect(payload.response_hash).toBeNull();
    expect(payload.execution_graph_hash).toBeNull();
  });

  it("is deterministic and does not treat null as empty string", () => {
    const a = computeEntryHash(payload);
    const b = computeEntryHash({ ...payload });
    expect(a).toBe(b);
    const withEmpty = canonicalize({ ...payload, response_hash: "" });
    const withNull = canonicalize(payload);
    expect(withEmpty).not.toBe(withNull);
    expect(hashContent(withNull)).toBe(a);
  });

  it("hashes the canonical timestamp string, not a Date reconstruction", () => {
    const canonical = "2026-09-14T20:00:00.000Z";
    const hashed = computeEntryHash(
      buildHashPayload({
        organizationId: payload.organization_id,
        ledgerSequence: 1,
        executionId: payload.execution_id,
        entryType: "final",
        requestHash: "aa",
        responseHash: "bb",
        executionGraphHash: "cc",
        previousEntryHash: null,
        createdAtCanonical: canonical,
      })
    );
    const viaDate = new Date(canonical);
    expect(viaDate.toISOString()).toBe(canonical);
    const rebuilt = buildHashPayload({
      organizationId: payload.organization_id,
      ledgerSequence: 1,
      executionId: payload.execution_id,
      entryType: "final",
      requestHash: "aa",
      responseHash: "bb",
      executionGraphHash: "cc",
      previousEntryHash: null,
      createdAtCanonical: canonical,
    });
    expect(computeEntryHash(rebuilt)).toBe(hashed);
    expect(rebuilt.created_at).toBe(canonical);
  });
});
