import { randomUUID } from "crypto";
import pg, { type Pool, type PoolClient } from "pg";
import type { LedgerEntryType } from "@verityos/contracts";
import {
  HASH_FORMAT_VERSION,
  KERNEL_VERSION,
  buildHashPayload,
  canonicalTimestampNow,
  computeEntryHash,
} from "../hashing/hash.js";
import {
  assertCanonicalUtcTimestamp,
  assertLedgerHashFields,
  assertSha256Hex,
} from "../hashing/evidence.js";
import { computeMerkleRoot, getMerkleProof } from "../merkle/merkle.js";
import type { LedgerEntryRow, MerkleCheckpointRow } from "../types.js";
import { setExecutionStatus } from "../execution/executions.js";

export const DEFAULT_MERKLE_INTERVAL = Number.parseInt(
  process.env.AUDIT_MERKLE_INTERVAL ?? "10",
  10
);

export interface AppendLedgerInput {
  organizationId: string;
  executionId: string;
  entryType: LedgerEntryType;
  requestHash: string | null;
  responseHash: string | null;
  executionGraphHash: string | null;
  merkleSnapshotInterval?: number;
  createdAtCanonical?: string;
  kernelVersion?: string;
}

function assertIsPool(db: unknown): asserts db is Pool {
  if (!(db instanceof pg.Pool)) {
    throw new Error(
      "appendLedgerEntry requires a Pool and always opens its own transaction. Use appendLedgerEntryInTransaction(client, ...) if you are already inside a transaction."
    );
  }
}

/**
 * Append a ledger entry. Always opens BEGIN/COMMIT/ROLLBACK on a Pool.
 * A PoolClient is rejected at runtime — callers already inside a transaction
 * must use appendLedgerEntryInTransaction.
 */
export async function appendLedgerEntry(
  pool: Pool,
  input: AppendLedgerInput
): Promise<LedgerEntryRow> {
  assertIsPool(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await appendLedgerEntryInTransaction(client, input);
    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Append a ledger entry using a client that is already inside an explicit
 * transaction. Does not open or close BEGIN/COMMIT/ROLLBACK.
 */
export async function appendLedgerEntryInTransaction(
  client: PoolClient,
  input: AppendLedgerInput
): Promise<LedgerEntryRow> {
  assertLedgerHashFields(input);
  const createdAtCanonical = input.createdAtCanonical ?? canonicalTimestampNow();
  assertCanonicalUtcTimestamp("created_at_canonical", createdAtCanonical);

  await client.query(
    `INSERT INTO audit.chain_state (organization_id, latest_sequence, latest_entry_hash, updated_at)
     VALUES ($1, 0, NULL, now())
     ON CONFLICT (organization_id) DO NOTHING`,
    [input.organizationId]
  );

  const state = await client.query<{
    latest_sequence: number;
    latest_entry_hash: string | null;
  }>(
    `SELECT latest_sequence, latest_entry_hash
     FROM audit.chain_state
     WHERE organization_id = $1
     FOR UPDATE`,
    [input.organizationId]
  );

  const locked = state.rows[0];
  if (!locked) {
    throw new Error(`chain_state missing for organization ${input.organizationId}`);
  }

  const nextSequence = locked.latest_sequence + 1;
  const previousEntryHash = locked.latest_entry_hash;
  assertSha256Hex("previous_entry_hash", previousEntryHash);
  const kernelVersion = input.kernelVersion ?? KERNEL_VERSION;

  const payload = buildHashPayload({
    organizationId: input.organizationId,
    ledgerSequence: nextSequence,
    executionId: input.executionId,
    entryType: input.entryType,
    requestHash: input.requestHash,
    responseHash: input.responseHash,
    executionGraphHash: input.executionGraphHash,
    previousEntryHash,
    kernelVersion,
    createdAtCanonical,
  });
  const entryHash = computeEntryHash(payload);
  assertSha256Hex("entry_hash", entryHash);
  const id = randomUUID();

  const interval = input.merkleSnapshotInterval ?? DEFAULT_MERKLE_INTERVAL;
  let merkleRoot: string | null = null;
  let checkpointLeaves: string[] | null = null;
  let fromSequence: number | null = null;

  if (interval > 0 && nextSequence % interval === 0) {
    fromSequence = nextSequence - interval + 1;
    const prior = await client.query<{ entry_hash: string }>(
      `SELECT entry_hash
       FROM audit.ledger_entries
       WHERE organization_id = $1
         AND organization_sequence >= $2
         AND organization_sequence < $3
       ORDER BY organization_sequence ASC`,
      [input.organizationId, fromSequence, nextSequence]
    );
    checkpointLeaves = [...prior.rows.map((r) => r.entry_hash), entryHash];
    merkleRoot = computeMerkleRoot(checkpointLeaves);
    assertSha256Hex("merkle_root", merkleRoot);
  }

  const inserted = await client.query<LedgerEntryRow>(
    `INSERT INTO audit.ledger_entries (
       id, organization_id, organization_sequence, execution_id, entry_type,
       request_hash, response_hash, execution_graph_hash, previous_entry_hash,
       entry_hash, merkle_root, kernel_version, hash_format_version,
       created_at, created_at_canonical
     ) VALUES (
       $1,$2,$3,$4,$5,
       $6,$7,$8,$9,
       $10,$11,$12,$13,
       $14::timestamptz, $15
     )
     RETURNING *`,
    [
      id,
      input.organizationId,
      nextSequence,
      input.executionId,
      input.entryType,
      input.requestHash,
      input.responseHash,
      input.executionGraphHash,
      previousEntryHash,
      entryHash,
      merkleRoot,
      kernelVersion,
      HASH_FORMAT_VERSION,
      createdAtCanonical,
      createdAtCanonical,
    ]
  );

  const row = inserted.rows[0];

  await client.query(
    `UPDATE audit.chain_state
     SET latest_sequence = $2,
         latest_entry_hash = $3,
         updated_at = now()
     WHERE organization_id = $1`,
    [input.organizationId, nextSequence, entryHash]
  );

  if (merkleRoot && checkpointLeaves && fromSequence != null) {
    await client.query(
      `INSERT INTO audit.merkle_checkpoints (
         id, organization_id, from_sequence, through_sequence, root, leaf_hashes, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb, $7::timestamptz)`,
      [
        randomUUID(),
        input.organizationId,
        fromSequence,
        nextSequence,
        merkleRoot,
        JSON.stringify(checkpointLeaves),
        createdAtCanonical,
      ]
    );
  }

  if (input.entryType === "request_opened") {
    await setExecutionStatus(client, input.executionId, "running");
  } else if (input.entryType === "approval_requested") {
    await setExecutionStatus(client, input.executionId, "waiting_approval");
  } else if (input.entryType === "final") {
    await setExecutionStatus(client, input.executionId, "completed", {
      finalEntryId: row.id,
      completedAt: new Date(createdAtCanonical),
    });
  } else if (input.entryType === "failure") {
    await setExecutionStatus(client, input.executionId, "failed", {
      finalEntryId: row.id,
      completedAt: new Date(createdAtCanonical),
    });
  }

  return row;
}

export async function getLedgerEntries(
  pool: Pool,
  organizationId: string
): Promise<LedgerEntryRow[]> {
  const result = await pool.query<LedgerEntryRow>(
    `SELECT * FROM audit.ledger_entries
     WHERE organization_id = $1
     ORDER BY organization_sequence ASC`,
    [organizationId]
  );
  return result.rows;
}

export async function getMerkleCheckpoints(
  pool: Pool,
  organizationId: string
): Promise<MerkleCheckpointRow[]> {
  const result = await pool.query<MerkleCheckpointRow>(
    `SELECT id, organization_id, from_sequence, through_sequence, root, leaf_hashes, created_at
     FROM audit.merkle_checkpoints
     WHERE organization_id = $1
     ORDER BY through_sequence ASC`,
    [organizationId]
  );
  return result.rows.map((row) => ({
    ...row,
    leaf_hashes: Array.isArray(row.leaf_hashes)
      ? row.leaf_hashes
      : (JSON.parse(String(row.leaf_hashes)) as string[]),
  }));
}

export function proofForLeaf(
  leafHashes: string[],
  leafHash: string
): ReturnType<typeof getMerkleProof> {
  const index = leafHashes.indexOf(leafHash);
  if (index < 0) {
    throw new Error("leaf not present in checkpoint");
  }
  return getMerkleProof(leafHashes, index);
}
