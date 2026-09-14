/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

exports.shorthands = undefined;

const PERMISSIONS = [
  "organization.manage",
  "users.manage",
  "roles.manage",
  "nova.use",
  "knowledge.read",
  "knowledge.manage",
  "knowledge.approve",
  "models.read",
  "models.manage",
  "policies.read",
  "policies.manage",
  "approvals.read",
  "approvals.decide",
  "audit.read",
  "audit.export",
  "connectors.manage",
];

exports.up = (pgm) => {
  pgm.sql("CREATE EXTENSION IF NOT EXISTS vector");
  pgm.sql("CREATE SCHEMA IF NOT EXISTS auth");
  pgm.sql("CREATE SCHEMA IF NOT EXISTS command");
  pgm.sql("CREATE SCHEMA IF NOT EXISTS knowledge");

  pgm.sql(`
    CREATE TABLE auth.organizations (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  pgm.sql(`
    CREATE TABLE auth.users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      disabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (email = lower(email))
    )
  `);

  pgm.sql(`
    CREATE TABLE auth.permissions (
      key TEXT PRIMARY KEY
    )
  `);

  for (const key of PERMISSIONS) {
    pgm.sql(`INSERT INTO auth.permissions (key) VALUES ('${key}')`);
  }

  pgm.sql(`
    CREATE TABLE auth.roles (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, name)
    )
  `);
  pgm.sql("CREATE INDEX roles_organization_id_idx ON auth.roles (organization_id)");

  pgm.sql(`
    CREATE TABLE auth.role_permissions (
      role_id UUID NOT NULL REFERENCES auth.roles (id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL REFERENCES auth.permissions (key),
      PRIMARY KEY (role_id, permission_key)
    )
  `);

  pgm.sql(`
    CREATE TABLE auth.memberships (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      user_id UUID NOT NULL REFERENCES auth.users (id),
      role_id UUID NOT NULL REFERENCES auth.roles (id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, user_id)
    )
  `);
  pgm.sql("CREATE INDEX memberships_user_id_idx ON auth.memberships (user_id)");
  pgm.sql("CREATE INDEX memberships_organization_id_idx ON auth.memberships (organization_id)");

  pgm.sql(`
    CREATE TABLE auth.sessions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES auth.users (id),
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ip TEXT,
      user_agent TEXT
    )
  `);
  pgm.sql("CREATE INDEX sessions_user_id_idx ON auth.sessions (user_id)");

  pgm.sql(`
    CREATE TABLE auth.service_credentials (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      organization_id UUID REFERENCES auth.organizations (id),
      secret_hash TEXT NOT NULL UNIQUE,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    )
  `);

  pgm.sql(`
    CREATE TABLE command.policies (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      name TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      rules JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, name, version)
    )
  `);
  pgm.sql("CREATE INDEX policies_organization_id_idx ON command.policies (organization_id)");

  pgm.sql(`
    CREATE TABLE command.policy_bindings (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      policy_id UUID NOT NULL REFERENCES command.policies (id),
      skill_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  pgm.sql(
    "CREATE UNIQUE INDEX policy_bindings_org_skill_idx ON command.policy_bindings (organization_id, COALESCE(skill_id, ''))"
  );

  pgm.sql(`
    CREATE TABLE command.models (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      model_key TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('mock', 'anthropic', 'openai', 'openai-compatible')),
      deployment_type TEXT NOT NULL CHECK (deployment_type IN ('local', 'private', 'cloud')),
      endpoint TEXT,
      capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_data_classes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      risk_ceiling TEXT NOT NULL CHECK (risk_ceiling IN ('low', 'medium', 'high')),
      requires_internet BOOLEAN NOT NULL DEFAULT false,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, model_key)
    )
  `);
  pgm.sql("CREATE INDEX models_organization_id_idx ON command.models (organization_id)");

  pgm.sql(`
    CREATE TABLE command.skill_policies (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      skill_id TEXT NOT NULL,
      requires_approval BOOLEAN NOT NULL DEFAULT false,
      classification_ceiling TEXT NOT NULL CHECK (classification_ceiling IN ('public', 'internal', 'confidential', 'restricted')),
      risk_ceiling TEXT NOT NULL CHECK (risk_ceiling IN ('low', 'medium', 'high')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, skill_id)
    )
  `);

  pgm.sql(`
    CREATE TABLE command.skill_policy_roles (
      skill_policy_id UUID NOT NULL REFERENCES command.skill_policies (id) ON DELETE CASCADE,
      role_id UUID NOT NULL REFERENCES auth.roles (id) ON DELETE CASCADE,
      PRIMARY KEY (skill_policy_id, role_id)
    )
  `);

  pgm.sql(`
    CREATE TABLE command.connectors (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      connector_key TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT false,
      allowed_data_classes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, connector_key)
    )
  `);

  pgm.sql(`
    CREATE TABLE command.approvals (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      execution_id UUID NOT NULL,
      skill_id TEXT NOT NULL,
      requested_by UUID NOT NULL REFERENCES auth.users (id),
      decided_by UUID REFERENCES auth.users (id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
      reason_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    )
  `);
  pgm.sql("CREATE INDEX approvals_organization_id_idx ON command.approvals (organization_id)");

  pgm.sql(`
    CREATE TABLE knowledge.collections (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      name TEXT NOT NULL,
      classification TEXT NOT NULL CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
      created_by UUID NOT NULL REFERENCES auth.users (id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  pgm.sql("CREATE INDEX collections_organization_id_idx ON knowledge.collections (organization_id)");

  pgm.sql(`
    CREATE TABLE knowledge.collection_permissions (
      id UUID PRIMARY KEY,
      collection_id UUID NOT NULL REFERENCES knowledge.collections (id) ON DELETE CASCADE,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      role_id UUID NOT NULL REFERENCES auth.roles (id) ON DELETE CASCADE,
      can_read BOOLEAN NOT NULL DEFAULT false,
      can_manage BOOLEAN NOT NULL DEFAULT false,
      can_approve BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (collection_id, role_id)
    )
  `);

  pgm.sql(`
    CREATE TABLE knowledge.sources (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      collection_id UUID NOT NULL REFERENCES knowledge.collections (id),
      title TEXT NOT NULL,
      created_by UUID NOT NULL REFERENCES auth.users (id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  pgm.sql("CREATE INDEX sources_collection_id_idx ON knowledge.sources (collection_id)");

  pgm.sql(`
    CREATE TABLE knowledge.source_versions (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      source_id UUID NOT NULL REFERENCES knowledge.sources (id),
      version_number INTEGER NOT NULL CHECK (version_number > 0),
      content_hash TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      blob_uri TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      uploaded_by UUID NOT NULL REFERENCES auth.users (id),
      approved_by UUID REFERENCES auth.users (id),
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source_id, version_number),
      UNIQUE (source_id, content_hash)
    )
  `);
  pgm.sql(
    "CREATE INDEX source_versions_source_id_idx ON knowledge.source_versions (source_id, version_number DESC)"
  );

  pgm.sql(`
    CREATE TABLE knowledge.chunks (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      source_version_id UUID NOT NULL REFERENCES knowledge.source_versions (id),
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      page_number INTEGER,
      section TEXT,
      text TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      token_count INTEGER NOT NULL CHECK (token_count >= 0),
      embedding vector(64) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
      UNIQUE (source_version_id, chunk_index)
    )
  `);
  pgm.sql("CREATE INDEX chunks_organization_id_idx ON knowledge.chunks (organization_id)");
  pgm.sql("CREATE INDEX chunks_tsv_idx ON knowledge.chunks USING gin (tsv)");
  pgm.sql(
    "CREATE INDEX chunks_embedding_idx ON knowledge.chunks USING hnsw (embedding vector_cosine_ops)"
  );

  pgm.sql(`
    CREATE TABLE knowledge.retrieval_runs (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      execution_id UUID,
      actor_id UUID NOT NULL REFERENCES auth.users (id),
      query TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('strict', 'grounded', 'general')),
      collection_ids UUID[] NOT NULL,
      classification_ceiling TEXT NOT NULL CHECK (classification_ceiling IN ('public', 'internal', 'confidential', 'restricted')),
      insufficient_evidence BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  pgm.sql("CREATE INDEX retrieval_runs_organization_id_idx ON knowledge.retrieval_runs (organization_id)");

  pgm.sql(`
    CREATE TABLE knowledge.retrieval_hits (
      id UUID PRIMARY KEY,
      retrieval_run_id UUID NOT NULL REFERENCES knowledge.retrieval_runs (id),
      organization_id UUID NOT NULL REFERENCES auth.organizations (id),
      chunk_id UUID NOT NULL REFERENCES knowledge.chunks (id),
      source_id UUID NOT NULL,
      source_version_id UUID NOT NULL,
      collection_id UUID NOT NULL,
      content_hash TEXT NOT NULL,
      rank INTEGER NOT NULL,
      vector_score DOUBLE PRECISION NOT NULL,
      keyword_score DOUBLE PRECISION NOT NULL,
      rerank_score DOUBLE PRECISION,
      included_in_context BOOLEAN NOT NULL DEFAULT false
    )
  `);
  pgm.sql(
    "CREATE INDEX retrieval_hits_run_id_idx ON knowledge.retrieval_hits (retrieval_run_id, rank)"
  );
};

exports.down = (pgm) => {
  pgm.sql("DROP SCHEMA IF EXISTS knowledge CASCADE");
  pgm.sql("DROP SCHEMA IF EXISTS command CASCADE");
  pgm.sql("DROP SCHEMA IF EXISTS auth CASCADE");
};
