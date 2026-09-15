"use client";

import { listModels } from "@/lib/api/command";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusPill } from "@/components/ui";
import { useAsync } from "@/lib/useAsync";

export default function ModelsPage() {
  const list = useAsync(() => listModels(), []);
  return (
    <div>
      <PageHeader title="Models" description="Registered models. Provider keys are never shown." />
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {list.data?.models.length === 0 ? (
        <EmptyState title="No models" body="No models are registered for this organization." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Key</th>
              <th>Provider</th>
              <th>Deployment</th>
              <th>Capabilities</th>
              <th>Data classes</th>
              <th>Risk ceiling</th>
              <th>Internet</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.models.map((m) => (
              <tr key={m.id}>
                <td className="font-mono text-xs">{m.model_key}</td>
                <td>{m.provider}</td>
                <td>
                  <StatusPill
                    label={m.deployment_type}
                    tone={m.deployment_type === "local" ? "ok" : m.deployment_type === "private" ? "accent" : "warn"}
                  />
                </td>
                <td>{m.capabilities_json?.join(", ")}</td>
                <td>{m.allowed_data_classes_json?.join(", ")}</td>
                <td>{m.risk_ceiling}</td>
                <td>{m.requires_internet ? "required" : "not required"}</td>
                <td>{m.enabled ? "enabled" : "disabled"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
