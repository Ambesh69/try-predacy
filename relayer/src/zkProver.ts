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
 */
function formatProof(proof: any): Groth16Proof {
  // snarkjs proof format: { pi_a: [x, y, 1], pi_b: [[x0, x1], [y0, y1], [1, 0]], pi_c: [x, y, 1] }
  // Solana expects: proofA (64 bytes), proofB (128 bytes), proofC (64 bytes)

  const proofA = new Uint8Array(64);
  const proofB = new Uint8Array(128);
  const proofC = new Uint8Array(64);

  // Convert field elements to 32-byte big-endian
  const toBe32 = (n: string): Uint8Array => {
    const bi = BigInt(n);
    const buf = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(bi >> BigInt((31 - i) * 8) & 0xffn);
    }
    return buf;
  };

  // G1 point: [x, y] → 64 bytes
  proofA.set(toBe32(proof.pi_a[0]), 0);
  proofA.set(toBe32(proof.pi_a[1]), 32);

  // G2 point: [[x0, x1], [y0, y1]] → 128 bytes
  proofB.set(toBe32(proof.pi_b[0][0]), 0);
  proofB.set(toBe32(proof.pi_b[0][1]), 32);
  proofB.set(toBe32(proof.pi_b[1][0]), 64);
  proofB.set(toBe32(proof.pi_b[1][1]), 96);

  // G1 point: [x, y] → 64 bytes
  proofC.set(toBe32(proof.pi_c[0]), 0);
  proofC.set(toBe32(proof.pi_c[1]), 32);

  return { proofA, proofB, proofC };
}
