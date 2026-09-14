import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendLedgerEntry as appendV1 } from "../src/v1/ledger/append.js";
import { appendLedgerEntry } from "../src/ledger/append.js";
import { openExecution } from "../src/execution/executions.js";
import { getLedgerEntries } from "../src/ledger/append.js";
import { createPool, ensureV1LedgerTable, truncateV1 } from "./helpers/db.js";

const pool = createPool();

beforeAll(async () => {
  await pool.query("SELECT 1");
  await ensureV1LedgerTable(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("V1 concurrent append characterization", () => {
  it("forks when two writers interleave SELECT and INSERT", async () => {
    await truncateV1(pool);
    let release: (() => void) | undefined;
    const bothHaveRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const yieldAfterRead = async () => {
      reads += 1;
      if (reads === 2) {
        release?.();
      }
      await bothHaveRead;
    };

    await Promise.all([
      appendV1(pool, {
        requestHash: "r1",
        responseHash: "s1",
        executionGraphHash: "g1",
        modelId: "m",
        modelProvider: "p",
        riskTier: "low",
        kernelVersion: "0.1.0",
        yieldAfterRead,
      }),
      appendV1(pool, {
        requestHash: "r2",
        responseHash: "s2",
        executionGraphHash: "g2",
        modelId: "m",
        modelProvider: "p",
        riskTier: "low",
        kernelVersion: "0.1.0",
        yieldAfterRead,
      }),
    ]);

    const rows = await pool.query<{ previous_entry_hash: string | null }>(
      "SELECT previous_entry_hash FROM audit_ledger_v1"
    );
    const nullPrevious = rows.rows.filter((r) => r.previous_entry_hash === null);
    expect(nullPrevious).toHaveLength(2);
  });
});

describe("V2 transactional append (converted V1 expected failures)", () => {
  it("cannot fork two simultaneous first-ever appends for a new organization", async () => {
    const organizationId = randomUUID();
    const execA = await openExecution(pool, { organizationId });
    const execB = await openExecution(pool, { organizationId });

    await Promise.all([
      appendLedgerEntry(pool, {
        organizationId,
        executionId: execA.id,
        entryType: "request_opened",
        requestHash: "a",
        responseHash: null,
        executionGraphHash: null,
      }),
      appendLedgerEntry(pool, {
        organizationId,
        executionId: execB.id,
        entryType: "request_opened",
        requestHash: "b",
        responseHash: null,
        executionGraphHash: null,
      }),
    ]);

    const entries = await getLedgerEntries(pool, organizationId);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.organization_sequence)).toEqual([1, 2]);
    expect(entries[0].previous_entry_hash).toBeNull();
    expect(entries[1].previous_entry_hash).toBe(entries[0].entry_hash);
    expect(new Set(entries.map((e) => e.entry_hash)).size).toBe(2);
  });

  it("cannot fork two simultaneous appends on an existing chain", async () => {
    const organizationId = randomUUID();
    const firstExec = await openExecution(pool, { organizationId });
    await appendLedgerEntry(pool, {
      organizationId,
      executionId: firstExec.id,
      entryType: "request_opened",
      requestHash: "seed",
      responseHash: null,
      executionGraphHash: null,
    });

    const execA = await openExecution(pool, { organizationId });
    const execB = await openExecution(pool, { organizationId });
    await Promise.all([
      appendLedgerEntry(pool, {
        organizationId,
        executionId: execA.id,
        entryType: "request_opened",
        requestHash: "c",
        responseHash: null,
        executionGraphHash: null,
      }),
      appendLedgerEntry(pool, {
        organizationId,
        executionId: execB.id,
        entryType: "request_opened",
        requestHash: "d",
        responseHash: null,
        executionGraphHash: null,
      }),
    ]);

    const entries = await getLedgerEntries(pool, organizationId);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.organization_sequence)).toEqual([1, 2, 3]);
    expect(entries[1].previous_entry_hash).toBe(entries[0].entry_hash);
    expect(entries[2].previous_entry_hash).toBe(entries[1].entry_hash);
  });

  it("isolates organization chains", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const execA = await openExecution(pool, { organizationId: orgA });
    const execB = await openExecution(pool, { organizationId: orgB });
    await Promise.all([
      appendLedgerEntry(pool, {
        organizationId: orgA,
        executionId: execA.id,
        entryType: "request_opened",
        requestHash: "org-a",
        responseHash: null,
        executionGraphHash: null,
      }),
      appendLedgerEntry(pool, {
        organizationId: orgB,
        executionId: execB.id,
        entryType: "request_opened",
        requestHash: "org-b",
        responseHash: null,
        executionGraphHash: null,
      }),
    ]);
    const a = await getLedgerEntries(pool, orgA);
    const b = await getLedgerEntries(pool, orgB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].organization_sequence).toBe(1);
    expect(b[0].organization_sequence).toBe(1);
    expect(a[0].entry_hash).not.toBe(b[0].entry_hash);
  });
});
