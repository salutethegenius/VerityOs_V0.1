/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Phase 3–6 hardening:
 * - Composite UNIQUE (organization_id, id) keys and matching composite FKs so
 *   organization-owned rows cannot reference another organization's parent.
 * - Retrieval provenance flags (retrieved / ranked / returned_to_caller).
 *   included_in_context stays false until model execution records actual use.
 * - Replace the test-only vector(64) slot with the V0.1 production pgvector
 *   dimension 768 (nomic-embed-text / typical local embeddings). Changing the
 *   dimension later requires a new migration, a new HNSW index, and a reindex
 *   of chunks. Historical rows keep embedding_provider_key so mixed providers
 *   can coexist; retrieval only searches the active provider + dimension.
 *   Existing 64-d chunk vectors (if any) are dropped; they cannot be converted.
 * down() restores prior FKs and vector(64). Rolling back deletes chunks.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE auth.roles
      ADD CONSTRAINT roles_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE auth.memberships
      ADD CONSTRAINT memberships_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE auth.memberships DROP CONSTRAINT IF EXISTS memberships_role_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE auth.memberships
      ADD CONSTRAINT memberships_role_org_fk
      FOREIGN KEY (organization_id, role_id)
      REFERENCES auth.roles (organization_id, id)
  `);
  pgm.sql(`
    DELETE FROM auth.sessions s
    WHERE NOT EXISTS (
      SELECT 1 FROM auth.memberships m
      WHERE m.organization_id = s.organization_id AND m.user_id = s.user_id
    )
  `);
  pgm.sql(`
    ALTER TABLE auth.sessions
      ADD CONSTRAINT sessions_membership_org_user_fk
      FOREIGN KEY (organization_id, user_id)
      REFERENCES auth.memberships (organization_id, user_id)
  `);

  pgm.sql(`
    ALTER TABLE command.policies
      ADD CONSTRAINT policies_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE command.policy_bindings DROP CONSTRAINT IF EXISTS policy_bindings_policy_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE command.policy_bindings
      ADD CONSTRAINT policy_bindings_policy_org_fk
      FOREIGN KEY (organization_id, policy_id)
      REFERENCES command.policies (organization_id, id)
  `);

  pgm.sql(`
    ALTER TABLE command.skill_policies
      ADD CONSTRAINT skill_policies_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE command.skill_policy_roles
      ADD COLUMN organization_id UUID
  `);
  pgm.sql(`
    UPDATE command.skill_policy_roles spr
    SET organization_id = sp.organization_id
    FROM command.skill_policies sp
    WHERE sp.id = spr.skill_policy_id
  `);
  pgm.sql(`
    ALTER TABLE command.skill_policy_roles
      ALTER COLUMN organization_id SET NOT NULL
  `);
  pgm.sql(`
    ALTER TABLE command.skill_policy_roles DROP CONSTRAINT IF EXISTS skill_policy_roles_skill_policy_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE command.skill_policy_roles DROP CONSTRAINT IF EXISTS skill_policy_roles_role_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE command.skill_policy_roles
      ADD CONSTRAINT skill_policy_roles_skill_org_fk
      FOREIGN KEY (organization_id, skill_policy_id)
      REFERENCES command.skill_policies (organization_id, id)
      ON DELETE CASCADE
  `);
  pgm.sql(`
    ALTER TABLE command.skill_policy_roles
      ADD CONSTRAINT skill_policy_roles_role_org_fk
      FOREIGN KEY (organization_id, role_id)
      REFERENCES auth.roles (organization_id, id)
      ON DELETE CASCADE
  `);

  pgm.sql(`
    ALTER TABLE knowledge.collections
      ADD CONSTRAINT collections_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.sources
      ADD CONSTRAINT sources_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.source_versions
      ADD CONSTRAINT source_versions_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.chunks
      ADD CONSTRAINT chunks_organization_id_id_key UNIQUE (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_runs
      ADD CONSTRAINT retrieval_runs_organization_id_id_key UNIQUE (organization_id, id)
  `);

  pgm.sql(`
    ALTER TABLE knowledge.collection_permissions DROP CONSTRAINT IF EXISTS collection_permissions_collection_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE knowledge.collection_permissions DROP CONSTRAINT IF EXISTS collection_permissions_role_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE knowledge.collection_permissions
      ADD CONSTRAINT collection_permissions_collection_org_fk
      FOREIGN KEY (organization_id, collection_id)
      REFERENCES knowledge.collections (organization_id, id)
      ON DELETE CASCADE
  `);
  pgm.sql(`
    ALTER TABLE knowledge.collection_permissions
      ADD CONSTRAINT collection_permissions_role_org_fk
      FOREIGN KEY (organization_id, role_id)
      REFERENCES auth.roles (organization_id, id)
      ON DELETE CASCADE
  `);

  pgm.sql(`
    ALTER TABLE knowledge.sources DROP CONSTRAINT IF EXISTS sources_collection_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE knowledge.sources
      ADD CONSTRAINT sources_collection_org_fk
      FOREIGN KEY (organization_id, collection_id)
      REFERENCES knowledge.collections (organization_id, id)
  `);

  pgm.sql(`
    ALTER TABLE knowledge.source_versions DROP CONSTRAINT IF EXISTS source_versions_source_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE knowledge.source_versions
      ADD CONSTRAINT source_versions_source_org_fk
      FOREIGN KEY (organization_id, source_id)
      REFERENCES knowledge.sources (organization_id, id)
  `);

  pgm.sql(`
    ALTER TABLE knowledge.chunks DROP CONSTRAINT IF EXISTS chunks_source_version_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE knowledge.chunks
      ADD CONSTRAINT chunks_source_version_org_fk
      FOREIGN KEY (organization_id, source_version_id)
      REFERENCES knowledge.source_versions (organization_id, id)
  `);

  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits DROP CONSTRAINT IF EXISTS retrieval_hits_retrieval_run_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits DROP CONSTRAINT IF EXISTS retrieval_hits_chunk_id_fkey
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      ADD CONSTRAINT retrieval_hits_run_org_fk
      FOREIGN KEY (organization_id, retrieval_run_id)
      REFERENCES knowledge.retrieval_runs (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      ADD CONSTRAINT retrieval_hits_chunk_org_fk
      FOREIGN KEY (organization_id, chunk_id)
      REFERENCES knowledge.chunks (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      ADD CONSTRAINT retrieval_hits_source_org_fk
      FOREIGN KEY (organization_id, source_id)
      REFERENCES knowledge.sources (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      ADD CONSTRAINT retrieval_hits_version_org_fk
      FOREIGN KEY (organization_id, source_version_id)
      REFERENCES knowledge.source_versions (organization_id, id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      ADD CONSTRAINT retrieval_hits_collection_org_fk
      FOREIGN KEY (organization_id, collection_id)
      REFERENCES knowledge.collections (organization_id, id)
  `);

  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      ADD COLUMN retrieved BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN ranked BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN returned_to_caller BOOLEAN NOT NULL DEFAULT false
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      ALTER COLUMN included_in_context SET DEFAULT false
  `);

  pgm.sql("DELETE FROM knowledge.retrieval_hits");
  pgm.sql("DELETE FROM knowledge.chunks");
  pgm.sql("DROP INDEX IF EXISTS knowledge.chunks_embedding_idx");
  pgm.sql("ALTER TABLE knowledge.chunks DROP COLUMN embedding");
  pgm.sql(`
    ALTER TABLE knowledge.chunks
      ADD COLUMN embedding vector(768) NOT NULL,
      ADD COLUMN embedding_provider_key TEXT NOT NULL DEFAULT 'mock',
      ADD COLUMN embedding_dimensions INTEGER NOT NULL DEFAULT 768
  `);
  pgm.sql(`
    ALTER TABLE knowledge.chunks
      ADD CONSTRAINT chunks_embedding_dimensions_chk
      CHECK (embedding_dimensions = 768)
  `);
  pgm.sql(`
    CREATE INDEX chunks_embedding_idx
      ON knowledge.chunks USING hnsw (embedding vector_cosine_ops)
  `);

  pgm.sql(`
    ALTER TABLE knowledge.retrieval_runs
      ADD COLUMN embedding_provider_key TEXT NOT NULL DEFAULT 'mock',
      ADD COLUMN embedding_dimensions INTEGER NOT NULL DEFAULT 768
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_runs
      ADD CONSTRAINT retrieval_runs_embedding_dimensions_chk
      CHECK (embedding_dimensions = 768)
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      DROP CONSTRAINT IF EXISTS retrieval_hits_collection_org_fk,
      DROP CONSTRAINT IF EXISTS retrieval_hits_version_org_fk,
      DROP CONSTRAINT IF EXISTS retrieval_hits_source_org_fk,
      DROP CONSTRAINT IF EXISTS retrieval_hits_chunk_org_fk,
      DROP CONSTRAINT IF EXISTS retrieval_hits_run_org_fk
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      ADD CONSTRAINT retrieval_hits_retrieval_run_id_fkey
      FOREIGN KEY (retrieval_run_id) REFERENCES knowledge.retrieval_runs (id),
      ADD CONSTRAINT retrieval_hits_chunk_id_fkey
      FOREIGN KEY (chunk_id) REFERENCES knowledge.chunks (id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_hits
      DROP COLUMN IF EXISTS retrieved,
      DROP COLUMN IF EXISTS ranked,
      DROP COLUMN IF EXISTS returned_to_caller
  `);

  pgm.sql("DELETE FROM knowledge.chunks");
  pgm.sql("DROP INDEX IF EXISTS knowledge.chunks_embedding_idx");
  pgm.sql(`
    ALTER TABLE knowledge.chunks
      DROP CONSTRAINT IF EXISTS chunks_embedding_dimensions_chk,
      DROP CONSTRAINT IF EXISTS chunks_source_version_org_fk
  `);
  pgm.sql(`
    ALTER TABLE knowledge.chunks
      DROP COLUMN IF EXISTS embedding,
      DROP COLUMN IF EXISTS embedding_provider_key,
      DROP COLUMN IF EXISTS embedding_dimensions
  `);
  pgm.sql("ALTER TABLE knowledge.chunks ADD COLUMN embedding vector(64) NOT NULL");
  pgm.sql(`
    ALTER TABLE knowledge.chunks
      ADD CONSTRAINT chunks_source_version_id_fkey
      FOREIGN KEY (source_version_id) REFERENCES knowledge.source_versions (id)
  `);
  pgm.sql(`
    CREATE INDEX chunks_embedding_idx
      ON knowledge.chunks USING hnsw (embedding vector_cosine_ops)
  `);

  pgm.sql(`
    ALTER TABLE knowledge.retrieval_runs
      DROP CONSTRAINT IF EXISTS retrieval_runs_embedding_dimensions_chk
  `);
  pgm.sql(`
    ALTER TABLE knowledge.retrieval_runs
      DROP COLUMN IF EXISTS embedding_provider_key,
      DROP COLUMN IF EXISTS embedding_dimensions
  `);

  pgm.sql(`
    ALTER TABLE knowledge.source_versions DROP CONSTRAINT IF EXISTS source_versions_source_org_fk
  `);
  pgm.sql(`
    ALTER TABLE knowledge.source_versions
      ADD CONSTRAINT source_versions_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES knowledge.sources (id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.sources DROP CONSTRAINT IF EXISTS sources_collection_org_fk
  `);
  pgm.sql(`
    ALTER TABLE knowledge.sources
      ADD CONSTRAINT sources_collection_id_fkey
      FOREIGN KEY (collection_id) REFERENCES knowledge.collections (id)
  `);
  pgm.sql(`
    ALTER TABLE knowledge.collection_permissions
      DROP CONSTRAINT IF EXISTS collection_permissions_role_org_fk,
      DROP CONSTRAINT IF EXISTS collection_permissions_collection_org_fk
  `);
  pgm.sql(`
    ALTER TABLE knowledge.collection_permissions
      ADD CONSTRAINT collection_permissions_collection_id_fkey
      FOREIGN KEY (collection_id) REFERENCES knowledge.collections (id) ON DELETE CASCADE,
      ADD CONSTRAINT collection_permissions_role_id_fkey
      FOREIGN KEY (role_id) REFERENCES auth.roles (id) ON DELETE CASCADE
  `);

  pgm.sql(`
    ALTER TABLE command.skill_policy_roles
      DROP CONSTRAINT IF EXISTS skill_policy_roles_role_org_fk,
      DROP CONSTRAINT IF EXISTS skill_policy_roles_skill_org_fk
  `);
  pgm.sql("ALTER TABLE command.skill_policy_roles DROP COLUMN IF EXISTS organization_id");
  pgm.sql(`
    ALTER TABLE command.skill_policy_roles
      ADD CONSTRAINT skill_policy_roles_skill_policy_id_fkey
      FOREIGN KEY (skill_policy_id) REFERENCES command.skill_policies (id) ON DELETE CASCADE,
      ADD CONSTRAINT skill_policy_roles_role_id_fkey
      FOREIGN KEY (role_id) REFERENCES auth.roles (id) ON DELETE CASCADE
  `);

  pgm.sql(`
    ALTER TABLE command.policy_bindings DROP CONSTRAINT IF EXISTS policy_bindings_policy_org_fk
  `);
  pgm.sql(`
    ALTER TABLE command.policy_bindings
      ADD CONSTRAINT policy_bindings_policy_id_fkey
      FOREIGN KEY (policy_id) REFERENCES command.policies (id)
  `);

  pgm.sql(`
    ALTER TABLE auth.sessions DROP CONSTRAINT IF EXISTS sessions_membership_org_user_fk
  `);
  pgm.sql(`
    ALTER TABLE auth.memberships DROP CONSTRAINT IF EXISTS memberships_role_org_fk
  `);
  pgm.sql(`
    ALTER TABLE auth.memberships
      ADD CONSTRAINT memberships_role_id_fkey
      FOREIGN KEY (role_id) REFERENCES auth.roles (id)
  `);

  pgm.sql(`
    ALTER TABLE knowledge.retrieval_runs DROP CONSTRAINT IF EXISTS retrieval_runs_organization_id_id_key
  `);
  pgm.sql("ALTER TABLE knowledge.chunks DROP CONSTRAINT IF EXISTS chunks_organization_id_id_key");
  pgm.sql(
    "ALTER TABLE knowledge.source_versions DROP CONSTRAINT IF EXISTS source_versions_organization_id_id_key"
  );
  pgm.sql("ALTER TABLE knowledge.sources DROP CONSTRAINT IF EXISTS sources_organization_id_id_key");
  pgm.sql(
    "ALTER TABLE knowledge.collections DROP CONSTRAINT IF EXISTS collections_organization_id_id_key"
  );
  pgm.sql(
    "ALTER TABLE command.skill_policies DROP CONSTRAINT IF EXISTS skill_policies_organization_id_id_key"
  );
  pgm.sql("ALTER TABLE command.policies DROP CONSTRAINT IF EXISTS policies_organization_id_id_key");
  pgm.sql(
    "ALTER TABLE auth.memberships DROP CONSTRAINT IF EXISTS memberships_organization_id_id_key"
  );
  pgm.sql("ALTER TABLE auth.roles DROP CONSTRAINT IF EXISTS roles_organization_id_id_key");
};

