export function shortHash(value: string | null | undefined, size = 10): string {
  if (!value) return "—";
  if (value.length <= size * 2 + 1) return value;
  return `${value.slice(0, size)}…${value.slice(-4)}`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date) + " UTC";
}

export function humanLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/[._]/g, " ");
}

export const EVENT_LABELS: Record<string, string> = {
  "execution.created": "Execution opened",
  "identity.authenticated": "Identity authenticated",
  "authorization.allowed": "Authorization allowed",
  "knowledge.retrieval.started": "Knowledge retrieved",
  "knowledge.retrieve": "Knowledge retrieved",
  "model.selected": "Model selected",
  "model.execute": "Model executed",
  "nova.skill.started": "Nova skill started",
  "nova.skill.completed": "Nova skill completed",
  "nova.skill.failed": "Nova skill failed",
  "approval.requested": "Approval requested",
  "approval.approved": "Approval approved",
  "approval.rejected": "Approval rejected",
  "tool.requested": "Tool authorized",
  "tool.completed": "Meta publish completed",
  "tool.failed": "Tool failed",
  "tool.denied": "Tool denied",
  "finalize.completed": "Audit sealed",
  "finalize.blocked": "Audit sealed (blocked)",
};

export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? humanLabel(eventType);
}

export const CONNECTOR_STATE_LABELS: Record<string, string> = {
  authorized: "Authorized",
  approved: "Authorized",
  executing: "Publishing",
  publishing: "Publishing",
  scheduling: "Publishing",
  scheduled: "Scheduled",
  succeeded: "Published",
  posted: "Published",
  needs_review: "Needs review",
  failed: "Failed",
  error: "Failed",
  denied: "Failed",
  pending_approval: "Pending approval",
  rejected: "Rejected",
};

export function connectorStateLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return CONNECTOR_STATE_LABELS[status] ?? humanLabel(status);
}

export function sourceTrustState(version: {
  approved_at: string | null;
  indexed: boolean;
}): "Approved" | "Indexed" | "Uploaded" {
  if (version.approved_at) return "Approved";
  if (version.indexed) return "Indexed";
  return "Uploaded";
}
