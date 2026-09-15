/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Phase 8: Nova operator tables, social state, and approval artifact binding.
 * Does not migrate production Content-Loop data.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql("INSERT INTO auth.permissions (key) VALUES ('social.draft') ON CONFLICT DO NOTHING");

  pgm.sql("ALTER TABLE command.approvals ADD COLUMN IF NOT EXISTS artifact_hash TEXT");

  pgm.sql("CREATE SCHEMA IF NOT EXISTS nova");
  pgm.sql("CREATE SCHEMA IF NOT EXISTS social");

  pgm.sql(`
    CREATE TABLE nova.external_identities (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      provider TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      verity_user_id UUID NOT NULL REFERENCES auth.users (id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, provider, external_user_id)
    )
  `);
  pgm.sql(
    "CREATE INDEX nova_external_identities_org_idx ON nova.external_identities (organization_id)"
  );

  pgm.sql(`
    CREATE TABLE nova.skill_runs (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      execution_id UUID NOT NULL,
      skill_id TEXT NOT NULL,
      skill_version TEXT NOT NULL,
      actor_id UUID NOT NULL REFERENCES auth.users (id),
      status TEXT NOT NULL,
      config_hash TEXT,
      artifact_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  pgm.sql("CREATE INDEX nova_skill_runs_execution_idx ON nova.skill_runs (organization_id, execution_id)");

  pgm.sql(`
    CREATE TABLE social.brands (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      brand_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      voice_md TEXT NOT NULL DEFAULT '',
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      content_pillars JSONB NOT NULL DEFAULT '[]'::jsonb,
      visual_identity JSONB NOT NULL DEFAULT '{}'::jsonb,
      platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
      posting_cadence_days INTEGER NOT NULL DEFAULT 3,
      config_version INTEGER NOT NULL DEFAULT 1,
      config_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, brand_id)
    )
  `);

  pgm.sql(`
    CREATE TABLE social.content_items (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      brand_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      draft_text TEXT NOT NULL,
      pillar TEXT,
      status TEXT NOT NULL DEFAULT 'pending_approval',
      execution_id UUID,
      verity_record_id TEXT,
      artifact_hash TEXT NOT NULL,
      approval_id UUID,
      slack_channel TEXT,
      slack_message_ts TEXT,
      image_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      CHECK (status IN (
        'pending_approval', 'approved', 'rejected',
        'publishing', 'scheduling', 'posted', 'scheduled',
        'needs_review', 'error'
      ))
    )
  `);
  pgm.sql(
    "CREATE INDEX social_content_items_org_brand_idx ON social.content_items (organization_id, brand_id, status)"
  );

  pgm.sql(`
    CREATE TABLE social.onboarding_sessions (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      brand_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      channel TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'identity',
      answers JSONB NOT NULL DEFAULT '{}'::jsonb,
      draft_voice_md TEXT,
      draft_config JSONB,
      proposed_config_hash TEXT,
      execution_id UUID,
      status TEXT NOT NULL DEFAULT 'in_progress',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, brand_id)
    )
  `);
  pgm.sql(
    "CREATE INDEX social_onboarding_thread_idx ON social.onboarding_sessions (organization_id, thread_ts)"
  );
};

exports.down = (pgm) => {
  pgm.sql("DROP TABLE IF EXISTS social.onboarding_sessions");
  pgm.sql("DROP TABLE IF EXISTS social.content_items");
  pgm.sql("DROP TABLE IF EXISTS social.brands");
  pgm.sql("DROP TABLE IF EXISTS nova.skill_runs");
  pgm.sql("DROP TABLE IF EXISTS nova.external_identities");
  pgm.sql("DROP SCHEMA IF EXISTS social");
  pgm.sql("DROP SCHEMA IF EXISTS nova");
  pgm.sql("ALTER TABLE command.approvals DROP COLUMN IF EXISTS artifact_hash");
  pgm.sql("DELETE FROM auth.permissions WHERE key = 'social.draft'");
};
