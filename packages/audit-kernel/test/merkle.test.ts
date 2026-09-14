import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hashing/hash.js";
import {
  buildMerkleTree,
  computeMerkleRoot,
  getMerkleProof,
  hashPair,
  verifyMerkleProof,
} from "../src/merkle/merkle.js";
import * as v1 from "../src/v1/ledger/merkle.js";

function leaves(count: number): string[] {
  return Array.from({ length: count }, (_, i) => sha256Hex(`leaf-${i}`));
}

describe("V1 Merkle characterization", () => {
  it("builds stable roots for 1, odd, and even leaf counts", () => {
    expect(v1.computeMerkleRoot(leaves(1))).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.computeMerkleRoot(leaves(3))).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.computeMerkleRoot(leaves(4))).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.computeMerkleRoot(leaves(3))).toBe(v1.computeMerkleRoot(leaves(3)));
  });

  it("duplicates the last odd node during tree construction", () => {
    const odd = leaves(3);
    const { layers } = v1.buildMerkleTree(odd);
    expect(layers[0]).toHaveLength(3);
    expect(layers[1]).toHaveLength(2);
  });

  it("infers sibling order by hex comparison, disagreeing with construction", () => {
    const left = "ff".repeat(32);
    const right = "00".repeat(32);
    expect(left > right).toBe(true);
    const { root, path } = v1.getMerklePath([left, right], 0);
    expect(path[0]).toBe(right);
    const constructedParent = v1.buildMerkleTree([left, right]).layers[1][0];
    expect(constructedParent).toBe(root);
    expect(v1.verifyMerklePath(left, path, root)).toBe(false);
  });
});

describe("V2 Merkle (converted V1 expected failures)", () => {
  it("uses duplicate-last for an odd level in construction, proofs, and verify", () => {
    const odd = leaves(3);
    const { root, layers } = buildMerkleTree(odd);
    expect(layers[0]).toHaveLength(3);
    const duplicatedParent = hashPair(odd[2], odd[2]);
    expect(layers[1][1]).toBe(duplicatedParent);
    const { proof, root: proofRoot } = getMerkleProof(odd, 2);
    expect(proofRoot).toBe(root);
    expect(proof[0]).toEqual({ sibling_hash: odd[2], position: "right" });
    expect(verifyMerkleProof(odd[2], proof, root)).toBe(true);
  });

  it("records direction instead of comparing hex strings", () => {
    const left = "ff".repeat(32);
    const right = "00".repeat(32);
    const { proof, root } = getMerkleProof([left, right], 0);
    expect(proof[0]).toEqual({ sibling_hash: right, position: "right" });
    expect(verifyMerkleProof(left, proof, root)).toBe(true);
    const swapped = [{ sibling_hash: right, position: "left" as const }];
    expect(verifyMerkleProof(left, swapped, root)).toBe(false);
  });

  it("verifies single, odd, and even leaf counts", () => {
    for (const count of [1, 3, 4, 5, 8]) {
      const set = leaves(count);
      const root = computeMerkleRoot(set);
      for (let i = 0; i < set.length; i++) {
        const { proof } = getMerkleProof(set, i);
        expect(verifyMerkleProof(set[i], proof, root)).toBe(true);
      }
    }
  });

  it("rejects a corrupted leaf and a corrupted sibling", () => {
    const set = leaves(4);
    const { proof, root } = getMerkleProof(set, 1);
    expect(verifyMerkleProof(sha256Hex("tampered"), proof, root)).toBe(false);
    const broken = proof.map((step, i) =>
      i === 0 ? { ...step, sibling_hash: sha256Hex("bad-sibling") } : step
    );
    expect(verifyMerkleProof(set[1], broken, root)).toBe(false);
  });
});
