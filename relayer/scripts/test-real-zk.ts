/**
 * Test real Groth16 proof generation end-to-end without running the full
 * batch settle flow. Proves the snarkjs + circuits + zkeys are usable.
 *
 * Run: `cd relayer && npx ts-node scripts/test-real-zk.ts`
 */

/// <reference path="../src/declarations.d.ts" />

declare module "snarkjs";
declare module "circomlibjs";

import * as path from "path";
import { generateBatchProof, computeCommitment } from "../src/zkProver";
import { generateClaimProof, buildMerkleTree } from "../src/zkClaimProver";
import { computeClearingPrice } from "../src/clearingPrice";
import { Order, OrderSide, PRICE_DECIMALS } from "../src/types";

async function main() {
  console.log("\n╔════════ Real Groth16 proof generation test ════════╗\n");

  const circuitsPath = path.resolve(__dirname, "..", "..", "circuits");
  console.log("Circuits path:", circuitsPath);

  // ── Build a realistic 3-order batch ─────────────────────────────
  const marketId = BigInt("0x" + "cafe".repeat(16));

  const orders: Order[] = [
    { side: OrderSide.YES_BUY, amount: 5_000_000n, limitPrice: 600_000n, salt: 111n },   // buy $5 YES at 0.60
    { side: OrderSide.YES_BUY, amount: 10_000_000n, limitPrice: 700_000n, salt: 222n },  // buy $10 YES at 0.70
    { side: OrderSide.NO_BUY,  amount: 3_000_000n, limitPrice: 400_000n, salt: 333n },   // buy $3 NO  at 0.40
  ];

  console.log(`Orders: ${orders.length}`);
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    console.log(`  [${i}] side=${OrderSide[o.side]} amount=${o.amount} limit=${o.limitPrice} salt=${o.salt}`);
  }

  // Commitments
  const commitments: bigint[] = [];
  for (const o of orders) {
    commitments.push(await computeCommitment(marketId, o.side, o.amount, o.limitPrice, o.salt));
  }
  console.log("Commitments computed:", commitments.length);

  // Run the actual clearing algorithm so inputs satisfy the circuit's
  // internal constraints. Made-up values would trigger assert failures.
  const clearing = computeClearingPrice(orders);
  const clearingPrice = clearing.clearingPrice;
  const filledYesBuyVol = clearing.filledYesBuyVol;
  const filledNoBuyVol = clearing.filledNoBuyVol;
  const filledYesSellQty = clearing.filledYesSellQty;
  const filledNoSellQty = clearing.filledNoSellQty;
  console.log(`Clearing price: ${clearingPrice} (${Number(clearingPrice) / 1e6})`);
  console.log(`filledYesBuy=${filledYesBuyVol}  filledNoBuy=${filledNoBuyVol}  yesSell=${filledYesSellQty}  noSell=${filledNoSellQty}`);

  // ── Batch proof ─────────────────────────────────────────────────
  console.log("\n[1/2] Generating batch clearing proof...");
  const batchStart = Date.now();
  const { proof: batchProof, publicSignals: batchPublic } = await generateBatchProof(
    marketId,
    orders,
    commitments,
    clearingPrice,
    filledYesBuyVol,
    filledNoBuyVol,
    filledYesSellQty,
    filledNoSellQty,
    circuitsPath,
  );
  console.log(`  ✓ Generated in ${((Date.now() - batchStart) / 1000).toFixed(2)}s`);
  console.log(`  proofA (64b):   ${Buffer.from(batchProof.proofA).toString("hex").slice(0, 40)}…`);
  console.log(`  proofB (128b):  ${Buffer.from(batchProof.proofB).toString("hex").slice(0, 40)}…`);
  console.log(`  proofC (64b):   ${Buffer.from(batchProof.proofC).toString("hex").slice(0, 40)}…`);
  console.log(`  public signals: ${batchPublic.length}`);

  // ── Claim proof (for order[0]) ──────────────────────────────────
  console.log("\n[2/2] Generating claim proof for order[0]...");
  const claimStart = Date.now();
  const recipientPubkey = BigInt("0x" + "beef".repeat(16));
  const batchId = 1n;
  const { proof: claimProof, publicSignals: claimPublic, nullifier, fillAmount } =
    await generateClaimProof(
      marketId,
      orders[0],
      batchId,
      clearingPrice,
      commitments,
      0, // leafIndex
      recipientPubkey,
      circuitsPath,
    );
  console.log(`  ✓ Generated in ${((Date.now() - claimStart) / 1000).toFixed(2)}s`);
  console.log(`  nullifier:      ${nullifier.toString(16).slice(0, 40)}…`);
  console.log(`  fillAmount:     ${fillAmount}`);
  console.log(`  proofA:         ${Buffer.from(claimProof.proofA).toString("hex").slice(0, 40)}…`);
  console.log(`  public signals: ${claimPublic.length}`);

  console.log("\n╔════════ ✓ Real ZK proofs work ════════╗");
  console.log(`  Batch proof: ${((Date.now() - batchStart) / 1000).toFixed(2)}s`);
  console.log(`  Claim proof: ${((Date.now() - claimStart) / 1000).toFixed(2)}s\n`);
}

main().catch((err) => {
  console.error("\n❌ FAILED:", err);
  process.exit(1);
});
