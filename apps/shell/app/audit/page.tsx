"use client";

import Link from "next/link";
import { listRecords } from "@/lib/api/audit";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui";
import { formatTime, shortHash } from "@/lib/format";
import { actorDisplay, executionStatusLabel, skillLabel } from "@/lib/operator-display";
import { useAsync } from "@/lib/useAsync";

export default function AuditPage() {
  const list = useAsync(() => listRecords(), []);
  return (
    <div>
      <PageHeader
        title="Audit"
        description="Verity Records. Integrity and Provenance labels appear only after you choose Verify Record on a record. They do not mean factual truth."
      />
      <p className="mb-4 max-w-3xl text-sm text-muted">
        This list stays Not Verified until a record is opened and verified. That is intentional.
      </p>
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {list.data?.records.length === 0 ? (
        <EmptyState title="No records" body="Governed executions will appear here." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Time</th>
              <th>Record ID</th>
              <th>Actor</th>
              <th>Skill</th>
              <th>Risk</th>
              <th>Status</th>
              <th>Integrity</th>
              <th>Provenance</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.records.map((row) => (
              <tr key={row.execution_id}>
                <td>{formatTime(row.started_at)}</td>
                <td className="font-mono text-xs">
                  {row.verity_record_id ? (
                    <Link className="underline" href={`/audit/${row.verity_record_id}`}>
                      {shortHash(row.verity_record_id)}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{actorDisplay({ name: row.actor_name, email: row.actor_email, id: row.actor_id })}</td>
                <td>{skillLabel(row.skill_id)}</td>
                <td>{row.risk_tier ?? "—"}</td>
                <td>{executionStatusLabel(row.status)}</td>
                <td>Not Verified</td>
                <td>Not Verified</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
