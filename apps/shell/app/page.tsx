"use client";

import Link from "next/link";
import { getHomeSummary } from "@/lib/api/auth";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, StatusPill } from "@/components/ui";
import { formatTime } from "@/lib/format";
import { skillLabel } from "@/lib/operator-display";
import { useAsync } from "@/lib/useAsync";

export default function HomePage() {
  const { data, error, loading, reload } = useAsync(() => getHomeSummary(), []);
  return (
    <div>
      <PageHeader title="Home" description="Operational overview from Core. Empty values mean this organization has no records yet." />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error.message} requestId={error.requestId} onRetry={() => void reload()} /> : null}
      {data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Panel>
            <p className="text-xs uppercase tracking-wide text-muted">System</p>
            <div className="mt-2 flex items-center gap-2">
              <StatusPill label={data.system.status} tone={data.system.status === "healthy" ? "ok" : "warn"} />
              <span className="text-sm text-muted">{data.system.database ? "Database connected" : "Database unavailable"}</span>
            </div>
          </Panel>
          <Panel>
            <p className="text-xs uppercase tracking-wide text-muted">Knowledge</p>
            <p className="mt-2 text-2xl font-semibold">{data.knowledge.approved_sources}</p>
            <p className="text-sm text-muted">{data.knowledge.collections} collections · approved sources only</p>
          </Panel>
          <Panel>
            <p className="text-xs uppercase tracking-wide text-muted">Approvals</p>
            <p className="mt-2 text-2xl font-semibold">{data.approvals.pending}</p>
            <p className="text-sm text-muted">pending</p>
          </Panel>
          <Panel>
            <p className="text-xs uppercase tracking-wide text-muted">Nova</p>
            <p className="mt-2 text-2xl font-semibold">{data.nova.enabled_skills}</p>
            <p className="text-sm text-muted">enabled skill policies</p>
          </Panel>
          <Panel>
            <p className="text-xs uppercase tracking-wide text-muted">Models</p>
            <p className="mt-2 text-2xl font-semibold">{data.models.available}</p>
            <p className="text-sm text-muted">{data.models.total} registered</p>
          </Panel>
          <Panel>
            <p className="text-xs uppercase tracking-wide text-muted">Connectors</p>
            <p className="mt-2 text-2xl font-semibold">{data.connectors.enabled}</p>
            <p className="text-sm text-muted">{data.connectors.configured} configured</p>
          </Panel>
          <Panel className="md:col-span-2 xl:col-span-3">
            <p className="text-xs uppercase tracking-wide text-muted">Audit</p>
            <p className="mt-2 text-sm">
              Latest Audit sequence {data.audit.latest_chain_sequence ?? "none"}
            </p>
            {data.audit.recent_records.length === 0 ? (
              <EmptyState title="No Verity Records" body="Records appear after governed Nova or Knowledge work." />
            ) : (
              <table className="data mt-3">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Record</th>
                    <th>Skill</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.audit.recent_records.map((row) => (
                    <tr key={row.execution_id}>
                      <td>{formatTime(row.started_at)}</td>
                      <td className="font-mono text-xs">
                        {row.verity_record_id ? (
                          <Link className="underline" href={`/audit/${row.verity_record_id}`}>
                            {row.verity_record_id.slice(0, 8)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{skillLabel(row.skill_id)}</td>
                      <td className="capitalize">{row.status}</td>
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
