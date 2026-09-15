"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { createCollection, listCollections } from "@/lib/api/knowledge";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusPill } from "@/components/ui";
import { KnowledgeLegend } from "@/components/KnowledgeLegend";
import { useAsync } from "@/lib/useAsync";
import { useSession } from "@/lib/session";
import { can } from "@/lib/permissions";
import { CoreApiError } from "@/lib/api/client";

export default function KnowledgePage() {
  const { me } = useSession();
  const list = useAsync(() => listCollections(), []);
  const [name, setName] = useState("");
  const [classification, setClassification] = useState("internal");
  const [error, setError] = useState<CoreApiError | null>(null);
  async function onCreate(event: FormEvent) {
    event.preventDefault();
    try {
      await createCollection(name, classification);
      setName("");
      await list.reload();
    } catch (err) {
      setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "create failed", 500));
    }
  }
  return (
    <div>
      <PageHeader title="Knowledge" description="Collections and sources. Upload, index, and approve remain separate operator actions." />
      <KnowledgeLegend />
      {can(me?.permissions, "knowledge.manage") ? (
        <form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={(e) => void onCreate(e)}>
          <label className="field">
            Collection name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            Classification
            <select value={classification} onChange={(e) => setClassification(e.target.value)}>
              <option value="public">public</option>
              <option value="internal">internal</option>
              <option value="confidential">confidential</option>
              <option value="restricted">restricted</option>
            </select>
          </label>
          <button className="btn btn-primary" type="submit">Create</button>
        </form>
      ) : null}
      {error ? <ErrorState message={error.message} requestId={error.requestId} /> : null}
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error.message} requestId={list.error.requestId} onRetry={() => void list.reload()} /> : null}
      {list.data?.collections.length === 0 ? (
        <EmptyState title="No collections" body="Create a collection or ask an administrator for read access." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Classification</th>
              <th>Sources</th>
              <th>Permissions</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.collections.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link className="underline" href={`/knowledge/collections/${c.id}`}>
                    {c.name}
                  </Link>
                </td>
                <td>{c.classification}</td>
                <td>{c.source_count ?? "—"}</td>
                <td className="space-x-1">
                  {c.can_read ? <StatusPill label="read" /> : null}
                  {c.can_manage ? <StatusPill label="manage" /> : null}
                  {c.can_approve ? <StatusPill label="approve" /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
