/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Phase 7: Execution Graph V2 event store.
 * Append-only execution events with organization-scoped composite FKs.
 * Graph schema version is "2" and is independent of hash_format_version.
 */

exports.shorthands = undefined;

const EVENT_TYPES = [
  "execution.created",
  "identity.authenticated",
  "authorization.started",
  "authorization.allowed",
  "authorization.denied",
  "risk.classified",
  "knowledge.retrieval.started",
  "knowledge.retrieval.completed",
  "knowledge.retrieval.insufficient",
  "model.routing.started",
  "model.selected",
  "model.routing.failed",
  "model.execution.started",
  "model.execution.completed",
  "model.execution.failed",
  "nova.skill.started",
  "nova.skill.completed",
  "nova.skill.failed",
  "validation.started",
  "validation.passed",
  "validation.failed",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "tool.requested",
  "tool.authorized",
  "tool.denied",
  "tool.completed",
  "tool.failed",
  "release.started",
  "release.completed",
  "release.blocked",
  "execution.failed",
  "execution.blocked",
  "execution.completed",
  "audit.checkpoint.sealed",
];

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE audit.executions
      ADD CONSTRAINT executions_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE audit.executions
      ADD CONSTRAINT executions_organization_id_record_key UNIQUE (organization_id, verity_record_id)
  `);

  const types = EVENT_TYPES.map((t) => `'${t}'`).join(", ");
  pgm.sql(`
    CREATE TABLE audit.execution_events (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL,
      execution_id UUID NOT NULL,
      event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
      event_type TEXT NOT NULL CHECK (event_type IN (${types})),
      status TEXT NOT NULL,
      parent_event_ids UUID[] NOT NULL DEFAULT '{}',
      input_hash TEXT,
      output_hash TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL,
      occurred_at_canonical TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (execution_id, event_sequence),
      UNIQUE (organization_id, id)
    )
  `);
  pgm.sql(`
    ALTER TABLE audit.execution_events
      ADD CONSTRAINT execution_events_execution_org_fk
      FOREIGN KEY (organization_id, execution_id)
      REFERENCES audit.executions (organization_id, id)
  `);
  pgm.sql(
    "CREATE INDEX execution_events_execution_id_idx ON audit.execution_events (organization_id, execution_id, event_sequence)"
  );

  pgm.sql(`
    CREATE TRIGGER execution_events_reject_update_delete
    BEFORE UPDATE OR DELETE ON audit.execution_events
    FOR EACH ROW EXECUTE FUNCTION audit.reject_append_only()
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP TRIGGER IF EXISTS execution_events_reject_update_delete ON audit.execution_events");
  pgm.sql("DROP TABLE IF EXISTS audit.execution_events");
  pgm.sql("ALTER TABLE audit.executions DROP CONSTRAINT IF EXISTS executions_organization_id_record_key");
  pgm.sql("ALTER TABLE audit.executions DROP CONSTRAINT IF EXISTS executions_organization_id_id_key");
};
