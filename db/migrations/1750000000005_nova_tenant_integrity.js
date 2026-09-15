/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Phase 8 runtime hardening: composite organization FKs for Nova/social tables
 * and proposed brand-config version identity. Does not copy Content-Loop data.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE command.approvals
      ADD CONSTRAINT approvals_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE social.brands
      ADD CONSTRAINT social_brands_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE nova.skill_runs
      ADD CONSTRAINT nova_skill_runs_organization_id_id_key UNIQUE (organization_id, id)
  `);

  pgm.sql(`
    ALTER TABLE nova.external_identities
      ADD CONSTRAINT nova_external_identities_member_org_fk
      FOREIGN KEY (organization_id, verity_user_id)
      REFERENCES auth.memberships (organization_id, user_id)
  `);
  pgm.sql(`
    ALTER TABLE nova.skill_runs
      ADD CONSTRAINT nova_skill_runs_execution_org_fk
      FOREIGN KEY (organization_id, execution_id)
      REFERENCES audit.executions (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE nova.skill_runs
      ADD CONSTRAINT nova_skill_runs_actor_org_fk
      FOREIGN KEY (organization_id, actor_id)
      REFERENCES auth.memberships (organization_id, user_id)
  `);

  pgm.sql(`
    ALTER TABLE social.content_items
      ADD CONSTRAINT social_content_items_brand_org_fk
      FOREIGN KEY (organization_id, brand_id)
      REFERENCES social.brands (organization_id, brand_id)
  `);
  pgm.sql(`
    ALTER TABLE social.content_items
      ADD CONSTRAINT social_content_items_execution_org_fk
      FOREIGN KEY (organization_id, execution_id)
      REFERENCES audit.executions (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE social.content_items
      ADD CONSTRAINT social_content_items_approval_org_fk
      FOREIGN KEY (organization_id, approval_id)
      REFERENCES command.approvals (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE social.onboarding_sessions
      ADD CONSTRAINT social_onboarding_execution_org_fk
      FOREIGN KEY (organization_id, execution_id)
      REFERENCES audit.executions (organization_id, id)
  `);

  pgm.sql(
    "ALTER TABLE social.onboarding_sessions ADD COLUMN IF NOT EXISTS proposed_config_version INTEGER"
  );
};

exports.down = (pgm) => {
  pgm.sql("ALTER TABLE social.onboarding_sessions DROP COLUMN IF EXISTS proposed_config_version");
  pgm.sql("ALTER TABLE social.onboarding_sessions DROP CONSTRAINT IF EXISTS social_onboarding_execution_org_fk");
  pgm.sql("ALTER TABLE social.content_items DROP CONSTRAINT IF EXISTS social_content_items_approval_org_fk");
  pgm.sql("ALTER TABLE social.content_items DROP CONSTRAINT IF EXISTS social_content_items_execution_org_fk");
  pgm.sql("ALTER TABLE social.content_items DROP CONSTRAINT IF EXISTS social_content_items_brand_org_fk");
  pgm.sql("ALTER TABLE nova.skill_runs DROP CONSTRAINT IF EXISTS nova_skill_runs_actor_org_fk");
  pgm.sql("ALTER TABLE nova.skill_runs DROP CONSTRAINT IF EXISTS nova_skill_runs_execution_org_fk");
  pgm.sql("ALTER TABLE nova.external_identities DROP CONSTRAINT IF EXISTS nova_external_identities_member_org_fk");
  pgm.sql("ALTER TABLE nova.skill_runs DROP CONSTRAINT IF EXISTS nova_skill_runs_organization_id_id_key");
  pgm.sql("ALTER TABLE social.brands DROP CONSTRAINT IF EXISTS social_brands_organization_id_id_key");
  pgm.sql("ALTER TABLE command.approvals DROP CONSTRAINT IF EXISTS approvals_organization_id_id_key");
};
