import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { KnowledgeError } from "./errors.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DOCX_FILES = 128;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
export const PARSER_VERSION = "verity-knowledge-0.2";

const PDF_MAGIC = Buffer.from("%PDF-");
const ZIP_MAGIC = Buffer.from("PK");
const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_LOCATOR_SIG = Buffer.from([0x50, 0x4b, 0x06, 0x07]);
const CENTRAL_DIR_SIG = 0x02014b50;

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
    throw new KnowledgeError("INVALID_FILENAME", "invalid filename", 400);
  }
}

export function sniffMime(filename: string, bytes: Buffer): string {
  assertSafeFilename(filename);
  const lower = filename.toLowerCase();
  if (bytes.subarray(0, 5).equals(PDF_MAGIC)) {
    if (!lower.endsWith(".pdf")) {
      throw new KnowledgeError("UNSUPPORTED_TYPE", "unsupported file type", 400);
    }
    return "application/pdf";
  }
  if (bytes.subarray(0, 2).equals(ZIP_MAGIC) && lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".pdf") || lower.endsWith(".docx")) {
    throw new KnowledgeError("INVALID_UPLOAD", "file content does not match extension", 400);
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
  throw new KnowledgeError("UNSUPPORTED_TYPE", "unsupported file type", 400);
}

export function assertUpload(bytes: Buffer, mime: string): void {
  if (bytes.length === 0) {
    throw new KnowledgeError("EMPTY_UPLOAD", "empty upload", 400);
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new KnowledgeError("UPLOAD_TOO_LARGE", "upload exceeds size limit", 400);
  }
  if (!ALLOWED_MIME.has(mime)) {
    throw new KnowledgeError("UNSUPPORTED_TYPE", "unsupported file type", 400);
  }
  if (mime === "application/pdf") {
    assertPdf(bytes);
    return;
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    assertDocx(bytes);
    return;
  }
  assertSafeText(bytes);
}

export function assertPdf(bytes: Buffer): void {
  if (bytes.length < 8 || !bytes.subarray(0, 5).equals(PDF_MAGIC)) {
    throw new KnowledgeError("INVALID_PDF", "file is not a valid PDF", 400);
  }
  const version = bytes.subarray(5, 8).toString("latin1");
  if (!/^\d\.\d$/.test(version)) {
    throw new KnowledgeError("INVALID_PDF", "file is not a valid PDF", 400);
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1");
  if (!tail.includes("%%EOF")) {
    throw new KnowledgeError("INVALID_PDF", "file is not a valid PDF", 400);
  }
}

export function assertDocx(bytes: Buffer): void {
  if (bytes.length < 4 || !bytes.subarray(0, 2).equals(ZIP_MAGIC)) {
    throw new KnowledgeError("INVALID_DOCX", "file is not a valid DOCX document", 400);
  }
  if (bytes.includes(ZIP64_LOCATOR_SIG)) {
    throw new KnowledgeError("INVALID_DOCX", "ZIP64 DOCX is not accepted", 400);
  }
  const listing = inspectZip(bytes);
  if (listing.entries > MAX_DOCX_FILES) {
    throw new KnowledgeError("INVALID_DOCX", "DOCX contains too many entries", 400);
  }
  if (listing.uncompressedTotal > MAX_DOCX_UNCOMPRESSED_BYTES) {
    throw new KnowledgeError("INVALID_DOCX", "DOCX uncompressed size exceeds limit", 400);
  }
  if (!listing.names.has("[Content_Types].xml") || !listing.names.has("word/document.xml")) {
    throw new KnowledgeError("INVALID_DOCX", "file is not a valid DOCX document", 400);
  }
}

export function assertSafeText(bytes: Buffer): void {
  if (bytes.includes(0)) {
    throw new KnowledgeError("INVALID_TEXT", "text uploads must not contain NUL bytes", 400);
  }
}

function inspectZip(bytes: Buffer): { entries: number; uncompressedTotal: number; names: Set<string> } {
  const eocd = findEocd(bytes);
  if (eocd < 0) {
    throw new KnowledgeError("INVALID_DOCX", "file is not a valid DOCX document", 400);
  }
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > bytes.length) {
    throw new KnowledgeError("INVALID_DOCX", "file is not a valid DOCX document", 400);
  }
  const names = new Set<string>();
  let offset = cdOffset;
  let uncompressedTotal = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_DIR_SIG) {
      throw new KnowledgeError("INVALID_DOCX", "file is not a valid DOCX document", 400);
    }
    const uncompressed = bytes.readUInt32LE(offset + 20);
    const nameLen = bytes.readUInt16LE(offset + 28);
    const extraLen = bytes.readUInt16LE(offset + 30);
    const commentLen = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    names.add(name);
    uncompressedTotal += uncompressed;
    if (uncompressedTotal > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new KnowledgeError("INVALID_DOCX", "DOCX uncompressed size exceeds limit", 400);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { entries: entryCount, uncompressedTotal, names };
}

function findEocd(bytes: Buffer): number {
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (
      bytes[i] === EOCD_SIG[0] &&
      bytes[i + 1] === EOCD_SIG[1] &&
      bytes[i + 2] === EOCD_SIG[2] &&
      bytes[i + 3] === EOCD_SIG[3]
    ) {
      return i;
    }
  }
  return -1;
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
    throw new KnowledgeError("UNSUPPORTED_BLOB", "unsupported blob uri", 400);
  }
  return readFile(uri.slice("file://".length));
}
