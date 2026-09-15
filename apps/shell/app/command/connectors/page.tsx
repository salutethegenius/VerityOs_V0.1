"use client";

import { useState } from "react";
import { checkConnectorHealth, listConnectors } from "@/lib/api/command";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusPill } from "@/components/ui";
import { useAsync } from "@/lib/useAsync";
import { CoreApiError } from "@/lib/api/client";

export default function ConnectorsPage() {
  const list = useAsync(() => listConnectors(), []);
  const [health, setHealth] = useState<Record<string, { status: string }>>({});
  const [error, setError] = useState<CoreApiError | null>(null);
  return (
    <div>
      <PageHeader title="Connectors" description="Configured connectors. Secret values are never rendered." />
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {error ? <ErrorState message={error.message} requestId={error.requestId} /> : null}
      {list.data?.connectors.length === 0 ? (
        <EmptyState title="No connectors" body="No connectors are configured." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Enabled</th>
              <th>Capabilities</th>
              <th>Secret ref</th>
              <th>Health</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.connectors.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.type}</td>
                <td>
                  <StatusPill label={c.enabled ? "enabled" : "disabled"} tone={c.enabled ? "ok" : "neutral"} />
                </td>
                <td>{Array.isArray(c.capabilities) ? c.capabilities.join(", ") : String(c.capabilities ?? "")}</td>
                <td className="font-mono text-xs">{c.secret_ref ?? "—"}</td>
                <td>
                  {health[c.id] ? <StatusPill label={health[c.id].status} /> : null}
                  <button
                    type="button"
                    className="btn ml-2"
                    onClick={() => {
                      void checkConnectorHealth(c.id)
                        .then((row) => setHealth((h) => ({ ...h, [c.id]: row })))
                        .catch((err) =>
                          setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "health failed", 500))
                        );
                    }}
                  >
                    Check
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
