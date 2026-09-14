import { deflateSync } from "node:zlib";

export function flateTextPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = Buffer.from(`BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET\n`, "latin1");
  const compressed = deflateSync(stream);
  const objects: Buffer[] = [];
  const add = (n: number, body: Buffer) => {
    objects[n] = Buffer.concat([
      Buffer.from(`${n} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
  };
  add(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  add(2, Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1"));
  add(
    3,
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "latin1"
    )
  );
  add(4, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1"));
  add(
    5,
    Buffer.concat([
      Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      compressed,
      Buffer.from("\nendstream", "latin1"),
    ])
  );
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const parts: Buffer[] = [header];
  const offsets = [0];
  let offset = header.length;
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = offset;
    parts.push(objects[i]);
    offset += objects[i].length;
  }
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const xrefBuf = Buffer.from(xref, "latin1");
  const trailer = Buffer.from(
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    "latin1"
  );
  return Buffer.concat([...parts, xrefBuf, trailer]);
}
