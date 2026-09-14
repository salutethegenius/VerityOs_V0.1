import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  appendLedgerEntry,
  appendLedgerEntryInTransaction,
} from "../src/ledger/append.js";
import { openExecution } from "../src/execution/executions.js";
import { InvalidEvidenceInputError } from "../src/hashing/evidence.js";
import { getLedgerEntries } from "../src/ledger/append.js";
import { createPool } from "./helpers/db.js";
import { contentHash } from "./helpers/evidence.js";

const pool = createPool();

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

describe("appendLedgerEntry transaction contract", () => {
  it("rejects a PoolClient on the public API and requires InTransaction inside BEGIN", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    const client = await pool.connect();
    try {
      await expect(
        appendLedgerEntry(client as unknown as Pool, {
          organizationId,
          executionId: execution.id,
          entryType: "request_opened",
          requestHash: contentHash("api-client"),
          responseHash: null,
          executionGraphHash: null,
        })
      ).rejects.toThrow(/appendLedgerEntryInTransaction/);

      await client.query("BEGIN");
      const row = await appendLedgerEntryInTransaction(client, {
        organizationId,
        executionId: execution.id,
        entryType: "request_opened",
        requestHash: contentHash("api-in-tx"),
        responseHash: null,
        executionGraphHash: null,
      });
      await client.query("COMMIT");
      expect(row.organization_sequence).toBe(1);
      const entries = await getLedgerEntries(pool, organizationId);
      expect(entries).toHaveLength(1);
      expect(entries[0].entry_hash).toBe(row.entry_hash);
    } finally {
      client.release();
    }
  });

  it("rejects invalid evidence before a V2 ledger write", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    await expect(
      appendLedgerEntry(pool, {
        organizationId,
        executionId: execution.id,
        entryType: "request_opened",
        requestHash: "req-1",
        responseHash: null,
        executionGraphHash: null,
      })
    ).rejects.toBeInstanceOf(InvalidEvidenceInputError);

    await expect(
      appendLedgerEntry(pool, {
        organizationId,
        executionId: execution.id,
        entryType: "request_opened",
        requestHash: contentHash("ok"),
        responseHash: null,
        executionGraphHash: null,
        createdAtCanonical: "2026-09-14T20:00:00.123+00:00",
      })
    ).rejects.toBeInstanceOf(InvalidEvidenceInputError);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        appendLedgerEntryInTransaction(client, {
          organizationId,
          executionId: execution.id,
          entryType: "request_opened",
          requestHash: contentHash("ok").toUpperCase(),
          responseHash: null,
          executionGraphHash: null,
        })
      ).rejects.toBeInstanceOf(InvalidEvidenceInputError);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const entries = await getLedgerEntries(pool, organizationId);
    expect(entries).toHaveLength(0);
  });
});
