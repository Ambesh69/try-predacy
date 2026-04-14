import * as snarkjs from "snarkjs";
import * as path from "path";
import { Order, OrderSide, Groth16Proof, PRICE_DECIMALS } from "./types";
import { computeCommitment, computeCommitmentRoot } from "./zkProver";

// @ts-ignore
import { buildPoseidon } from "circomlibjs";

const DEPTH = 9; // Merkle tree depth (512 leaves)

let poseidonInstance: any = null;
let F: any = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
    F = poseidonInstance.F;
  }
  return { poseidon: poseidonInstance, F };
}

/**
 * Build a binary Poseidon Merkle tree from commitments.
 * Returns the tree (array of levels) and the root.
 */
export async function buildMerkleTree(
  commitments: bigint[]
): Promise<{ tree: bigint[][]; root: bigint }> {
  const { poseidon, F } = await getPoseidon();
  const numLeaves = 1 << DEPTH; // 512

  // Pad leaves to full tree size
  const leaves = new Array(numLeaves).fill(0n);
  for (let i = 0; i < commitments.length; i++) {
    leaves[i] = commitments[i];
  }

  // Build tree bottom-up
  const tree: bigint[][] = [leaves];
  let currentLevel = leaves;

  for (let d = 0; d < DEPTH; d++) {
    const nextLevel: bigint[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const h = poseidon([currentLevel[i], currentLevel[i + 1]]);
      nextLevel.push(F.toObject(h));
    }
    currentLevel = nextLevel;
    tree.push(currentLevel);
  }

  return { tree, root: tree[DEPTH][0] };
}

/**
 * Extract Merkle proof path for a given leaf index.
 */
export function getMerklePath(
  tree: bigint[][],
  leafIndex: number
): { pathElements: bigint[]; pathIndices: number[] } {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let idx = leafIndex;

  for (let d = 0; d < DEPTH; d++) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    pathElements.push(tree[d][siblingIdx]);
    pathIndices.push(idx % 2); // 0 = left child, 1 = right child
    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}

/**
 * Compute nullifier = Poseidon(commitment, batchId, salt)
 */
export async function computeNullifier(
  commitment: bigint,
  batchId: bigint,
  salt: bigint
): Promise<bigint> {
  const { poseidon, F } = await getPoseidon();
  const h = poseidon([commitment, batchId, salt]);
  return F.toObject(h);
}

/**
 * Generate Groth16 claim proof.
 */
export async function generateClaimProof(
  marketId: bigint,
  order: Order,
  batchId: bigint,
  clearingPrice: bigint,
  allCommitments: bigint[], // all commitments in the batch
  leafIndex: number,        // this order's position in the batch
  recipient: bigint,        // recipient address as field element
  circuitsPath: string,
): Promise<{
  proof: Groth16Proof;
  publicSignals: string[];
  nullifier: bigint;
  fills: boolean;
  fillAmount: bigint;
  refundAmount: bigint;
}> {
  // Compute commitment
  const commitment = await computeCommitment(
    marketId, order.side, order.amount, order.limitPrice, order.salt
  );

  // Build Merkle tree and get proof path
  const { tree, root } = await buildMerkleTree(allCommitments);
  const { pathElements, pathIndices } = getMerklePath(tree, leafIndex);

  // Compute nullifier
  const nullifier = await computeNullifier(commitment, batchId, order.salt);

  // Determine fill decision
  const noPrice = PRICE_DECIMALS - clearingPrice;
  let fills = false;
  switch (order.side) {
    case OrderSide.YES_BUY:
      fills = order.limitPrice >= clearingPrice;
      break;
    case OrderSide.YES_SELL:
      fills = order.limitPrice <= clearingPrice;
      break;
    case OrderSide.NO_BUY:
      fills = order.limitPrice >= noPrice;
      break;
    case OrderSide.NO_SELL:
      fills = order.limitPrice <= noPrice;
      break;
  }

  const fillAmount = fills ? order.amount : 0n;
  const isSell = order.side === OrderSide.YES_SELL || order.side === OrderSide.NO_SELL;
  const refundAmount = !fills && isSell ? order.amount : 0n;

  const input = {
    batchId: batchId.toString(),
    claimMerkleRoot: root.toString(),
    clearingPrice: clearingPrice.toString(),
    nullifier: nullifier.toString(),
    recipient: recipient.toString(),
    marketId: marketId.toString(),
    side: order.side.toString(),
    amount: order.amount.toString(),
    limitPrice: order.limitPrice.toString(),
    salt: order.salt.toString(),
    merklePath: pathElements.map((e) => e.toString()),
    merklePathIndices: pathIndices.map((i) => i.toString()),
  };

  const wasmPath = path.join(circuitsPath, "claim/claim_js/claim.wasm");
  const zkeyPath = path.join(circuitsPath, "setup/claim_final.zkey");

  console.log("[zkClaimProver] Generating claim proof...");
  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  console.log(`[zkClaimProver] Proof generated in ${Date.now() - startTime}ms`);

  // Format proof for Solana
  const formattedProof = formatProof(proof);

  return {
    proof: formattedProof,
    publicSignals,
    nullifier,
    fills,
    fillAmount,
    refundAmount,
  };
}

function formatProof(proof: any): Groth16Proof {
  const toBe32 = (n: string): Uint8Array => {
    const bi = BigInt(n);
    const buf = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(bi >> BigInt((31 - i) * 8) & 0xffn);
    }
    return buf;
  };

  const proofA = new Uint8Array(64);
  proofA.set(toBe32(proof.pi_a[0]), 0);
  proofA.set(toBe32(proof.pi_a[1]), 32);

  const proofB = new Uint8Array(128);
  proofB.set(toBe32(proof.pi_b[0][0]), 0);
  proofB.set(toBe32(proof.pi_b[0][1]), 32);
  proofB.set(toBe32(proof.pi_b[1][0]), 64);
  proofB.set(toBe32(proof.pi_b[1][1]), 96);

  const proofC = new Uint8Array(64);
  proofC.set(toBe32(proof.pi_c[0]), 0);
  proofC.set(toBe32(proof.pi_c[1]), 32);

  return { proofA, proofB, proofC };
}
