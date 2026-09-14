export { KnowledgeError } from "./errors.js";
export {
  canApprove,
  canManage,
  canRead,
  collectionIdForSource,
  collectionIdForVersion,
  collectionIdsForRetrievalRun,
  getCollectionPermission,
  listReadableCollections,
  requireCollectionPermission,
  type CollectionCapability,
  type CollectionPermission,
} from "./acl.js";
export {
  PRODUCTION_EMBEDDING_DIMENSIONS,
  MockEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  embeddingProviderFromEnv,
  type EmbeddingProvider,
} from "./embed.js";
export {
  MAX_DOCX_FILES,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  MAX_UPLOAD_BYTES,
  PARSER_VERSION,
  assertDocx,
  assertPdf,
  assertSafeFilename,
  assertSafeText,
  assertUpload,
  blobPath,
  dataDir,
  sniffMime,
  writeBlob,
  readBlob,
} from "./storage.js";
export { extractText, stripHtml } from "./extract.js";
export {
  EMBEDDING_DIM,
  chunkText,
  embedText,
  reciprocalRankFusion,
  sha256Bytes,
  sha256Text,
  vectorLiteral,
  type Chunk,
} from "./hashing.js";
export {
  approveSourceVersion,
  createCollection,
  indexSourceVersion,
  uploadSourceVersion,
} from "./ingest.js";
export { retrieve } from "./retrieve.js";
