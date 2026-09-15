import { api } from "./client";
import type { Collection, SourceVersion } from "./types";

export function listCollections() {
  return api<{ collections: Collection[] }>("/v1/knowledge/collections");
}

export function createCollection(name: string, classification: string) {
  return api<{ collection_id: string }>("/v1/knowledge/collections", {
    method: "POST",
    body: JSON.stringify({ name, classification }),
  });
}

export function getCollection(id: string) {
  return api<{
    collection: Collection & { can_read: boolean; can_manage: boolean; can_approve: boolean };
    sources: Array<{
      id: string;
      title: string;
      created_at: string;
      version_count: number;
      approved_versions: number;
      indexed_chunks: number;
    }>;
  }>(`/v1/knowledge/collections/${encodeURIComponent(id)}`);
}

export function uploadSource(collectionId: string, file: File, title: string) {
  const body = new FormData();
  body.set("title", title);
  body.set("file", file);
  return api<{ source_id: string; version_id: string; version_number: number; content_hash: string }>(
    `/v1/knowledge/collections/${encodeURIComponent(collectionId)}/sources`,
    { method: "POST", body }
  );
}

export function getSource(id: string) {
  return api<{
    source: { id: string; collection_id: string; title: string; created_by: string; created_at: string };
    versions: SourceVersion[];
    collection_id: string;
  }>(`/v1/knowledge/sources/${encodeURIComponent(id)}`);
}

export function approveVersion(versionId: string) {
  return api<{ ok: boolean }>(`/v1/knowledge/versions/${encodeURIComponent(versionId)}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function indexVersion(versionId: string) {
  return api<{ chunk_count?: number }>(`/v1/knowledge/versions/${encodeURIComponent(versionId)}/index`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function reindexVersion(versionId: string) {
  return api<{ chunk_count?: number }>(`/v1/knowledge/versions/${encodeURIComponent(versionId)}/reindex`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
