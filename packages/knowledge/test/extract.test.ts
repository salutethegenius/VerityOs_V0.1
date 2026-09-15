import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractText, stripHtml } from "../src/extract.js";
import { assertDocx, assertPdf, assertUpload, sniffMime } from "../src/storage.js";
import { flateTextPdf } from "./pdf-fixture.js";

async function minimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("native extractors and MIME validation", () => {
  it("extracts text from a FlateDecode PDF content stream", async () => {
    const phrase = "The capital of France is Paris";
    const pdf = flateTextPdf(phrase);
    expect(pdf.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(pdf.includes(Buffer.from(phrase))).toBe(false);
    const text = await extractText("application/pdf", pdf);
    expect(text).toContain("capital of France");
    expect(text).toContain("Paris");
  });

  it("extracts DOCX native text", async () => {
    const bytes = await minimalDocx("The capital of France is Paris");
    const text = await extractText(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes
    );
    expect(text).toContain("The capital of France is Paris");
  });

  it("extracts html, markdown, and text", async () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
    expect(await extractText("text/plain", Buffer.from("plain"))).toBe("plain");
    expect(await extractText("text/markdown", Buffer.from("# Title"))).toBe("# Title");
  });

  it("rejects extension-only PDF and DOCX uploads", () => {
    expect(() => sniffMime("report.pdf", Buffer.from("not a pdf"))).toThrow(/match extension/);
    expect(() => sniffMime("memo.docx", Buffer.from("not a zip"))).toThrow(/match extension/);
  });

  it("requires PDF signature and EOF", () => {
    expect(() => assertPdf(Buffer.from("%PDF-1.4 without eof"))).toThrow(/valid PDF/);
    const pdf = flateTextPdf("Hello from a compressed PDF stream about Paris");
    expect(() => assertPdf(pdf)).not.toThrow();
    expect(sniffMime("facts.pdf", pdf)).toBe("application/pdf");
  });

  it("requires DOCX ZIP structure with document.xml", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "no office parts");
    const bogus = await zip.generateAsync({ type: "nodebuffer" });
    expect(() => assertDocx(bogus)).toThrow(/valid DOCX/);
    const real = await minimalDocx("institutional policy text");
    expect(() => assertDocx(real)).not.toThrow();
    expect(sniffMime("policy.docx", real)).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  it("rejects oversized uncompressed DOCX listings", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document/>");
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    const inflated = Buffer.from(bytes);
    const eocd = inflated.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cdOffset = inflated.readUInt32LE(eocd + 16);
    inflated.writeUInt32LE(0xffffffff, cdOffset + 20);
    expect(() => assertDocx(inflated)).toThrow(/uncompressed size/);
  });

  it("rejects NUL bytes in text uploads and preserves the 10 MB cap", () => {
    expect(() => assertUpload(Buffer.from("ok\0bad"), "text/plain")).toThrow(/NUL/);
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 65);
    expect(() => assertUpload(huge, "text/plain")).toThrow(/size limit/);
  });

  it("rejects path-traversal filenames", () => {
    expect(() => sniffMime("../etc/passwd.txt", Buffer.from("plain"))).toThrow(/invalid filename/);
    expect(() => sniffMime("foo/bar.md", Buffer.from("# x"))).toThrow(/invalid filename/);
  });

  it("strips script and style from HTML before indexing text", async () => {
    const html = "<html><script>secret()</script><style>p{}</style><p>Public advisory</p></html>";
    expect(stripHtml(html)).toBe("Public advisory");
    expect(await extractText("text/html", Buffer.from(html))).toBe("Public advisory");
  });
});
