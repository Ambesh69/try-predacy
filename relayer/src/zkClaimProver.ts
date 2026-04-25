import * as snarkjs from "snarkjs";
import * as path from "path";
import { Order, OrderSide, Groth16Proof, PRICE_DECIMALS } from "./types";
import { computeCommitment, computeCommitmentRoot, BN254_BASE_FIELD_P, bigintToBe32 } from "./zkProver";

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
 * Convert a Solana pubkey (32 bytes) to a BN254 scalar field element.
 *
 * The scalar field modulus r ≈ 2^254, and we need the pubkey value to be < r.
 * Since the top byte of r is 0x30, masking the first byte with 0x1F (zeroing
 * the top 3 bits) guarantees value < 2^253 < r — both on-chain and off-chain
 * do the same reduction so the public input matches.
 *
 * Returns { fieldBigint, fieldBytes } — both representations are useful:
 * the circuit wants a decimal bigint, the Anchor instruction wants [u8; 32].
 */
export function pubkeyToFieldElement(pubkeyBytes: Uint8Array): {
  fieldBigint: bigint;
  fieldBytes: Uint8Array;
} {
  if (pubkeyBytes.length !== 32) {
    throw new Error(`Expected 32-byte pubkey, got ${pubkeyBytes.length}`);
  }
  const masked = new Uint8Array(pubkeyBytes);
  masked[0] &= 0x1f; // zero top 3 bits → value < 2^253 < BN254 scalar modulus
  let bi = 0n;
  for (let i = 0; i < 32; i++) {
    bi = (bi << 8n) | BigInt(masked[i]);
  }
  return { fieldBigint: bi, fieldBytes: masked };
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

// See zkProver.ts for rationale — proof.a must be negated for groth16-solana.
function formatProof(proof: any): Groth16Proof {
  const proofA = new Uint8Array(64);
  const aX = BigInt(proof.pi_a[0]);
  const aY = BigInt(proof.pi_a[1]);
  const aYNeg = (BN254_BASE_FIELD_P - aY) % BN254_BASE_FIELD_P;
  proofA.set(bigintToBe32(aX), 0);
  proofA.set(bigintToBe32(aYNeg), 32);

  // G2 in EIP-197 order (x_c1, x_c0, y_c1, y_c0) — empirically proven via
  // on-chain discriminator (see zkProver.ts).
  const proofB = new Uint8Array(128);
  proofB.set(bigintToBe32(BigInt(proof.pi_b[0][1])), 0);    // x_c1
  proofB.set(bigintToBe32(BigInt(proof.pi_b[0][0])), 32);   // x_c0
  proofB.set(bigintToBe32(BigInt(proof.pi_b[1][1])), 64);   // y_c1
  proofB.set(bigintToBe32(BigInt(proof.pi_b[1][0])), 96);   // y_c0

  const proofC = new Uint8Array(64);
  proofC.set(bigintToBe32(BigInt(proof.pi_c[0])), 0);
  proofC.set(bigintToBe32(BigInt(proof.pi_c[1])), 32);

  return { proofA, proofB, proofC };
}
