"use client";

export function KnowledgeLegend() {
  return (
    <p className="mb-4 max-w-3xl text-sm text-muted">
      <strong className="font-medium text-ink">Uploaded</strong> = file stored.{" "}
      <strong className="font-medium text-ink">Indexed</strong> = searchable.{" "}
      <strong className="font-medium text-ink">Approved</strong> = trusted institutional evidence. These stages stay
      separate.
    </p>
  );
}
