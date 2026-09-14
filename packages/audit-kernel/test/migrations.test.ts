import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendLedgerEntry } from "../src/ledger/append.js";
import { openExecution } from "../src/execution/executions.js";
import { createPool } from "./helpers/db.js";

const pool = createPool();

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

describe("audit V2 migrations", () => {
  it("creates append-only ledger triggers", async () => {
    const insert = await pool.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'audit.ledger_entries'::regclass
         AND NOT tgisinternal`
    );
    expect(insert.rows.map((r) => r.tgname)).toContain(
      "ledger_entries_reject_update_delete"
    );
  });

  it("rejects UPDATE and DELETE on ledger_entries", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    const row = await appendLedgerEntry(pool, {
      organizationId,
      executionId: execution.id,
      entryType: "request_opened",
      requestHash: "mig",
      responseHash: null,
      executionGraphHash: null,
    });
    await expect(
      pool.query("UPDATE audit.ledger_entries SET kernel_version = kernel_version WHERE id = $1", [
        row.id,
      ])
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM audit.ledger_entries WHERE id = $1", [row.id])
    ).rejects.toThrow(/append-only/);
  });

  it("rejects UPDATE and DELETE on merkle_checkpoints", async () => {
    const organizationId = randomUUID();
    const execution = await openExecution(pool, { organizationId });
    for (let i = 0; i < 2; i++) {
      await appendLedgerEntry(pool, {
        organizationId,
        executionId: execution.id,
        entryType: i === 1 ? "final" : "request_opened",
        requestHash: `mig-${i}`,
        responseHash: null,
        executionGraphHash: null,
        merkleSnapshotInterval: 2,
      });
    }
    const checkpoint = await pool.query<{ id: string }>(
      "SELECT id FROM audit.merkle_checkpoints WHERE organization_id = $1",
      [organizationId]
    );
    expect(checkpoint.rows.length).toBe(1);
    await expect(
      pool.query("UPDATE audit.merkle_checkpoints SET root = root WHERE id = $1", [
        checkpoint.rows[0].id,
      ])
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM audit.merkle_checkpoints WHERE id = $1", [
        checkpoint.rows[0].id,
      ])
    ).rejects.toThrow(/append-only/);
  });

  it("stores both created_at timestamptz and created_at_canonical", async () => {
    const cols = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'audit' AND table_name = 'ledger_entries'
         AND column_name IN ('created_at', 'created_at_canonical')
       ORDER BY column_name`
    );
    expect(cols.rows).toEqual([
      { column_name: "created_at", data_type: "timestamp with time zone" },
      { column_name: "created_at_canonical", data_type: "text" },
    ]);
  });
});
