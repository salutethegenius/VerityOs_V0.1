import { EMBEDDING_DIM, embedText } from "./hashing.js";

export const PRODUCTION_EMBEDDING_DIMENSIONS = EMBEDDING_DIM;

export interface EmbeddingProvider {
  readonly key: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly key = "mock";
  readonly dimensions = PRODUCTION_EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedText(text));
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly key: string;
  readonly dimensions: number;
  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(input: { url: string; model: string; dimensions?: number; apiKey?: string }) {
    const dimensions = input.dimensions ?? PRODUCTION_EMBEDDING_DIMENSIONS;
    if (dimensions !== PRODUCTION_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `V0.1 pgvector slot is vector(${PRODUCTION_EMBEDDING_DIMENSIONS}); got ${dimensions}`
      );
    }
    this.url = input.url;
    this.model = input.model;
    this.apiKey = input.apiKey;
    this.dimensions = dimensions;
    this.key = `openai-compatible:${input.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`embedding provider HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vectors = (body.data ?? []).map((row) => row.embedding ?? []);
    if (vectors.length !== texts.length) {
      throw new Error("embedding provider returned unexpected count");
    }
    for (const vector of vectors) {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `embedding dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
        );
      }
    }
    return vectors;
  }
}

export function embeddingProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env
): EmbeddingProvider {
  const kind = (env.VERITY_EMBEDDING_PROVIDER ?? "mock").trim().toLowerCase();
  if (kind === "mock" || kind === "") {
    return new MockEmbeddingProvider();
  }
  if (kind === "openai-compatible") {
    const url = env.VERITY_EMBEDDING_URL?.trim();
    const model = env.VERITY_EMBEDDING_MODEL?.trim() || "nomic-embed-text";
    const dimensions = Number(env.VERITY_EMBEDDING_DIMENSIONS ?? PRODUCTION_EMBEDDING_DIMENSIONS);
    if (!url) {
      throw new Error("VERITY_EMBEDDING_URL is required for openai-compatible embeddings");
    }
    return new OpenAICompatibleEmbeddingProvider({
      url,
      model,
      dimensions,
      apiKey: env.VERITY_EMBEDDING_API_KEY ?? env.OPENAI_COMPATIBLE_API_KEY,
    });
  }
  throw new Error(`unknown VERITY_EMBEDDING_PROVIDER: ${kind}`);
}
