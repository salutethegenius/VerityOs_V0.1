import JSZip from "jszip";
import { KnowledgeError } from "./errors.js";
import { MAX_DOCX_FILES, MAX_DOCX_UNCOMPRESSED_BYTES } from "./storage.js";

export const PARSER_TIMEOUT_MS = 15_000;
export const MAX_PDF_PAGES = 75;

async function withTimeout<T>(work: Promise<T>, ms = PARSER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new KnowledgeError("PARSER_TIMEOUT", "parser timed out", 400)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function extractText(mime: string, bytes: Buffer): Promise<string> {
  switch (mime) {
    case "text/plain":
    case "text/markdown":
      return bytes.toString("utf8");
    case "text/html":
      return stripHtml(bytes.toString("utf8"));
    case "application/pdf":
      return withTimeout(extractPdf(bytes));
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return withTimeout(extractDocx(bytes));
    default:
      throw new KnowledgeError("UNSUPPORTED_TYPE", "unsupported file type", 400);
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPdf(bytes: Buffer): Promise<string> {
  const pdfjs = await loadPdfJs();
  const data = Uint8Array.from(bytes);
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    stopAtErrors: false,
  });
  const pdf = await loadingTask.promise;
  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new KnowledgeError("INVALID_PDF", "PDF exceeds page limit", 400);
    }
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: { str?: string }) => (typeof item.str === "string" ? item.str : ""))
        .join(" ");
      pages.push(text);
    }
    const combined = pages.join("\n").replace(/\s+/g, " ").trim();
    if (combined.length < 1) {
      throw new KnowledgeError("NATIVE_TEXT_UNAVAILABLE", "NATIVE_TEXT_UNAVAILABLE", 400);
    }
    return combined;
  } finally {
    await pdf.destroy();
  }
}

async function loadPdfJs(): Promise<{
  getDocument: (params: Record<string, unknown>) => {
    promise: Promise<{
      numPages: number;
      getPage: (n: number) => Promise<{
        getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
      }>;
      destroy: () => Promise<void>;
    }>;
  };
}> {
  return import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<{
    getDocument: (params: Record<string, unknown>) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
        }>;
        destroy: () => Promise<void>;
      }>;
    };
  }>;
}

async function extractDocx(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const names = Object.keys(zip.files);
  if (names.length > MAX_DOCX_FILES) {
    throw new KnowledgeError("INVALID_DOCX", "DOCX contains too many entries", 400);
  }
  let uncompressed = 0;
  for (const file of Object.values(zip.files)) {
    if (file.dir) {
      continue;
    }
    const size = uncompressedSize(file);
    uncompressed += size;
    if (uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new KnowledgeError("INVALID_DOCX", "DOCX uncompressed size exceeds limit", 400);
    }
  }
  const doc = zip.file("word/document.xml");
  if (!doc) {
    throw new KnowledgeError("NATIVE_TEXT_UNAVAILABLE", "NATIVE_TEXT_UNAVAILABLE", 400);
  }
  const xml = await doc.async("string");
  const text = xml
    .replace(/<w:p[\s>]/g, "\n<w:p ")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n+/g, "\n")
    .trim();
  if (text.length < 1) {
    throw new KnowledgeError("NATIVE_TEXT_UNAVAILABLE", "NATIVE_TEXT_UNAVAILABLE", 400);
  }
  return text;
}

function uncompressedSize(file: JSZip.JSZipObject): number {
  const data = (file as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : 0;
}
