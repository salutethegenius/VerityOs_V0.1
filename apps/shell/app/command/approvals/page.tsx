"use client";

import Link from "next/link";
import { useState } from "react";
import { listApprovals } from "@/lib/api/command";
import { decideNovaApproval } from "@/lib/api/nova";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusPill } from "@/components/ui";
import { HashValue } from "@/components/HashValue";
import { formatTime } from "@/lib/format";
import { useAsync } from "@/lib/useAsync";
import { useSession } from "@/lib/session";
import { can } from "@/lib/permissions";
import { CoreApiError } from "@/lib/api/client";

const FILTERS = ["pending", "approved", "rejected", "expired"] as const;

export default function ApprovalsPage() {
  const { me } = useSession();
  const [status, setStatus] = useState<string>("pending");
  const list = useAsync(() => listApprovals(status), [status]);
  const [error, setError] = useState<CoreApiError | null>(null);
  return (
    <div>
      <PageHeader title="Approvals" description="Exact artifact linkage. Decisions are executed by Core, not browser state." />
      <div className="mb-4 flex gap-2" role="tablist">
        {FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            className={`btn ${status === filter ? "btn-primary" : ""}`}
            onClick={() => setStatus(filter)}
          >
            {filter}
          </button>
        ))}
      </div>
      {error ? <ErrorState message={error.message} requestId={error.requestId} /> : null}
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {list.data?.approvals.length === 0 ? (
        <EmptyState title="No approvals" body={`No ${status} approvals for this organization.`} />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Skill</th>
              <th>Requester</th>
              <th>Artifact</th>
              <th>Risk</th>
              <th>Created</th>
              <th>Status</th>
              <th>Record</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.approvals.map((row) => (
              <tr key={row.id}>
                <td>{row.skill_id}</td>
                <td className="font-mono text-xs">{row.requested_by}</td>
                <td>
                  <HashValue value={row.artifact_hash} label="artifact hash" />
                </td>
                <td>{row.risk_tier ?? "—"}</td>
                <td>{formatTime(row.created_at)}</td>
                <td>
                  <StatusPill label={row.status} />
                </td>
                <td>
                  {row.verity_record_id ? (
                    <Link className="font-mono text-xs underline" href={`/audit/${row.verity_record_id}`}>
                      {row.verity_record_id.slice(0, 8)}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {row.status === "pending" && can(me?.permissions, "approvals.decide") && row.artifact_hash ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() =>
                          void decideNovaApproval(row.execution_id, row.id, true, row.artifact_hash!)
                            .then(() => list.reload())
                            .catch((err) =>
                              setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "decision failed", 500))
                            )
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() =>
                          void decideNovaApproval(row.execution_id, row.id, false, row.artifact_hash!)
                            .then(() => list.reload())
                            .catch((err) =>
                              setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "decision failed", 500))
                            )
                        }
                      >
                        Reject
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
