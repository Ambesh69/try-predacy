/**
 * Debug the Groth16 off-chain vs on-chain mismatch.
 *
 * Generates a batch proof, verifies it with snarkjs (off-chain reference),
 * and dumps the exact bytes the Anchor program would compute as public
 * inputs. Compare against relayer logs to find where the encoding diverges.
 */

import * as snarkjs from "snarkjs";
import * as path from "path";
import * as fs from "fs";
import { Order, OrderSide, PRICE_DECIMALS } from "../src/types";
import {
  computeCommitment,
  computeBatchCommitmentRoot,
  generateBatchProof,
  BN254_BASE_FIELD_P,
  bigintToBe32,
} from "../src/zkProver";
import { computeClearingPrice } from "../src/clearingPrice";

async function main() {
  const circuitsPath = path.resolve(__dirname, "..", "..", "circuits");
  console.log("Circuits:", circuitsPath);

  // Same 3-order batch as test-real-zk
  const marketId = BigInt("0x" + "cafe".repeat(16));
  const orders: Order[] = [
    { side: OrderSide.YES_BUY, amount: 5_000_000n, limitPrice: 600_000n, salt: 111n },
    { side: OrderSide.YES_BUY, amount: 10_000_000n, limitPrice: 700_000n, salt: 222n },
    { side: OrderSide.NO_BUY, amount: 3_000_000n, limitPrice: 400_000n, salt: 333n },
  ];

  const commitments: bigint[] = [];
  for (const o of orders) {
    commitments.push(await computeCommitment(marketId, o.side, o.amount, o.limitPrice, o.salt));
  }

  const clearing = computeClearingPrice(orders);
  console.log("\nClearing:", {
    price: clearing.clearingPrice.toString(),
    yesBuy: clearing.filledYesBuyVol.toString(),
    noBuy: clearing.filledNoBuyVol.toString(),
    yesSell: clearing.filledYesSellQty.toString(),
    noSell: clearing.filledNoSellQty.toString(),
  });

  const commitmentRoot = await computeBatchCommitmentRoot(marketId, commitments);
  console.log("\ncommitmentRoot (bigint):", commitmentRoot.toString());
  console.log("commitmentRoot (hex BE 32):", Buffer.from(bigintToBe32(commitmentRoot)).toString("hex"));

  console.log("\n[1] Generate batch proof");
  const { proof, publicSignals } = await generateBatchProof(
    marketId,
    orders,
    commitments,
    clearing.clearingPrice,
    clearing.filledYesBuyVol,
    clearing.filledNoBuyVol,
    clearing.filledYesSellQty,
    clearing.filledNoSellQty,
    circuitsPath,
  );
  console.log("Generated. publicSignals (", publicSignals.length, "):");
  for (let i = 0; i < publicSignals.length; i++) {
    console.log(`  [${i}] ${publicSignals[i]}`);
  }

  // ━━━ Verify the ORIGINAL (non-negated) proof with snarkjs ━━━
  console.log("\n[2] snarkjs.groth16.verify with raw snarkjs output (before negation)");
  // We need the raw (non-negated, non-formatted) proof. Since generateBatchProof
  // calls formatProof internally, we re-create the fullProve here to preserve
  // the raw output for verification.
  const rawInput = {
    commitmentRoot: commitmentRoot.toString(),
    clearingPrice: clearing.clearingPrice.toString(),
    filledYesBuyVol: clearing.filledYesBuyVol.toString(),
    filledNoBuyVol: clearing.filledNoBuyVol.toString(),
    filledYesSellQty: clearing.filledYesSellQty.toString(),
    filledNoSellQty: clearing.filledNoSellQty.toString(),
    orderCount: orders.length.toString(),
    marketId: marketId.toString(),
    sides: (await paddedSides(orders, 8)).map(s => s.toString()),
    amounts: (await paddedAmounts(orders, 8)).map(a => a.toString()),
    limitPrices: (await paddedLimitPrices(orders, 8)).map(p => p.toString()),
    salts: (await paddedSalts(orders, 8)).map(s => s.toString()),
    commitments: (await paddedCommitments(marketId, commitments, 8)).map(c => c.toString()),
  };
  const wasmPath = path.join(circuitsPath, "batch_clearing/batch_clearing_js/batch_clearing.wasm");
  const zkeyPath = path.join(circuitsPath, "setup/batch_clearing_final.zkey");
  const { proof: rawProof, publicSignals: rawPublic } = await snarkjs.groth16.fullProve(rawInput, wasmPath, zkeyPath);

  const vkeyJson = JSON.parse(fs.readFileSync(path.join(circuitsPath, "setup/batch_clearing_vkey.json"), "utf-8"));
  const snarkjsVerified = await snarkjs.groth16.verify(vkeyJson, rawPublic, rawProof);
  console.log("  snarkjs verify (off-chain reference):", snarkjsVerified ? "✓ VALID" : "✗ INVALID");

  if (!snarkjsVerified) {
    console.log("\n→ Proof fails even under snarkjs's own verifier. Circuit bug.");
    return;
  }

  console.log("\n[3] Dump formatted proof bytes (what goes to Solana)");
  console.log("  proofA (negated, 64b):   ", Buffer.from(proof.proofA).toString("hex"));
  console.log("  proofB           (128b): ", Buffer.from(proof.proofB).toString("hex"));
  console.log("  proofC           (64b):  ", Buffer.from(proof.proofC).toString("hex"));

  console.log("\n[4] Dump 7 public-input bytes (what the on-chain verifier would receive)");
  const onchainInputs = [
    ["commitmentRoot", bigintToBe32(commitmentRoot)],
    ["clearingPrice", bigintToBe32(clearing.clearingPrice)],
    ["filledYesBuyVol", bigintToBe32(clearing.filledYesBuyVol)],
    ["filledNoBuyVol", bigintToBe32(clearing.filledNoBuyVol)],
    ["filledYesSellQty", bigintToBe32(clearing.filledYesSellQty)],
    ["filledNoSellQty", bigintToBe32(clearing.filledNoSellQty)],
    ["orderCount", bigintToBe32(BigInt(orders.length))],
  ] as const;
  for (const [name, b] of onchainInputs) {
    console.log(`  ${name.padEnd(20)} ${Buffer.from(b).toString("hex")}`);
  }

  // ━━━ Cross-check: publicSignals[i] should equal the bigint form of each input ━━━
  console.log("\n[5] Match check: snarkjs publicSignals vs on-chain encoding");
  for (let i = 0; i < onchainInputs.length; i++) {
    const name = onchainInputs[i][0];
    const bytes = onchainInputs[i][1];
    const bi = BigInt("0x" + Buffer.from(bytes).toString("hex"));
    const psig = BigInt(publicSignals[i]);
    const match = bi === psig ? "✓" : "✗";
    console.log(`  ${match} [${i}] ${name}: onchain=${bi} vs snarkjs[${i}]=${psig}`);
  }
}

// Pad helpers matching zkProver.ts's internals. We duplicate here because
// those helpers aren't exported; this keeps the debug-only code loose.
async function paddedSides(orders: Order[], n: number): Promise<bigint[]> {
  const a = orders.map(o => BigInt(o.side));
  while (a.length < n) a.push(0n);
  return a;
}
async function paddedAmounts(orders: Order[], n: number): Promise<bigint[]> {
  const a = orders.map(o => o.amount);
  while (a.length < n) a.push(0n);
  return a;
}
async function paddedLimitPrices(orders: Order[], n: number): Promise<bigint[]> {
  const a = orders.map(o => o.limitPrice);
  while (a.length < n) a.push(0n);
  return a;
}
async function paddedSalts(orders: Order[], n: number): Promise<bigint[]> {
  const a = orders.map(o => o.salt);
  while (a.length < n) a.push(0n);
  return a;
}
async function paddedCommitments(marketId: bigint, commitments: bigint[], n: number): Promise<bigint[]> {
  // @ts-ignore
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const a = [...commitments];
  while (a.length < n) {
    const h = poseidon([marketId, 0n, 0n, 0n, 0n]);
    a.push(F.toObject(h));
  }
  return a;
}

main().catch(err => { console.error(err); process.exit(1); });
