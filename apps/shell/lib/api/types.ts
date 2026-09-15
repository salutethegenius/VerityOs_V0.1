export type SessionProfile = {
  user_id: string;
  display_name: string;
  email: string;
  organization_id: string;
  organization: string;
  role: string;
  permissions: string[];
};

export type HomeSummary = {
  system: { status: string; database: boolean };
  nova: { enabled_skills: number };
  knowledge: { collections: number; approved_sources: number };
  approvals: { pending: number };
  models: { available: number; total: number };
  connectors: { configured: number; enabled: number };
  audit: {
    latest_chain_sequence: number | null;
    recent_records: Array<{
      verity_record_id: string | null;
      execution_id: string;
      skill_id: string | null;
      status: string;
      started_at: string;
    }>;
  };
};

export type NovaSkill = {
  id: string;
  name: string;
  version: string;
  risk_tier: string;
  knowledge_mode?: string | null;
  required_permissions?: string[];
  approval?: boolean;
  approval_policy?: string;
};

export type NovaRun = {
  execution_id: string;
  verity_record_id: string | null;
  skill_id: string | null;
  status: string;
  risk_tier: string | null;
  actor_id: string;
  started_at: string;
  completed_at: string | null;
};

export type Citation = {
  chunk_id?: string;
  source_id?: string;
  source_version_id?: string;
  title?: string;
  page?: string | number;
  chunk_count?: number;
};

export type NovaExecuteResult = {
  execution_id: string;
  verity_record_id: string;
  status: string;
  artifact?: string | null;
  artifact_hash?: string | null;
  approval_id?: string | null;
  item_id?: string | null;
  citations?: Citation[];
  events?: string[];
};

export type NovaRunDetail = {
  execution: {
    id: string;
    status: string;
    skill_id: string | null;
    risk_tier: string | null;
    actor_id: string;
    verity_record_id: string | null;
    policy_version: string | number | null;
  };
  events: Array<{
    id: string;
    event_type: string;
    status: string;
    created_at: string;
    metadata: Record<string, unknown> | null;
  }>;
  record: Record<string, unknown> | null;
  social_item: {
    id: string;
    brand_id: string;
    platform: string;
    draft_text: string;
    status: string;
    artifact_hash: string;
    approval_id: string | null;
    connector_action_id: string | null;
    scheduled_for: string | null;
    external_action_id: string | null;
  } | null;
  approval: {
    id: string;
    status: string;
    artifact_hash: string | null;
    requested_by: string;
    requested_by_name?: string | null;
    requested_by_email?: string | null;
    decided_by: string | null;
    decided_by_name?: string | null;
    decided_by_email?: string | null;
    created_at: string;
    decided_at: string | null;
  } | null;
  citations?: Citation[];
};

export type Collection = {
  id: string;
  name: string;
  classification: string;
  created_at: string;
  source_count?: number;
  can_read?: boolean;
  can_manage?: boolean;
  can_approve?: boolean;
};

export type SourceVersion = {
  id: string;
  version_number: number;
  content_hash: string;
  mime_type: string;
  original_filename: string;
  parser_version: string | null;
  effective_at: string | null;
  uploaded_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  indexed: boolean;
};

export type Connector = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  capabilities: string[] | string;
  requires_approval: boolean;
  version: string;
  secret_ref: string | null;
  page_id: string | null;
};

export type ApprovalRow = {
  id: string;
  execution_id: string;
  skill_id: string;
  requested_by: string;
  requested_by_name?: string | null;
  requested_by_email?: string | null;
  decided_by: string | null;
  decided_by_name?: string | null;
  decided_by_email?: string | null;
  status: string;
  reason_code: string | null;
  artifact_hash: string | null;
  created_at: string;
  decided_at: string | null;
  risk_tier: string | null;
  verity_record_id: string | null;
  execution_status: string;
};

export type VerityRecordListItem = {
  verity_record_id: string | null;
  execution_id: string;
  actor_id: string;
  actor_name?: string | null;
  actor_email?: string | null;
  skill_id: string | null;
  risk_tier: string | null;
  status: string;
  policy_version: string | number | null;
  started_at: string;
  completed_at: string | null;
};

export type VerifyResult = {
  verity_record_id: string;
  integrity_verified: boolean;
  provenance_verified: boolean;
  integrity_status: string;
  provenance_status: string;
  integrity_label: string;
  provenance_label: string;
  issues: Array<{ code?: string; message?: string } | string>;
};

export type SystemStatus = {
  core: { status: string; phase: string; database: boolean };
  nova: { status: string; phase?: string; version?: string };
  kernel: {
    version: string;
    hash_format_version: string;
    execution_graph_schema_version: string;
  };
  storage: { configured: boolean; provider: string };
  embeddings: { provider: string; dimensions: number };
  models: { count: number };
  connectors: Array<{ key: string; enabled: boolean }>;
  deployment_profile: string;
};
