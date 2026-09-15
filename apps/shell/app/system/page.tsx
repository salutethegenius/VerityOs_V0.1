"use client";

import { getSystemStatus } from "@/lib/api/system";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, StatusPill } from "@/components/ui";
import { useAsync } from "@/lib/useAsync";

export default function SystemPage() {
  const status = useAsync(() => getSystemStatus(), []);
  const data = status.data;
  return (
    <div>
      <PageHeader title="System" description="Safe runtime facts from Core. Secrets and connection strings are omitted." />
      {status.loading ? <LoadingState /> : null}
      {status.error ? (
        <ErrorState message={status.error.message} requestId={status.error.requestId} onRetry={() => void status.reload()} />
      ) : null}
      {data ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Panel>
            <h2 className="text-sm font-semibold">Core</h2>
            <p className="mt-2 flex items-center gap-2 text-sm">
              <StatusPill label={data.core.status} tone={data.core.status === "ok" ? "ok" : "warn"} />
              phase {data.core.phase}
            </p>
            <p className="text-sm text-muted">{data.core.database ? "Database connected" : "Database unavailable"}</p>
          </Panel>
          <Panel>
            <h2 className="text-sm font-semibold">Nova</h2>
            <p className="mt-2 flex items-center gap-2 text-sm">
              <StatusPill label={data.nova.status} tone={data.nova.status === "ok" ? "ok" : "warn"} />
              {data.nova.phase ? `phase ${data.nova.phase}` : null}
            </p>
            <p className="text-sm text-muted">{data.nova.version ?? "version unknown"}</p>
          </Panel>
          <Panel>
            <h2 className="text-sm font-semibold">Kernel</h2>
            <ul className="mt-2 space-y-1 text-sm">
              <li>version {data.kernel.version}</li>
              <li>hash format {data.kernel.hash_format_version}</li>
              <li>execution graph schema {data.kernel.execution_graph_schema_version}</li>
            </ul>
          </Panel>
          <Panel>
            <h2 className="text-sm font-semibold">Storage / embeddings</h2>
            <ul className="mt-2 space-y-1 text-sm">
              <li>storage {data.storage.configured ? data.storage.provider : "not configured"}</li>
              <li>embeddings {data.embeddings.provider} · {data.embeddings.dimensions} dimensions</li>
              <li>registered models {data.models.count}</li>
              <li>deployment profile {data.deployment_profile}</li>
            </ul>
          </Panel>
          <Panel className="md:col-span-2">
            <h2 className="text-sm font-semibold">Connectors</h2>
            {data.connectors.length === 0 ? (
              <EmptyState title="None configured" body="No connectors are registered for this organization." />
            ) : (
              <table className="data mt-2">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {data.connectors.map((c) => (
                    <tr key={c.key}>
                      <td>{c.key}</td>
                      <td>{c.enabled ? "enabled" : "disabled"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
