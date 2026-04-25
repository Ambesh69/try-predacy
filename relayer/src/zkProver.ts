import * as snarkjs from "snarkjs";
import * as path from "path";
import { Order, Groth16Proof, PRICE_DECIMALS, MAX_BATCH_ORDERS } from "./types";

// @ts-ignore
import { buildPoseidon } from "circomlibjs";

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
 * Compute Poseidon commitment hash for an order.
 * commitment = Poseidon(marketId, side, amount, limitPrice, salt)
 */
export async function computeCommitment(
  marketId: bigint,
  side: number,
  amount: bigint,
  limitPrice: bigint,
  salt: bigint,
): Promise<bigint> {
  const { poseidon, F } = await getPoseidon();
  const hash = poseidon([marketId, BigInt(side), amount, limitPrice, salt]);
  return F.toObject(hash);
}

/**
 * Compute sequential commitment root.
 * root = Poseidon(Poseidon(...Poseidon(0, c[0]), c[1]...), c[n-1])
 */
export async function computeCommitmentRoot(commitments: bigint[]): Promise<bigint> {
  const { poseidon, F } = await getPoseidon();
  let root = 0n;
  for (const c of commitments) {
    const h = poseidon([root, c]);
    root = F.toObject(h);
  }
  return root;
}

/**
 * Pad commitments to MAX_BATCH_ORDERS using the padding-order commitment
 * (Poseidon(marketId, 0, 0, 0, 0)). Matches what the circuit does internally.
 */
export async function padCommitmentsToMax(
  marketId: bigint,
  commitments: bigint[],
): Promise<bigint[]> {
  const padded = [...commitments];
  if (padded.length < MAX_BATCH_ORDERS) {
    const { poseidon, F } = await getPoseidon();
    const pad = F.toObject(poseidon([marketId, 0n, 0n, 0n, 0n]));
    while (padded.length < MAX_BATCH_ORDERS) padded.push(pad);
  }
  return padded;
}

/**
 * Compute the Poseidon commitment root that the batch circuit produces as
 * a public input. Use this to pass the root into lockFunds, so the value
 * stored on-chain matches what settle_batch's Groth16 verifier expects.
 */
export async function computeBatchCommitmentRoot(
  marketId: bigint,
  commitments: bigint[],
): Promise<bigint> {
  const padded = await padCommitmentsToMax(marketId, commitments);
  return computeCommitmentRoot(padded);
}

/**
 * Generate Groth16 batch clearing proof.
 */
export async function generateBatchProof(
  marketId: bigint,
  orders: Order[],
  commitments: bigint[],
  clearingPrice: bigint,
  filledYesBuyVol: bigint,
  filledNoBuyVol: bigint,
  filledYesSellQty: bigint,
  filledNoSellQty: bigint,
  circuitsPath: string,
): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
  // Pad to MAX_BATCH_ORDERS
  const paddedOrders = [...orders];
  while (paddedOrders.length < MAX_BATCH_ORDERS) {
    paddedOrders.push({ side: 0, amount: 0n, limitPrice: 0n, salt: 0n });
  }
  const paddedCommitments = [...commitments];
  while (paddedCommitments.length < MAX_BATCH_ORDERS) {
    const { poseidon, F } = await getPoseidon();
    const h = poseidon([marketId, 0n, 0n, 0n, 0n]);
    paddedCommitments.push(F.toObject(h));
  }

  // Compute commitment root
  const root = await computeCommitmentRoot(paddedCommitments);

  const input = {
    commitmentRoot: root.toString(),
    clearingPrice: clearingPrice.toString(),
    filledYesBuyVol: filledYesBuyVol.toString(),
    filledNoBuyVol: filledNoBuyVol.toString(),
    filledYesSellQty: filledYesSellQty.toString(),
    filledNoSellQty: filledNoSellQty.toString(),
    orderCount: orders.length.toString(),
    marketId: marketId.toString(),
    sides: paddedOrders.map((o) => o.side.toString()),
    amounts: paddedOrders.map((o) => o.amount.toString()),
    limitPrices: paddedOrders.map((o) => o.limitPrice.toString()),
    salts: paddedOrders.map((o) => o.salt.toString()),
    commitments: paddedCommitments.map((c) => c.toString()),
  };

  const wasmPath = path.join(circuitsPath, "batch_clearing/batch_clearing_js/batch_clearing.wasm");
  const zkeyPath = path.join(circuitsPath, "setup/batch_clearing_final.zkey");

  console.log("[zkProver] Generating batch proof...");
  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  console.log(`[zkProver] Proof generated in ${Date.now() - startTime}ms`);

  return {
    proof: formatProof(proof),
    publicSignals,
  };
}

/**
 * Generate an empty-bytes placeholder proof. Rejected by the live verifier; used only by test paths that bypass on-chain verification.
 */
export function generateMockProof(): Groth16Proof {
  return {
    proofA: new Uint8Array(64),
    proofB: new Uint8Array(128),
    proofC: new Uint8Array(64),
  };
}

/**
 * Format snarkjs proof into byte arrays for Solana program.
 *
 * Critical gotcha: groth16-solana expects proof.a to be NEGATED (y → p - y
 * in Fp) because the verifier reorders pairing equation terms. See
 * parse_vk_to_rust docstring. Forgetting this silently fails verification.
 */
function formatProof(proof: any): Groth16Proof {
  // snarkjs proof format: { pi_a: [x, y, 1], pi_b: [[x0, x1], [y0, y1], [1, 0]], pi_c: [x, y, 1] }
  // Solana expects: proofA (64 bytes), proofB (128 bytes), proofC (64 bytes)

  const proofA = new Uint8Array(64);
  const proofB = new Uint8Array(128);
  const proofC = new Uint8Array(64);

  // G1 point: [x, y] → 64 bytes — proof.a must be NEGATED (y → p - y).
  // Required by groth16-solana's Groth16Verifier (see crate README + test).
  const aX = BigInt(proof.pi_a[0]);
  const aY = BigInt(proof.pi_a[1]);
  const aYNeg = (BN254_BASE_FIELD_P - aY) % BN254_BASE_FIELD_P;
  proofA.set(bigintToBe32(aX), 0);
  proofA.set(bigintToBe32(aYNeg), 32);

  // G2 in EIP-197 / alt_bn128 order — (x_c1, x_c0, y_c1, y_c0).
  // **Empirically proven correct via on-chain discriminator test:**
  // programs/predacy's `verify_test_vectors(mode=1, ...)` was run on devnet
  // with a fresh proof cycled through every plausible ordering — EIP-197
  // was the ONLY one that verified (tx 41mBPXYNQ8oY..., 2026-04-25).
  // parse_vk_to_rust.js outputs the vkey in EIP-197 order, so proofs must
  // match or pairing rejects silently as ProofVerificationFailed.
  proofB.set(bigintToBe32(BigInt(proof.pi_b[0][1])), 0);    // x_c1
  proofB.set(bigintToBe32(BigInt(proof.pi_b[0][0])), 32);   // x_c0
  proofB.set(bigintToBe32(BigInt(proof.pi_b[1][1])), 64);   // y_c1
  proofB.set(bigintToBe32(BigInt(proof.pi_b[1][0])), 96);   // y_c0

  // G1 point: [x, y] → 64 bytes
  proofC.set(bigintToBe32(BigInt(proof.pi_c[0])), 0);
  proofC.set(bigintToBe32(BigInt(proof.pi_c[1])), 32);

  return { proofA, proofB, proofC };
}

// BN254 base field modulus p (affine coordinates live in Fp).
export const BN254_BASE_FIELD_P =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// BN254 scalar field modulus r (public inputs must be < r).
export const BN254_SCALAR_FIELD_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Convert a bigint to a 32-byte big-endian Uint8Array. */
export function bigintToBe32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number((n >> BigInt((31 - i) * 8)) & 0xffn);
  }
  return buf;
}
