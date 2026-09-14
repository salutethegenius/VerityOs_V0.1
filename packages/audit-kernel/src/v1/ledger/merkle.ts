/**
 * V1 characterization copy from
 * salutethegenius/VerityOS-Sovereign-Audit-Kernel@a18419c66002648224f3def6291b7ed2caa90997
 * Do not use for new ledger writes.
 *
 * Known defect: verifyMerklePath infers left/right by hex string comparison
 * instead of recording direction.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export function buildMerkleTree(leafHashes: string[]): {
  root: string;
  layers: string[][];
} {
  if (leafHashes.length === 0) {
    const emptyHash = bytesToHex(sha256(new TextEncoder().encode("")));
    return { root: emptyHash, layers: [[emptyHash]] };
  }

  const leaves = [...leafHashes];
  const layers: string[][] = [leaves];

  let current = leaves;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : left;
      const combined = left + right;
      const parentHash = bytesToHex(sha256(hexToBytes(combined)));
      next.push(parentHash);
    }
    layers.push(next);
    current = next;
  }

  return {
    root: current[0],
    layers,
  };
}

export function computeMerkleRoot(leafHashes: string[]): string {
  return buildMerkleTree(leafHashes).root;
}

export function verifyMerklePath(
  leafHash: string,
  pathFromLeaf: string[],
  expectedRoot: string
): boolean {
  let current = leafHash;
  for (const sibling of pathFromLeaf) {
    const combined = current < sibling ? current + sibling : sibling + current;
    current = bytesToHex(sha256(hexToBytes(combined)));
  }
  return current === expectedRoot;
}

export function getMerklePath(
  leafHashes: string[],
  leafIndex: number
): { path: string[]; root: string } {
  const { root, layers } = buildMerkleTree(leafHashes);
  const path: string[] = [];
  let idx = leafIndex;
  for (let L = 0; L < layers.length - 1; L++) {
    const layer = layers[L];
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (siblingIdx >= 0 && siblingIdx < layer.length) {
      path.push(layer[siblingIdx]);
    }
    idx = Math.floor(idx / 2);
  }
  return { path, root };
}
