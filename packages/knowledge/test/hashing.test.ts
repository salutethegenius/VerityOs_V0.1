import { describe, expect, it } from "vitest";
import { chunkText, embedText, reciprocalRankFusion, sha256Text } from "../src/hashing.js";
import { MockEmbeddingProvider, PRODUCTION_EMBEDDING_DIMENSIONS } from "../src/embed.js";

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

  it("builds a deterministic mock embedding at the production dimension", async () => {
    const provider = new MockEmbeddingProvider();
    expect(provider.key).toBe("mock");
    expect(provider.dimensions).toBe(PRODUCTION_EMBEDDING_DIMENSIONS);
    expect(PRODUCTION_EMBEDDING_DIMENSIONS).toBe(768);
    const [a] = await provider.embed(["capital of France Paris"]);
    const [b] = await provider.embed(["capital of France Paris"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(768);
    expect(embedText("capital of France Paris")).toHaveLength(768);
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
});
