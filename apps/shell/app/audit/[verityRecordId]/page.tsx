"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { exportEvidence, getGraph, getRecord, verifyRecord } from "@/lib/api/audit";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, StatusPill } from "@/components/ui";
import { HashValue } from "@/components/HashValue";
import { eventLabel, formatTime } from "@/lib/format";
import { useAsync } from "@/lib/useAsync";
import { useSession } from "@/lib/session";
import { can } from "@/lib/permissions";
import { CoreApiError } from "@/lib/api/client";
import type { VerifyResult } from "@/lib/api/types";

export default function RecordPage() {
  const params = useParams<{ verityRecordId: string }>();
  const id = params.verityRecordId;
  const { me } = useSession();
  const record = useAsync(() => getRecord(id), [id]);
  const graph = useAsync(() => getGraph(id), [id]);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const events = graph.data?.graph.nodes ?? [];

  return (
    <div>
      <PageHeader
        title="Verity Record"
        actions={
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void verifyRecord(id)
                  .then(setVerify)
                  .catch((err) =>
                    setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "verify failed", 500))
                  )
              }
            >
              Verify Record
            </button>
            {can(me?.permissions, "audit.export") ? (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void exportEvidence()
                    .then(({ filename, json }) => {
                      const blob = new Blob([json], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = filename;
                      a.click();
                      URL.revokeObjectURL(url);
                    })
                    .catch((err) =>
                      setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "export failed", 500))
                    )
                }
              >
                Export organization evidence
              </button>
            ) : null}
          </>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-muted">
        Integrity verification confirms that recorded evidence has not changed. Provenance shows the recorded path that
        produced the result. Neither proves factual truth. Do not read these labels as Fact Verified or Truth Verified.
      </p>
      {record.loading ? <LoadingState /> : null}
      {record.error ? (
        <ErrorState message={record.error.message} requestId={record.error.requestId} onRetry={() => void record.reload()} />
      ) : null}
      {error ? <ErrorState message={error.message} requestId={error.requestId} /> : null}
      {verify ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <StatusPill label={verify.integrity_label} tone={verify.integrity_verified ? "ok" : "danger"} />
          <StatusPill label={verify.provenance_label} tone={verify.provenance_verified ? "ok" : "warn"} />
          {!verify.integrity_verified ? (
            <span className="text-sm text-danger">
              Verification failed
              {verify.issues?.length
                ? `: ${verify.issues.map((issue) => (typeof issue === "string" ? issue : issue.code ?? issue.message)).join(", ")}`
                : ""}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="mb-4 flex gap-2">
          <StatusPill label="Not Verified" />
          <StatusPill
            label={
              record.data?.provenance_status === "linked"
                ? "Linked"
                : record.data?.provenance_status === "unlinked"
                  ? "Unlinked"
                  : "Not Verified"
            }
          />
        </div>
      )}
      {record.data ? (
        <dl className="mb-6 grid gap-3 text-sm md:grid-cols-2">
          <Field label="Verity Record ID" value={record.data.verity_record_id} mono />
          <Field label="Execution ID" value={record.data.execution_id} mono />
          <Field label="Actor" value={record.data.actor_name || record.data.actor_email || record.data.actor} />
          <Field label="Skill" value={record.data.skill} />
          <Field label="Risk" value={record.data.risk} />
          <Field label="Status" value={record.data.status} />
          <Field label="Policy version" value={String(record.data.policy_version ?? "—")} />
          <div>
            <dt className="text-muted">Execution graph hash</dt>
            <dd>
              <HashValue value={record.data.execution_graph_hash} label="graph hash" />
            </dd>
          </div>
          <div>
            <dt className="text-muted">Ledger entry hash</dt>
            <dd>
              <HashValue
                value={
                  record.data.final_ledger_entry && typeof record.data.final_ledger_entry === "object"
                    ? String((record.data.final_ledger_entry as { entry_hash?: string }).entry_hash ?? "")
                    : ""
                }
                label="entry hash"
              />
            </dd>
          </div>
        </dl>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="text-sm font-semibold">Knowledge provenance</h2>
          <pre className="mt-2 overflow-auto font-mono text-xs">{JSON.stringify(record.data?.knowledge_provenance, null, 2) ?? "null"}</pre>
        </Panel>
        <Panel>
          <h2 className="text-sm font-semibold">Model provenance</h2>
          <pre className="mt-2 overflow-auto font-mono text-xs">{JSON.stringify(record.data?.model_provenance, null, 2) ?? "null"}</pre>
        </Panel>
        <Panel>
          <h2 className="text-sm font-semibold">Approval evidence</h2>
          <pre className="mt-2 overflow-auto font-mono text-xs">{JSON.stringify(record.data?.approval_summary, null, 2) ?? "null"}</pre>
        </Panel>
        <Panel>
          <h2 className="text-sm font-semibold">Connector / action evidence</h2>
          <pre className="mt-2 overflow-auto font-mono text-xs">{JSON.stringify(record.data?.connector_evidence, null, 2) ?? "null"}</pre>
        </Panel>
      </div>
      <Panel className="mt-4">
        <h2 className="text-sm font-semibold">Execution Graph V2</h2>
        {graph.loading ? <LoadingState label="Loading graph" /> : null}
        {graph.error ? (
          <ErrorState message={graph.error.message} requestId={graph.error.requestId} onRetry={() => void graph.reload()} />
        ) : null}
        {Array.isArray(events) && events.length === 0 ? (
          <EmptyState title="No events" body="This record has no graph events." />
        ) : (
          <ol className="mt-3 space-y-2">
            {(events as Array<Record<string, unknown>>).map((event, index) => {
              const type = String(event.event_type ?? event.type ?? "event");
              const key = String(event.event_id ?? event.id ?? index);
              return (
                <li key={key}>
                  <button type="button" className="w-full border border-line px-3 py-2 text-left text-sm" onClick={() => setSelected(key)}>
                    <span className="font-medium">{eventLabel(type)}</span>
                    <span className="ml-2 text-muted">{String(event.status ?? "")}</span>
                    <span className="ml-2 text-xs text-muted">{formatTime(String(event.occurred_at_canonical ?? event.occurred_at ?? event.created_at ?? ""))}</span>
                  </button>
                  {selected === key ? (
                    <pre className="mt-1 overflow-auto bg-paper p-3 font-mono text-xs">{JSON.stringify(event.metadata ?? event, null, 2)}</pre>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{value || "—"}</dd>
    </div>
  );
}
