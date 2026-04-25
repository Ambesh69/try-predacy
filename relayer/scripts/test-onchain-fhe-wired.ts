/**
 * Smoke test: invoke the wired `computeOnchainFheClearing` directly with
 * a small order list to verify it produces byte-correct aggregates.
 * Mirrors what `batchProcessor.ts` does when `PRIVACY_MODE=onchain-fhe`.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { computeOnchainFheClearing, loadPredacyFheProgram } from "../src/onchainFheClearing";
import { OrderSide, type Order } from "../src/types";

const RPC_URL = `https://sol-devnet-rpc.rpcfast.com/?api_key=${process.env.RPC_FAST_API_KEY || "Mera4YdtfZgVWW3Nzkizi0LzY6wQb8PJrnUrjSvlNi3zbpdxm8tO7E6PAYSrggUH"}`;

async function main() {
  console.log("\n══ Smoke test: onchain-fhe wired path ══\n");

  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = loadPredacyFheProgram(provider);

  // Same toy 4-order batch as the demo:
  //   o0: YES_BUY  @ 0.60  100 USDC
  //   o1: YES_SELL @ 0.55   80 USDC
  //   o2: NO_BUY   @ 0.45   60 USDC
  //   o3: NO_SELL  @ 0.40   40 USDC
  // clearing = 0.55  →  yes_buy=100M, no_buy=60M, yes_sell=80M, no_sell=40M
  const orders: Order[] = [
    { side: OrderSide.YES_BUY,  amount: 100_000_000n, limitPrice: 600_000n, salt: 1n },
    { side: OrderSide.YES_SELL, amount:  80_000_000n, limitPrice: 550_000n, salt: 2n },
    { side: OrderSide.NO_BUY,   amount:  60_000_000n, limitPrice: 450_000n, salt: 3n },
    { side: OrderSide.NO_SELL,  amount:  40_000_000n, limitPrice: 400_000n, salt: 4n },
  ];
  const clearingPrice = 550_000n;

  console.log("Calling computeOnchainFheClearing()…");
  const result = await computeOnchainFheClearing(connection, payer, program, orders, clearingPrice);

  console.log(`\n✓ Settle tx:        ${result.settleTxSig}`);
  console.log(`  Solscan:          https://solscan.io/tx/${result.settleTxSig}?cluster=devnet`);
  console.log(`  Executor latency: ${result.executorLatencyMs}ms`);
  console.log(`  Total elapsed:    ${result.totalElapsedMs}ms\n`);

  console.log("Decrypted aggregates:");
  const expected = { yb: 100_000_000n, nb: 60_000_000n, ys: 80_000_000n, ns: 40_000_000n };
  const ok = (a: bigint, b: bigint) => a === b ? "✓" : `✗ (expected ${b})`;
  console.log(`  yes_buy_vol  = ${result.filledYesBuyVol}  ${ok(result.filledYesBuyVol, expected.yb)}`);
  console.log(`  no_buy_vol   = ${result.filledNoBuyVol}   ${ok(result.filledNoBuyVol, expected.nb)}`);
  console.log(`  yes_sell_qty = ${result.filledYesSellQty}  ${ok(result.filledYesSellQty, expected.ys)}`);
  console.log(`  no_sell_qty  = ${result.filledNoSellQty}   ${ok(result.filledNoSellQty, expected.ns)}`);

  const allMatch =
    result.filledYesBuyVol === expected.yb &&
    result.filledNoBuyVol === expected.nb &&
    result.filledYesSellQty === expected.ys &&
    result.filledNoSellQty === expected.ns;

  console.log(`\n${allMatch ? "✓ ALL AGGREGATES MATCH — onchain-fhe wired path proven" : "✗ MISMATCH"}`);
}

main().catch(err => { console.error("\n❌", err); process.exit(1); });
