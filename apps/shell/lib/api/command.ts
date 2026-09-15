import { api } from "./client";
import type { ApprovalRow, Connector, NovaSkill } from "./types";

export function listUsers() {
  return api<{
    users: Array<{ id: string; email: string; display_name: string; role: string; status: string }>;
  }>("/v1/users");
}

export function listRoles() {
  return api<{
    roles: Array<{ id: string; name: string; description: string; permissions: string[] }>;
  }>("/v1/roles");
}

export function listPolicies() {
  return api<{
    policies: Array<{
      id: string;
      name: string;
      version: number;
      status: string;
      rules: unknown;
      rules_summary: string[];
      bindings: Array<{ id: string; skill_id: string | null }>;
      created_at: string;
    }>;
  }>("/v1/policies");
}

export function getPolicy(id: string) {
  return api<{ id: string; name: string; version: number; status: string; rules: unknown; created_at: string }>(
    `/v1/policies/${encodeURIComponent(id)}`
  );
}

export function listModels() {
  return api<{
    models: Array<{
      id: string;
      model_key: string;
      provider: string;
      deployment_type: "local" | "private" | "cloud";
      capabilities_json: string[];
      allowed_data_classes_json: string[];
      risk_ceiling: string;
      requires_internet: boolean;
      enabled: boolean;
      endpoint: string | null;
    }>;
  }>("/v1/models");
}

export function listCommandSkills() {
  return api<{ skills: NovaSkill[] }>("/v1/command/skills");
}

export function listConnectors() {
  return api<{ connectors: Connector[] }>("/v1/connectors");
}

export function checkConnectorHealth(connectorId: string) {
  return api<{ status: string; checked_at?: string; name?: string }>(
    `/v1/connectors/${encodeURIComponent(connectorId)}/health`,
    { method: "POST", body: JSON.stringify({}) }
  );
}

export function listApprovals(status?: string) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return api<{ approvals: ApprovalRow[] }>(`/v1/approvals${query}`);
}
