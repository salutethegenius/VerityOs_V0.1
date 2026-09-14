import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const PARSER_VERSION = "verity-knowledge-0.1";

const ALLOWED_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export function dataDir(): string {
  const root = process.env.VERITY_DATA_DIR ?? "./data";
  return resolve(root);
}

export function blobPath(organizationId: string, versionId: string): string {
  return join(dataDir(), "blobs", organizationId, versionId);
}

export function assertSafeFilename(name: string): void {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("invalid filename");
  }
}

export function sniffMime(filename: string, bytes: Buffer): string {
  assertSafeFilename(filename);
  const lower = filename.toLowerCase();
  if (bytes.subarray(0, 5).toString("utf8") === "%PDF-") {
    return "application/pdf";
  }
  if (bytes.subarray(0, 2).toString("utf8") === "PK" && lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "text/markdown";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "text/html";
  }
  if (lower.endsWith(".txt")) {
    return "text/plain";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  throw new Error("unsupported file type");
}

export function assertUpload(bytes: Buffer, mime: string): void {
  if (bytes.length === 0) {
    throw new Error("empty upload");
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error("upload exceeds size limit");
  }
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error("unsupported file type");
  }
}

export async function writeBlob(
  organizationId: string,
  versionId: string,
  bytes: Buffer
): Promise<string> {
  const path = blobPath(organizationId, versionId);
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  await writeFile(path, bytes, { mode: 0o640 });
  return `file://${path}`;
}

export async function readBlob(uri: string): Promise<Buffer> {
  if (!uri.startsWith("file://")) {
    throw new Error("unsupported blob uri");
  }
  return readFile(uri.slice("file://".length));
}
