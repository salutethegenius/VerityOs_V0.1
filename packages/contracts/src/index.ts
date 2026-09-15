export type RiskTier = "low" | "medium" | "high";

export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type LedgerEntryType =
  | "request_opened"
  | "approval_requested"
  | "action_completed"
  | "final"
  | "failure";

export type ExecutionStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type PolicyDecisionValue = "allow" | "deny" | "approval_required";

export type KnowledgeMode = "strict" | "grounded" | "general";

export type DeploymentType = "local" | "private" | "cloud";

export type ModelProvider = "mock" | "anthropic" | "openai" | "openai-compatible";

export const PERMISSIONS = [
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
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];

export const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export const RISK_RANK: Record<RiskTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
}

export interface PolicyDecision {
  decision: PolicyDecisionValue;
  reason_code: string;
  policy_id: string | null;
  policy_version: string | null;
  evaluated_at: string;
  constraints: Record<string, unknown>;
}

export interface ModelRouteRequest {
  execution_id: string;
  task: string;
  risk_tier: RiskTier;
  data_classification: DataClassification;
  required_capabilities: string[];
  prefer_local: boolean;
}

export interface ModelRouteResult {
  model_id: string | null;
  provider: ModelProvider | null;
  deployment_type: DeploymentType | null;
  policy_version: string | null;
  selection_reason_code: string;
}

export interface KnowledgeRetrieveRequest {
  execution_id: string;
  organization_id: string;
  actor_id: string;
  query: string;
  collection_ids: string[];
  mode: KnowledgeMode;
  top_k: number;
  classification_ceiling: DataClassification;
}

export interface KnowledgeHit {
  chunk_id: string;
  source_id: string;
  source_version_id: string;
  title: string;
  page: number | null;
  section: string | null;
  text: string;
  content_hash: string;
  vector_score: number;
  keyword_score: number;
  rerank_score: number | null;
  rank: number;
}

export interface KnowledgeRetrieveResponse {
  retrieval_run_id: string;
  mode: KnowledgeMode;
  insufficient_evidence: boolean;
  hits: KnowledgeHit[];
}

export const EXECUTION_GRAPH_SCHEMA_VERSION = "2";

export const EXECUTION_EVENT_TYPES = [
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
] as const;

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

export type ExecutionEventStatus =
  | "recorded"
  | "started"
  | "ok"
  | "denied"
  | "failed"
  | "blocked"
  | "insufficient";

export interface ExecutionGraphNode {
  event_id: string;
  sequence: number;
  event_type: ExecutionEventType;
  status: string;
  occurred_at_canonical: string;
  input_hash: string | null;
  output_hash: string | null;
  metadata: Record<string, unknown>;
}

export interface ExecutionGraphEdge {
  from_event_id: string;
  to_event_id: string;
}

export interface ExecutionGraphV2 {
  schema_version: typeof EXECUTION_GRAPH_SCHEMA_VERSION;
  execution_id: string;
  verity_record_id: string;
  organization_id: string;
  status: ExecutionStatus;
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
}
