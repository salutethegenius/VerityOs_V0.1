"use client";

import { useState } from "react";
import { listPolicies } from "@/lib/api/command";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "@/components/ui";
import { useAsync } from "@/lib/useAsync";

export default function PoliciesPage() {
  const list = useAsync(() => listPolicies(), []);
  const [advanced, setAdvanced] = useState<string | null>(null);
  return (
    <div>
      <PageHeader title="Policies" description="Readable policy summaries. Machine-readable reason codes remain backend behavior." />
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {list.data?.policies.length === 0 ? (
        <EmptyState title="No policies" body="No Command policies are registered." />
      ) : (
        <div className="space-y-4">
          {list.data?.policies.map((p) => (
            <Panel key={p.id}>
              <h2 className="text-sm font-semibold">
                {p.name} · v{p.version} · {p.status}
              </h2>
              <ul className="mt-2 list-disc pl-5 text-sm">
                {p.rules_summary?.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-muted">
                Bindings: {p.bindings?.length ? p.bindings.map((b) => b.skill_id ?? "default").join(", ") : "none"}
              </p>
              <button type="button" className="link-btn mt-2" onClick={() => setAdvanced(advanced === p.id ? null : p.id)}>
                {advanced === p.id ? "Hide JSON" : "Advanced JSON"}
              </button>
              {advanced === p.id ? (
                <pre className="mt-2 overflow-auto bg-paper p-3 font-mono text-xs">{JSON.stringify(p.rules, null, 2)}</pre>
              ) : null}
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
