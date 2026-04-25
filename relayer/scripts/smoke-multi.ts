/**
 * Multi-order batch test. Submits 3 orders (YES_BUY + YES_BUY + NO_BUY) in
 * one batch window, waits for settle. Tests:
 *   - Padding from 3 real orders to MAX_BATCH_ORDERS=8 with Poseidon dummies
 *   - Per-order commitment tracking
 *   - Larger commitment_root chain hashes
 *   - pair-matching with real matched pairs (YES_BUY ↔ NO_BUY)
 *   - Groth16 public input `orderCount=3` instead of 1
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { RPC_FAST_URL } from "../src/rpcConfig";

const RELAYER_URL = "http://localhost:3001";
const MARKET_ID_HEX = "707265646163792d64656d6f2d76310000000000000000000000000000000000";

async function main() {
  console.log("\n╔═══ Multi-order batch smoke test ═══╗\n");

  const health: any = await fetch(`${RELAYER_URL}/health`).then(r => r.json());
  console.log(`Relayer: ${health.relayer}  program: ${health.programId}`);

  // Setup: mint some USDC to the relayer wallet (it's both relayer and
  // simulated user here).
  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));
  ||
  const connection = new Connection(RPC_FAST_URL, "confirmed");

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "predacy-idl.json"), "utf-8"));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);

  const [protocolConfig] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("protocol")], new anchor.web3.PublicKey(health.programId));
  const cfg: any = await (program.account as any).protocolConfig.fetch(protocolConfig);
  const usdcMint = cfg.usdcMint;

  console.log(`Using USDC mint: ${usdcMint.toBase58()}`);
  const relayerUsdcAcct = await getOrCreateAssociatedTokenAccount(connection, kp, usdcMint, kp.publicKey);
  await mintTo(connection, kp, usdcMint, relayerUsdcAcct.address, kp, 100_000_000);
  console.log("Minted $100 to relayer\n");

  // Start market (idempotent)
  await fetch(`${RELAYER_URL}/market/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketId: MARKET_ID_HEX }),
  });
  await new Promise(r => setTimeout(r, 2000));

  // Submit 3 orders within the same batch window
  const orders = [
    { side: 0, amount: "10000000", limitPrice: "700000", label: "YES_BUY $10 @ 0.70" },
    { side: 0, amount: "5000000",  limitPrice: "650000", label: "YES_BUY $5 @ 0.65" },
    { side: 2, amount: "8000000",  limitPrice: "400000", label: "NO_BUY $8 @ 0.40" },
  ];

  const submitted: Array<{ batchId: string; salt: string; side: number; amount: string; limitPrice: string }> = [];
  for (const o of orders) {
    const saltBytes = (globalThis as any).crypto.getRandomValues(new Uint8Array(32));
    const salt = "0x" + Array.from(saltBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const res = await fetch(`${RELAYER_URL}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        marketId: MARKET_ID_HEX,
        side: o.side,
        amount: o.amount,
        limitPrice: o.limitPrice,
        salt,
      }),
    });
    const d: any = await res.json();
    if (!d.ok) { console.error(`order failed: ${JSON.stringify(d)}`); process.exit(1); }
    console.log(`  ✓ ${o.label} → batch #${d.batchId}`);
    submitted.push({ batchId: d.batchId, salt, side: o.side, amount: o.amount, limitPrice: o.limitPrice });
  }

  // All orders should be in the same batch
  const batchId = submitted[0].batchId;
  if (!submitted.every((s) => s.batchId === batchId)) {
    console.error("❌ Orders spread across multiple batches — rerun when a fresh batch opens");
    process.exit(1);
  }
  console.log(`\nAll 3 orders in batch #${batchId}. Waiting to settle...`);

  // Wait for settlement
  const deadline = Date.now() + 120_000;
  let settled = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await fetch(`${RELAYER_URL}/settlement-stats?batchId=${batchId}`);
    if (r.ok) {
      const stats = await r.json() as any;
      console.log(`  ✓ settled. clearingPrice=${stats.clearingPrice} filled=yb${stats.filledYesBuyVol}/nb${stats.filledNoBuyVol}`);
      console.log(`  pair matching: matched=${stats.pairMatching.matchedPairQty} residualYesBuy=${stats.pairMatching.residualYesBuyQty} residualNoBuy=${stats.pairMatching.residualNoBuyQty}`);
      settled = true;
      break;
    }
  }
  if (!settled) { console.error("❌ Did not settle in 2min"); process.exit(1); }

  console.log("\n╔═══ ✓ Multi-order batch settled ═══╗\n");
}

main().catch(e => { console.error(e); process.exit(1); });
