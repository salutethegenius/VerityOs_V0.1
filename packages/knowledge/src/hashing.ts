import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

export const EMBEDDING_DIM = 768;

export function sha256Bytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function sha256Text(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}

export interface Chunk {
  chunkIndex: number;
  text: string;
  textHash: string;
  tokenCount: number;
  pageNumber: number | null;
  section: string | null;
}

export function chunkText(text: string, maxChars = 500): Chunk[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const paragraphs = normalized.split(/\n{2,}/);
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    const clean = paragraph.replace(/\s+/g, " ").trim();
    if (!clean) {
      continue;
    }
    if (clean.length <= maxChars) {
      pieces.push(clean);
      continue;
    }
    let remaining = clean;
    while (remaining.length > maxChars) {
      let split = remaining.lastIndexOf(" ", maxChars);
      if (split < maxChars / 2) {
        split = maxChars;
      }
      pieces.push(remaining.slice(0, split).trim());
      remaining = remaining.slice(split).trim();
    }
    if (remaining) {
      pieces.push(remaining);
    }
  }
  return pieces.map((piece, index) => ({
    chunkIndex: index,
    text: piece,
    textHash: sha256Text(piece),
    tokenCount: piece.split(/\s+/).filter(Boolean).length,
    pageNumber: null,
    section: null,
  }));
}

export function embedText(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  for (const token of tokens) {
    const digest = sha256(new TextEncoder().encode(token));
    const bucket = digest[0] % EMBEDDING_DIM;
    const sign = digest[1] % 2 === 0 ? 1 : -1;
    vector[bucket] += sign * (1 + (digest[2] / 255));
  }
  let norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    norm = 1;
  }
  return vector.map((v) => v / norm);
}

export function vectorLiteral(values: number[]): string {
  return `[${values.map((v) => v.toFixed(8)).join(",")}]`;
}

export function reciprocalRankFusion(
  ranked: Array<{ id: string; rank: number; weight?: number }>[],
  k = 60
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of ranked) {
    for (const item of list) {
      const add = (item.weight ?? 1) / (k + item.rank);
      scores.set(item.id, (scores.get(item.id) ?? 0) + add);
    }
  }
  return scores;
}
