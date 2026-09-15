"use client";

import Link from "next/link";
import { useState } from "react";
import { listApprovals } from "@/lib/api/command";
import { decideNovaApproval } from "@/lib/api/nova";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusPill } from "@/components/ui";
import { HashValue } from "@/components/HashValue";
import { ActorLabel } from "@/components/ActorLabel";
import { formatTime } from "@/lib/format";
import { approvalFilterLabel, skillLabel } from "@/lib/operator-display";
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
  const canDecide = can(me?.permissions, "approvals.decide");
  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Exact artifact linkage. Decisions are executed by Core. Hiding a button is not authorization."
      />
      <p className="mb-4 max-w-3xl text-sm text-muted">
        Requesters cannot approve their own request. A different authorized user must decide.
      </p>
      <div className="mb-4 flex gap-2" role="tablist">
        {FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            role="tab"
            aria-selected={status === filter}
            aria-label={`Show ${approvalFilterLabel(filter)} approvals`}
            className={`btn ${status === filter ? "btn-primary" : ""}`}
            onClick={() => setStatus(filter)}
          >
            {approvalFilterLabel(filter)}
          </button>
        ))}
      </div>
      {error ? <ErrorState message={error.message} requestId={error.requestId} /> : null}
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {list.data?.approvals.length === 0 ? (
        <EmptyState title="No approvals" body={`No ${approvalFilterLabel(status).toLowerCase()} approvals for this organization.`} />
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
            {list.data?.approvals.map((row) => {
              const isRequester = me?.user_id === row.requested_by;
              const showButtons = row.status === "pending" && canDecide && Boolean(row.artifact_hash) && !isRequester;
              return (
                <tr key={row.id}>
                  <td>{skillLabel(row.skill_id)}</td>
                  <td>
                    <ActorLabel name={row.requested_by_name} email={row.requested_by_email} id={row.requested_by} />
                  </td>
                  <td>
                    <HashValue value={row.artifact_hash} label="artifact hash" />
                  </td>
                  <td>{row.risk_tier ?? "—"}</td>
                  <td>{formatTime(row.created_at)}</td>
                  <td>
                    <StatusPill label={approvalFilterLabel(row.status)} />
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
                    {row.status === "pending" && isRequester ? (
                      <p className="text-xs text-muted">You cannot approve this request.</p>
                    ) : row.status === "pending" && !canDecide ? (
                      <p className="text-xs text-muted">A different authorized user must approve.</p>
                    ) : row.status === "approved" ? (
                      <p className="text-xs text-muted">
                        Approved by another actor
                        {row.decided_by_name || row.decided_by_email
                          ? `: ${row.decided_by_name ?? row.decided_by_email}`
                          : ""}
                      </p>
                    ) : null}
                    {showButtons ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn btn-primary"
                          data-testid="approval-decide-allow"
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
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
