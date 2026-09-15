# Verity Knowledge

Native RAG. Open WebUI is not the source of truth.

Sources are immutable: a `source` is the logical document; each `source_version` is a historical revision with `content_hash`, blob URI, parser version, and optional approval. Chunks are derived from a version and are not overwritten.

## Authorization

Global RBAC (`knowledge.read` / `knowledge.manage` / `knowledge.approve`) is the coarse layer. Collection ACL is authoritative and is the second layer:

- `can_read` — list the collection, read sources, retrieve, read retrieval runs
- `can_manage` — upload source versions and index
- `can_approve` — approve a source version

A role with global `knowledge.read` but no `can_read` grant must not discover or read that collection. Helpers: `canRead`, `canManage`, `canApprove`.

## Approval and modes

Normal retrieval (`strict`, `grounded`, and `general`) uses **approved** source versions only. `general` means generation may later use model background knowledge; it does **not** authorize unapproved institutional sources. Previewing an unapproved version is a later, explicitly authorized management capability and is not overloaded onto `KnowledgeMode`.

Strict mode still returns `insufficient_evidence` when keyword evidence is missing.

## Provenance

`knowledge.retrieval_hits` may record `retrieved`, `ranked`, and `returned_to_caller`. `included_in_context` stays false until Core constructs the governed model prompt from verified chunks of that retrieval run (Phase 7). Returning a hit from Knowledge is not inclusion in context. Nova must not mark arbitrary chunks as included.

If existing chunks were created under a different `embedding_provider_key`, `indexSourceVersion` returns `REINDEX_REQUIRED` (409). It does not silently delete or rebuild embeddings. `reindexSourceVersion` is the explicit authorized rebuild.

## Embeddings (V0.1)

The pgvector column is `vector(768)` — the V0.1 production slot, matching common local models such as `nomic-embed-text`.

| Provider | When | Semantic? |
| --- | --- | --- |
| `MockEmbeddingProvider` (`key=mock`) | CI and default | No. Deterministic token hashing into 768 dimensions. |
| `OpenAICompatibleEmbeddingProvider` | Hummingbird local embedding service via `VERITY_EMBEDDING_URL` | Yes, if the local model is. No external API required. |

Persist `embedding_provider_key` and `embedding_dimensions` on chunks and retrieval runs. Retrieval only searches chunks that match the active provider and dimension.

**Reindex / version strategy:** changing the production dimension or introducing a second vector slot requires a new migration (replace or add a pgvector column and HNSW index) and a reindex of source versions. Historical chunks remain; they are simply not selected until reindexed into the active slot. Do not download large embedding models in CI; leave `VERITY_EMBEDDING_PROVIDER=mock`.

## Extraction

PDF text uses **pdfjs-dist** (legacy Node build, worker disabled). This is native-text extraction of decoded content streams, including FlateDecode — not OCR. DOCX uses JSZip with ZIP central-directory caps (file count and uncompressed size) before inflation. MIME sniffing requires a PDF signature (`%PDF-` + `%%EOF`) or a ZIP/Office DOCX structure; a `.pdf`/`.docx` filename is not enough. Upload cap remains 10 MB.

Blobs live under `VERITY_DATA_DIR`.
