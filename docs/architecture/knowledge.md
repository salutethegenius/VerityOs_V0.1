# Verity Knowledge

Native RAG. Open WebUI is not the source of truth.

Sources are immutable: a `source` is the logical document; each `source_version` is a historical revision with `content_hash`, blob URI, parser version, and optional approval. Chunks are derived from a version and are not overwritten.

Retrieval is hybrid (pgvector cosine + Postgres FTS) merged with reciprocal rank fusion. Strict mode returns `insufficient_evidence` when keyword evidence is missing. Provenance is stored on `knowledge.retrieval_runs` / `knowledge.retrieval_hits` (including `included_in_context`).

Blobs live under `VERITY_DATA_DIR`. The default embedding is a local/mock vector; external embedding APIs are optional adapters, not dependencies.
