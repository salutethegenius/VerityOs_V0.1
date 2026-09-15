/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Phase 9: Connector Gateway action ledger, skill-connector bindings, and
 * Meta-oriented connector configuration. Does not copy Content-Loop data or secrets.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE command.connectors
      ADD COLUMN IF NOT EXISTS connector_type TEXT,
      ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '1.0.0',
      ADD COLUMN IF NOT EXISTS secret_ref TEXT,
      ADD COLUMN IF NOT EXISTS page_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT true
  `);
  pgm.sql(`
    UPDATE command.connectors
    SET connector_type = connector_key
    WHERE connector_type IS NULL
  `);
  pgm.sql(`
    ALTER TABLE command.connectors
      ALTER COLUMN connector_type SET NOT NULL
  `);
  pgm.sql(`
    ALTER TABLE command.connectors
      ADD CONSTRAINT connectors_organization_id_id_key UNIQUE (organization_id, id)
  `);

  pgm.sql(`
    CREATE TABLE command.skill_connectors (
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      skill_id TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, skill_id, connector_key)
    )
  `);

  pgm.sql(`
    CREATE TABLE command.connector_actions (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      execution_id UUID NOT NULL,
      connector_id UUID NOT NULL,
      action TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'authorized', 'executing', 'succeeded', 'failed', 'needs_review'
      )),
      external_action_id TEXT,
      request_hash TEXT,
      response_hash TEXT,
      requested_by UUID NOT NULL REFERENCES auth.users (id),
      approved_by UUID REFERENCES auth.users (id),
      error_code TEXT,
      scheduled_for TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      UNIQUE (organization_id, idempotency_key),
      FOREIGN KEY (organization_id, execution_id)
        REFERENCES audit.executions (organization_id, id),
      FOREIGN KEY (organization_id, connector_id)
        REFERENCES command.connectors (organization_id, id)
    )
  `);
  pgm.sql(
    "CREATE INDEX connector_actions_execution_idx ON command.connector_actions (organization_id, execution_id)"
  );

  pgm.sql(`
    ALTER TABLE social.content_items
      ADD COLUMN IF NOT EXISTS connector_action_id UUID,
      ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS external_action_id TEXT
  `);
  pgm.sql(`
    ALTER TABLE social.content_items
      ADD CONSTRAINT social_content_items_connector_action_fk
      FOREIGN KEY (connector_action_id)
      REFERENCES command.connector_actions (id)
  `);
};

exports.down = (pgm) => {
  pgm.sql("ALTER TABLE social.content_items DROP CONSTRAINT IF EXISTS social_content_items_connector_action_fk");
  pgm.sql("ALTER TABLE social.content_items DROP COLUMN IF EXISTS connector_action_id");
  pgm.sql("ALTER TABLE social.content_items DROP COLUMN IF EXISTS scheduled_for");
  pgm.sql("ALTER TABLE social.content_items DROP COLUMN IF EXISTS external_action_id");
  pgm.sql("DROP TABLE IF EXISTS command.connector_actions");
  pgm.sql("DROP TABLE IF EXISTS command.skill_connectors");
  pgm.sql("ALTER TABLE command.connectors DROP CONSTRAINT IF EXISTS connectors_organization_id_id_key");
  pgm.sql("ALTER TABLE command.connectors DROP COLUMN IF EXISTS requires_approval");
  pgm.sql("ALTER TABLE command.connectors DROP COLUMN IF EXISTS capabilities");
  pgm.sql("ALTER TABLE command.connectors DROP COLUMN IF EXISTS page_config");
  pgm.sql("ALTER TABLE command.connectors DROP COLUMN IF EXISTS secret_ref");
  pgm.sql("ALTER TABLE command.connectors DROP COLUMN IF EXISTS version");
  pgm.sql("ALTER TABLE command.connectors DROP COLUMN IF EXISTS connector_type");
};
