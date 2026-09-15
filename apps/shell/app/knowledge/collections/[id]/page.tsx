"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { getCollection, uploadSource } from "@/lib/api/knowledge";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusPill } from "@/components/ui";
import { useAsync } from "@/lib/useAsync";
import { CoreApiError } from "@/lib/api/client";
import { formatTime } from "@/lib/format";
import { KnowledgeLegend } from "@/components/KnowledgeLegend";

export default function CollectionPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const detail = useAsync(() => getCollection(id), [id]);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<CoreApiError | null>(null);
  async function onUpload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    try {
      await uploadSource(id, file, title || file.name);
      setTitle("");
      setFile(null);
      await detail.reload();
    } catch (err) {
      setError(err instanceof CoreApiError ? err : new CoreApiError("REQUEST_FAILED", "upload failed", 500));
    }
  }
  const collection = detail.data?.collection;
  return (
    <div>
      <PageHeader
        title={collection?.name ?? "Collection"}
        description="Sources in this collection. Only approved versions are trusted institutional evidence."
      />
      <KnowledgeLegend />
      {detail.loading ? <LoadingState /> : null}
      {detail.error ? (
        <ErrorState message={detail.error.message} requestId={detail.error.requestId} onRetry={() => void detail.reload()} />
      ) : null}
      {collection ? (
        <p className="mb-4 text-sm text-muted">
          Classification {collection.classification}
        </p>
      ) : null}
      {collection?.can_manage ? (
        <form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={(e) => void onUpload(e)}>
          <label className="field">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            File (PDF, DOCX, TXT, Markdown, HTML)
            <input
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown,.html,text/plain,text/markdown,text/html,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
          </label>
          <button className="btn btn-primary" type="submit">Upload</button>
        </form>
      ) : null}
      {error ? <ErrorState message={error.message} requestId={error.requestId} /> : null}
      {detail.data?.sources.length === 0 ? (
        <EmptyState title="No sources" body="Upload a document to begin. Upload is not approval." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Title</th>
              <th>Versions</th>
              <th>Approved</th>
              <th>Indexed chunks</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {detail.data?.sources.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link className="underline" href={`/knowledge/sources/${s.id}`}>
                    {s.title}
                  </Link>
                </td>
                <td>{s.version_count}</td>
                <td>
                  <StatusPill
                    label={
                      s.approved_versions > 0 ? "Approved" : s.indexed_chunks > 0 ? "Indexed" : "Uploaded"
                    }
                    tone={s.approved_versions > 0 ? "ok" : s.indexed_chunks > 0 ? "accent" : "neutral"}
                  />
                </td>
                <td>{s.indexed_chunks}</td>
                <td>{formatTime(s.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
