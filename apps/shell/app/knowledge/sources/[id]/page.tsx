"use client";

import { useParams } from "next/navigation";
import { approveVersion, getSource, indexVersion, reindexVersion } from "@/lib/api/knowledge";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusPill } from "@/components/ui";
import { HashValue } from "@/components/HashValue";
import { formatTime, sourceTrustState } from "@/lib/format";
import { useAsync } from "@/lib/useAsync";
import { useSession } from "@/lib/session";
import { can } from "@/lib/permissions";
import { CoreApiError } from "@/lib/api/client";
import { useState } from "react";

export default function SourcePage() {
  const params = useParams<{ id: string }>();
  const { me } = useSession();
  const detail = useAsync(() => getSource(params.id), [params.id]);
  const [error, setError] = useState<CoreApiError | null>(null);
  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await detail.reload();
    } catch (err) {
      setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "action failed", 500));
    }
  }
  const source = detail.data?.source;
  return (
    <div>
      <PageHeader title={source?.title ?? "Source"} description="Version history. Only approved versions carry an Approved indicator." />
      {detail.loading ? <LoadingState /> : null}
      {detail.error ? (
        <ErrorState message={detail.error.message} requestId={detail.error.requestId} onRetry={() => void detail.reload()} />
      ) : null}
      {error ? <ErrorState message={error.message} requestId={error.requestId} /> : null}
      {detail.data?.versions.length === 0 ? (
        <EmptyState title="No versions" body="Upload a file to this source." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Version</th>
              <th>State</th>
              <th>Type</th>
              <th>Hash</th>
              <th>Parser</th>
              <th>Effective</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {detail.data?.versions.map((v) => {
              const state = sourceTrustState(v);
              return (
                <tr key={v.id}>
                  <td>{v.version_number}</td>
                  <td>
                    <StatusPill label={state} tone={state === "Approved" ? "ok" : state === "Indexed" ? "accent" : "neutral"} />
                  </td>
                  <td>{v.mime_type}</td>
                  <td>
                    <HashValue value={v.content_hash} label="content hash" />
                  </td>
                  <td className="font-mono text-xs">{v.parser_version ?? "—"}</td>
                  <td>{formatTime(v.effective_at ?? v.created_at)}</td>
                  <td className="space-x-2">
                    {can(me?.permissions, "knowledge.approve") && !v.approved_at ? (
                      <button type="button" className="btn" onClick={() => void act(() => approveVersion(v.id))}>
                        Approve
                      </button>
                    ) : null}
                    {can(me?.permissions, "knowledge.manage") && !v.indexed ? (
                      <button type="button" className="btn" onClick={() => void act(() => indexVersion(v.id))}>
                        Index
                      </button>
                    ) : null}
                    {can(me?.permissions, "knowledge.manage") && v.indexed ? (
                      <button type="button" className="btn" onClick={() => void act(() => reindexVersion(v.id))}>
                        Reindex
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
