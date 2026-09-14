/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql("CREATE SCHEMA IF NOT EXISTS audit");
  pgm.sql("CREATE SCHEMA IF NOT EXISTS system");

  pgm.sql(`
    CREATE TABLE audit.chain_state (
      organization_id UUID PRIMARY KEY,
      latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
      latest_entry_hash TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  pgm.sql(`
    CREATE TABLE audit.executions (
      id UUID PRIMARY KEY,
      verity_record_id TEXT NOT NULL UNIQUE,
      organization_id UUID NOT NULL,
      actor_id UUID,
      session_id UUID,
      skill_id TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'created', 'running', 'waiting_approval', 'completed', 'failed', 'blocked', 'cancelled'
      )),
      risk_tier TEXT NOT NULL CHECK (risk_tier IN ('low', 'medium', 'high')),
      policy_version TEXT,
      retention_mode TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      final_entry_id UUID
    )
  `);
  pgm.sql("CREATE INDEX executions_organization_id_idx ON audit.executions (organization_id)");

  pgm.sql(`
    CREATE TABLE audit.ledger_entries (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL,
      organization_sequence INTEGER NOT NULL CHECK (organization_sequence > 0),
      execution_id UUID NOT NULL REFERENCES audit.executions (id),
      entry_type TEXT NOT NULL CHECK (entry_type IN (
        'request_opened', 'approval_requested', 'action_completed', 'final', 'failure'
      )),
      request_hash TEXT,
      response_hash TEXT,
      execution_graph_hash TEXT,
      previous_entry_hash TEXT,
      entry_hash TEXT NOT NULL,
      merkle_root TEXT,
      kernel_version TEXT NOT NULL,
      hash_format_version TEXT NOT NULL CHECK (hash_format_version = '2'),
      created_at TIMESTAMPTZ NOT NULL,
      created_at_canonical TEXT NOT NULL,
      UNIQUE (organization_id, organization_sequence),
      UNIQUE (entry_hash)
    )
  `);
  pgm.sql(
    "CREATE INDEX ledger_entries_execution_id_idx ON audit.ledger_entries (execution_id)"
  );
  pgm.sql(
    "CREATE INDEX ledger_entries_organization_id_created_at_idx ON audit.ledger_entries (organization_id, created_at)"
  );

  pgm.sql(`
    ALTER TABLE audit.executions
      ADD CONSTRAINT executions_final_entry_fk
      FOREIGN KEY (final_entry_id) REFERENCES audit.ledger_entries (id)
  `);

  pgm.sql(`
    CREATE TABLE audit.merkle_checkpoints (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL,
      from_sequence INTEGER NOT NULL,
      through_sequence INTEGER NOT NULL,
      root TEXT NOT NULL,
      leaf_hashes JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (organization_id, through_sequence)
    )
  `);

  pgm.sql(`
    CREATE FUNCTION audit.reject_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only: UPDATE and DELETE are not allowed', TG_TABLE_NAME;
    END;
    $$
  `);

  pgm.sql(`
    CREATE TRIGGER ledger_entries_reject_update_delete
    BEFORE UPDATE OR DELETE ON audit.ledger_entries
    FOR EACH ROW EXECUTE FUNCTION audit.reject_append_only()
  `);

  pgm.sql(`
    CREATE TRIGGER merkle_checkpoints_reject_update_delete
    BEFORE UPDATE OR DELETE ON audit.merkle_checkpoints
    FOR EACH ROW EXECUTE FUNCTION audit.reject_append_only()
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP TRIGGER IF EXISTS merkle_checkpoints_reject_update_delete ON audit.merkle_checkpoints");
  pgm.sql("DROP TRIGGER IF EXISTS ledger_entries_reject_update_delete ON audit.ledger_entries");
  pgm.sql("DROP FUNCTION IF EXISTS audit.reject_append_only()");
  pgm.sql("ALTER TABLE audit.executions DROP CONSTRAINT IF EXISTS executions_final_entry_fk");
  pgm.sql("DROP TABLE IF EXISTS audit.merkle_checkpoints");
  pgm.sql("DROP TABLE IF EXISTS audit.ledger_entries");
  pgm.sql("DROP TABLE IF EXISTS audit.executions");
  pgm.sql("DROP TABLE IF EXISTS audit.chain_state");
};
