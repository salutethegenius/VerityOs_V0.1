import { api } from "./client";
import type { NovaExecuteResult, NovaRun, NovaRunDetail, NovaSkill } from "./types";

export function listNovaSkills() {
  return api<{ skills: NovaSkill[]; source: string }>("/v1/nova/skills");
}

export function executeNovaSkill(skillId: string, input: Record<string, unknown>) {
  return api<NovaExecuteResult>(`/v1/nova/skills/${encodeURIComponent(skillId)}/execute`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listNovaRuns() {
  return api<{ runs: NovaRun[] }>("/v1/nova/runs");
}

export function getNovaRun(executionId: string) {
  return api<NovaRunDetail>(`/v1/nova/runs/${encodeURIComponent(executionId)}`);
}

export function decideNovaApproval(executionId: string, approvalId: string, allow: boolean, artifactHash: string) {
  return api<{ status: string; artifact_hash: string }>(
    `/v1/nova/runs/${encodeURIComponent(executionId)}/approvals/${encodeURIComponent(approvalId)}/decide`,
    { method: "POST", body: JSON.stringify({ allow, artifact_hash: artifactHash }) }
  );
}

export function publishNovaRun(
  executionId: string,
  body: { action: "publish_post" | "schedule_post"; scheduled_for?: string; artifact_hash: string; message: string }
) {
  return api<Record<string, unknown>>(`/v1/executions/${encodeURIComponent(executionId)}/connectors/actions`, {
    method: "POST",
    body: JSON.stringify({
      connector_type: "meta.facebook",
      action: body.action,
      artifact_hash: body.artifact_hash,
      payload: {
        message: body.message,
        scheduled_for: body.scheduled_for,
      },
    }),
  });
}

export function listBrands() {
  return api<{ brands: Array<{ brand_id: string; display_name: string; active: boolean; config_version: number; platforms: unknown }> }>(
    "/v1/social/brands"
  );
}
