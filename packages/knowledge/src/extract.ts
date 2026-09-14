import JSZip from "jszip";

export async function extractText(mime: string, bytes: Buffer): Promise<string> {
  switch (mime) {
    case "text/plain":
    case "text/markdown":
      return bytes.toString("utf8");
    case "text/html":
      return stripHtml(bytes.toString("utf8"));
    case "application/pdf":
      return extractPdf(bytes);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocx(bytes);
    default:
      throw new Error("unsupported file type");
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

function extractPdf(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  const chunks: string[] = [];
  const re = /\((?:\\.|[^\\)])*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const inner = match[0].slice(1, -1);
    const decoded = inner
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\t/g, " ")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
    if (/[A-Za-z]{2,}/.test(decoded)) {
      chunks.push(decoded);
    }
  }
  const text = chunks.join(" ").replace(/\s+/g, " ").trim();
  if (text.length < 20) {
    throw new Error("NATIVE_TEXT_UNAVAILABLE");
  }
  return text;
}

async function extractDocx(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const doc = zip.file("word/document.xml");
  if (!doc) {
    throw new Error("NATIVE_TEXT_UNAVAILABLE");
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
    throw new Error("NATIVE_TEXT_UNAVAILABLE");
  }
  return text;
}
