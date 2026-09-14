import { describe, expect, it } from "vitest";
import { chunkText, embedText, reciprocalRankFusion, sha256Text } from "../src/hashing.js";
import { extractText, stripHtml } from "../src/extract.js";

describe("knowledge hashing and chunking", () => {
  it("hashes file bytes deterministically", () => {
    expect(sha256Text("hello")).toBe(sha256Text("hello"));
    expect(sha256Text("hello")).not.toBe(sha256Text("Hello"));
    expect(sha256Text("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("chunks reproducibly", () => {
    const text = "Alpha paragraph.\n\nBeta paragraph is a bit longer than the first.";
    expect(chunkText(text)).toEqual(chunkText(text));
    expect(chunkText(text)[0].chunkIndex).toBe(0);
    expect(chunkText(text)[0].textHash).toBe(sha256Text(chunkText(text)[0].text));
  });

  it("builds a deterministic embedding and RRF merge", () => {
    const a = embedText("capital of France Paris");
    const b = embedText("capital of France Paris");
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    const fused = reciprocalRankFusion([
      [
        { id: "c1", rank: 1 },
        { id: "c2", rank: 2 },
      ],
      [
        { id: "c2", rank: 1 },
        { id: "c1", rank: 2 },
      ],
    ]);
    expect(fused.get("c1")).toBeCloseTo(fused.get("c2") ?? 0);
  });

  it("extracts html, markdown, and text", async () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
    expect(await extractText("text/plain", Buffer.from("plain"))).toBe("plain");
    expect(await extractText("text/markdown", Buffer.from("# Title"))).toBe("# Title");
  });
});
