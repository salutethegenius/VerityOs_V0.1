import pg from "pg";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://verityos:verityos@127.0.0.1:5432/verityos_audit";

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 10 });
}

export async function ensureV1LedgerTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_ledger_v1 (
      id UUID PRIMARY KEY,
      verity_audit_id UUID NOT NULL,
      request_hash TEXT NOT NULL,
      response_hash TEXT NOT NULL,
      execution_graph_hash TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      risk_tier TEXT NOT NULL,
      kernel_version TEXT NOT NULL,
      previous_entry_hash TEXT,
      entry_hash TEXT NOT NULL,
      merkle_root TEXT,
      created_at TIMESTAMP NOT NULL
    )
  `);
}

export async function truncateV1(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE audit_ledger_v1");
}
