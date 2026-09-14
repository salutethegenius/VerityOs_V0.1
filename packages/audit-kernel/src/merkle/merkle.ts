/**
 * Merkle tree for organization-scoped ledger checkpoints.
 *
 * Odd-leaf rule (duplicate-last): if a level has an odd node count, the last
 * node is paired with a copy of itself:
 *
 *   parent = SHA256(nodeBytes || nodeBytes)
 *
 * This rule is used in tree construction, proof generation, online
 * verification, and offline verification. Proofs record sibling direction
 * explicitly and never infer order by comparing hex strings.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export type MerklePosition = "left" | "right";

export interface MerkleProofStep {
  sibling_hash: string;
  /** Side the sibling occupies when hashing the parent. */
  position: MerklePosition;
}

export function hashPair(leftHex: string, rightHex: string): string {
  const left = hexToBytes(leftHex);
  const right = hexToBytes(rightHex);
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return bytesToHex(sha256(combined));
}

export function buildMerkleTree(leafHashes: string[]): {
  root: string;
  layers: string[][];
} {
  if (leafHashes.length === 0) {
    const emptyHash = bytesToHex(sha256(new TextEncoder().encode("")));
    return { root: emptyHash, layers: [[emptyHash]] };
  }

  const layers: string[][] = [[...leafHashes]];
  let current = layers[0];
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : left;
      next.push(hashPair(left, right));
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0], layers };
}

export function computeMerkleRoot(leafHashes: string[]): string {
  return buildMerkleTree(leafHashes).root;
}

export function getMerkleProof(
  leafHashes: string[],
  leafIndex: number
): { proof: MerkleProofStep[]; root: string } {
  if (leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new Error("leaf index out of range");
  }
  const { root, layers } = buildMerkleTree(leafHashes);
  const proof: MerkleProofStep[] = [];
  let idx = leafIndex;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    if (idx % 2 === 0) {
      const siblingIdx = idx + 1;
      const sibling = siblingIdx < layer.length ? layer[siblingIdx] : layer[idx];
      proof.push({ sibling_hash: sibling, position: "right" });
    } else {
      proof.push({ sibling_hash: layer[idx - 1], position: "left" });
    }
    idx = Math.floor(idx / 2);
  }
  return { proof, root };
}

export function verifyMerkleProof(
  leafHash: string,
  proof: MerkleProofStep[],
  expectedRoot: string
): boolean {
  let current = leafHash;
  for (const step of proof) {
    if (step.position === "left") {
      current = hashPair(step.sibling_hash, current);
    } else if (step.position === "right") {
      current = hashPair(current, step.sibling_hash);
    } else {
      return false;
    }
  }
  return current === expectedRoot;
}
