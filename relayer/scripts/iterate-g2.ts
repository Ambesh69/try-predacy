/**
 * Iterate through every possible G2 coordinate-swap combination for
 * proof.b and see which one the on-chain syscall accepts.
 *
 * 4 Fp2 components in G2: x_c0, x_c1, y_c0, y_c1.
 * 4 slots in the 128-byte proofB buffer: [0..32], [32..64], [64..96], [96..128].
 *
 * Canonical orderings worth testing:
 *   (x_c0, x_c1, y_c0, y_c1) — natural snarkjs
 *   (x_c1, x_c0, y_c1, y_c0) — EIP-197 swap per Fp2
 *   (y_c0, y_c1, x_c0, x_c1) — xy swap
 *   (x_c0, x_c1, y_c1, y_c0) — only y swapped
 *   (x_c1, x_c0, y_c0, y_c1) — only x swapped
 *
 * Plus the non-trivial observation: maybe proof.a or proof.c need the
 * same treatment. Try that too if G2 alone doesn't fix it.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { computeClearingPrice } from "../src/clearingPrice";
import {
  computeCommitment,
  computeBatchCommitmentRoot,
  BN254_BASE_FIELD_P,
  bigintToBe32,
} from "../src/zkProver";
import { Order, OrderSide, MAX_BATCH_ORDERS, PRICE_DECIMALS } from "../src/types";

// @ts-ignore
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

const RPC_URL = `https://sol-devnet-rpc.rpcfast.com/?api_key=${process.env.RPC_FAST_API_KEY || "Mera4YdtfZgVWW3Nzkizi0LzY6wQb8PJrnUrjSvlNi3zbpdxm8tO7E6PAYSrggUH"}`;

async function main() {
  // Generate one proof, then try many on-chain verifications with different
  // byte orderings.
  console.log("Generating one batch proof...");
  const circuitsPath = path.resolve(__dirname, "..", "..", "circuits");
  const marketId = BigInt("0x" + "cafe".repeat(16));
  const orders: Order[] = [
    { side: OrderSide.YES_BUY, amount: 10_000_000n, limitPrice: 650_000n, salt: 1n },
    { side: OrderSide.NO_BUY, amount: 5_000_000n, limitPrice: 400_000n, salt: 2n },
  ];
  const commitments: bigint[] = [];
  for (const o of orders) {
    commitments.push(await computeCommitment(marketId, o.side, o.amount, o.limitPrice, o.salt));
  }
  const clearing = computeClearingPrice(orders);
  const commitmentRoot = await computeBatchCommitmentRoot(marketId, commitments);

  // Pad to MAX_BATCH_ORDERS for the circuit
  const padded: Order[] = [...orders];
  while (padded.length < MAX_BATCH_ORDERS) padded.push({ side: 0, amount: 0n, limitPrice: 0n, salt: 0n });
  const paddedC: bigint[] = [...commitments];
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  while (paddedC.length < MAX_BATCH_ORDERS) {
    paddedC.push(F.toObject(poseidon([marketId, 0n, 0n, 0n, 0n])));
  }

  const input = {
    commitmentRoot: commitmentRoot.toString(),
    clearingPrice: clearing.clearingPrice.toString(),
    filledYesBuyVol: clearing.filledYesBuyVol.toString(),
    filledNoBuyVol: clearing.filledNoBuyVol.toString(),
    filledYesSellQty: clearing.filledYesSellQty.toString(),
    filledNoSellQty: clearing.filledNoSellQty.toString(),
    orderCount: orders.length.toString(),
    marketId: marketId.toString(),
    sides: padded.map(o => o.side.toString()),
    amounts: padded.map(o => o.amount.toString()),
    limitPrices: padded.map(o => o.limitPrice.toString()),
    salts: padded.map(o => o.salt.toString()),
    commitments: paddedC.map(c => c.toString()),
  };
  const wasmPath = path.join(circuitsPath, "batch_clearing/batch_clearing_js/batch_clearing.wasm");
  const zkeyPath = path.join(circuitsPath, "setup/batch_clearing_final.zkey");
  const { proof: rawProof, publicSignals: rawPublic } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  console.log("Proof generated. publicSignals:", rawPublic);

  // Public inputs — same in all trials
  const pubInputs: number[][] = [
    Array.from(bigintToBe32(commitmentRoot)),
    Array.from(bigintToBe32(clearing.clearingPrice)),
    Array.from(bigintToBe32(clearing.filledYesBuyVol)),
    Array.from(bigintToBe32(clearing.filledNoBuyVol)),
    Array.from(bigintToBe32(clearing.filledYesSellQty)),
    Array.from(bigintToBe32(clearing.filledNoSellQty)),
    Array.from(bigintToBe32(BigInt(orders.length))),
  ];

  // proof.a (negated) + proof.c are fixed; we only vary proof.b
  const pi_a_x = BigInt(rawProof.pi_a[0]);
  const pi_a_y = BigInt(rawProof.pi_a[1]);
  const aYNeg = (BN254_BASE_FIELD_P - pi_a_y) % BN254_BASE_FIELD_P;
  const proofA = new Uint8Array(64);
  proofA.set(bigintToBe32(pi_a_x), 0);
  proofA.set(bigintToBe32(aYNeg), 32);

  const proofC = new Uint8Array(64);
  proofC.set(bigintToBe32(BigInt(rawProof.pi_c[0])), 0);
  proofC.set(bigintToBe32(BigInt(rawProof.pi_c[1])), 32);

  const b_x0 = bigintToBe32(BigInt(rawProof.pi_b[0][0]));
  const b_x1 = bigintToBe32(BigInt(rawProof.pi_b[0][1]));
  const b_y0 = bigintToBe32(BigInt(rawProof.pi_b[1][0]));
  const b_y1 = bigintToBe32(BigInt(rawProof.pi_b[1][1]));

  const orderings: { name: string; b: Uint8Array }[] = [
    { name: "natural (x_c0,x_c1,y_c0,y_c1)", b: concat4(b_x0, b_x1, b_y0, b_y1) },
    { name: "EIP-197 (x_c1,x_c0,y_c1,y_c0)", b: concat4(b_x1, b_x0, b_y1, b_y0) },
    { name: "only-y swapped (x_c0,x_c1,y_c1,y_c0)", b: concat4(b_x0, b_x1, b_y1, b_y0) },
    { name: "only-x swapped (x_c1,x_c0,y_c0,y_c1)", b: concat4(b_x1, b_x0, b_y0, b_y1) },
    { name: "xy swapped (y_c0,y_c1,x_c0,x_c1)", b: concat4(b_y0, b_y1, b_x0, b_x1) },
  ];

  // Connect + build program client
  const kpPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf-8"))));
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "predacy-idl.json"), "utf-8"));
  const program = new anchor.Program(idl, provider);

  // Try each ordering via the arg-mode verifier (mode=1)
  for (const ord of orderings) {
    process.stdout.write(`  ${ord.name.padEnd(40)} `);
    try {
      const tx = await (program.methods as any)
        .verifyTestVectors(
          1,
          Array.from(proofA),
          Array.from(ord.b),
          Array.from(proofC),
          pubInputs,
        )
        .accounts({})
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc();
      console.log(`✓ PASSED  tx=${tx.slice(0, 12)}…`);
      console.log(`\n→ Correct ordering: ${ord.name}`);
      return;
    } catch (err: any) {
      const code = err?.error?.errorCode?.code ?? "unknown";
      console.log(`✗ ${code}`);
    }
  }
  console.log("\n✗ No G2 ordering worked with BATCH_VK. Issue is elsewhere.");
}

function concat4(a: Uint8Array, b: Uint8Array, c: Uint8Array, d: Uint8Array): Uint8Array {
  const out = new Uint8Array(128);
  out.set(a, 0); out.set(b, 32); out.set(c, 64); out.set(d, 96);
  return out;
}

main().catch(e => { console.error(e); process.exit(1); });
