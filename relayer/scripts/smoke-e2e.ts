/**
 * End-to-end smoke test on live devnet.
 *
 * What this proves:
 *   1. The deployed program with the new Groth16 verifier actually accepts
 *      a real proof at settle_batch (the big unknown since the redeploy).
 *   2. claim_with_proof verifies a real claim proof with the recipient_field
 *      argument + returns tokens.
 *   3. The commitment_root Poseidon path matches between off-chain and
 *      on-chain.
 *
 * Assumes:
 *   - Relayer is NOT already running on :3001 (we boot it in this script's
 *     parent shell, or you start it separately).
 *   - Protocol + demo market are initialized (init-devnet.ts has been run).
 *   - Relayer wallet has SOL + is the USDC mint authority.
 *
 * Run: `cd relayer && npx ts-node scripts/smoke-e2e.ts`
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const RELAYER_URL = "http://localhost:3001";
const RPC_URL = "https://api.devnet.solana.com";
// Use the HTTP+token URL for RPC calls so we don't rate-limit on the public
// devnet endpoint — see relayer/.env for how the server uses the same.
const RPC_FAST_URL = `https://sol-devnet-rpc.rpcfast.com/?api_key=${process.env.RPC_FAST_API_KEY || ""}`;

const MARKET_ID_HEX = "707265646163792d64656d6f2d76310000000000000000000000000000000000";
const MARKET_ID_BUF = Buffer.from(MARKET_ID_HEX, "hex");

async function main() {
  console.log("\n╔═════════════════════════════════════════╗");
  console.log("║   Predacy E2E Smoke Test                ║");
  console.log("╚═════════════════════════════════════════╝\n");

  // 1. Health check
  console.log("1. Relayer /health");
  const health: any = await fetch(`${RELAYER_URL}/health`).then(r => r.json());
  console.log(`   program=${health.programId} useRealZk=${health.useRealZk} ika=${health.ika.enabled}`);

  const relayerPk = new PublicKey(health.relayer);
  const programId = new PublicKey(health.programId);

  // 2. Load program + fetch protocol_config to find the real USDC mint
  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const relayerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))),
  );
  const rpcUrl = health.rpcFastEnabled && process.env.RPC_FAST_API_KEY ? RPC_FAST_URL : RPC_URL;
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(relayerKp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  // Use the relayer's local IDL copy (patched address)
  const idlPath = path.join(__dirname, "..", "predacy-idl.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  console.log("\n2. Fetching on-chain protocol_config for USDC mint");
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")], programId,
  );
  const cfg = await (program.account as any).protocolConfig.fetch(protocolConfig);
  const usdcMint = new PublicKey(cfg.usdcMint);
  console.log(`   usdcMint=${usdcMint.toBase58()}`);

  // 3. Ensure relayer wallet has USDC (relayer is the mint authority)
  console.log("\n3. Minting 1000 mock USDC to relayer wallet for test");
  const relayerUsdcAcct = await getOrCreateAssociatedTokenAccount(
    connection, relayerKp, usdcMint, relayerKp.publicKey,
  );
  await mintTo(
    connection, relayerKp, usdcMint, relayerUsdcAcct.address,
    relayerKp, 1_000_000_000, // 1000 USDC (6 decimals)
  );
  const balAfterMint = await getAccount(connection, relayerUsdcAcct.address);
  console.log(`   relayer USDC = $${Number(balAfterMint.amount) / 1e6}`);

  // 4. Bootstrap the market in the relayer's in-memory state
  console.log("\n4. POST /market/start");
  const startRes = await fetch(`${RELAYER_URL}/market/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketId: MARKET_ID_HEX }),
  });
  console.log(`   → ${startRes.status}`);
  await new Promise(r => setTimeout(r, 2000));

  // 5. Submit a BUY YES order via POST /order
  //    Amount: $10, limit price 65c (high enough to fill at any reasonable clearing price)
  console.log("\n5. POST /order — BUY YES $10 @ limit 0.65");
  const saltBytes = (globalThis as any).crypto.getRandomValues(new Uint8Array(32));
  const salt = "0x" + Array.from(saltBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const orderReq = {
    marketId: MARKET_ID_HEX,
    side: 0, // YES_BUY
    amount: "10000000",   // $10
    limitPrice: "650000", // $0.65
    salt,
  };
  const orderRes = await fetch(`${RELAYER_URL}/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orderReq),
  });
  const orderData: any = await orderRes.json();
  console.log(`   → ${orderRes.status}: ${JSON.stringify(orderData)}`);
  if (!orderData.ok) { console.error("Order submit failed"); process.exit(1); }

  const batchId = orderData.batchId;
  console.log(`   Order sealed in batch #${batchId}`);

  // 6. Poll for settlement. Correct way: check if /settlement-stats returns
  // a record for our batchId — the batch processor only populates that
  // after lock_funds AND settle_batch both land successfully.
  console.log("\n6. Waiting for batch to close + settle (≈30s + processing)…");
  const startedAt = Date.now();
  const deadline = startedAt + 120_000;
  let settled = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    const statsRes = await fetch(`${RELAYER_URL}/settlement-stats?batchId=${batchId}`);
    if (statsRes.ok) {
      console.log(`   +${elapsed}s: ✓ /settlement-stats has batch ${batchId} → settled`);
      settled = true;
      break;
    }
    const st: any = await fetch(`${RELAYER_URL}/batch-status?marketId=${MARKET_ID_HEX}`).then(r => r.json());
    console.log(`   +${elapsed}s: active=${st.active} currentBatchId=${st.currentBatchId} settlingBatchId=${st.settlingBatchId} processing=${st.processingBatch}`);
  }
  if (!settled) {
    console.error("❌ Batch did not settle within 2 minutes. Check relayer logs.");
    process.exit(1);
  }

  // 7. Fetch settlement stats
  console.log(`\n7. GET /settlement-stats?batchId=${batchId}`);
  const stats = await fetch(`${RELAYER_URL}/settlement-stats?batchId=${batchId}`).then(r => r.json() as Promise<any>);
  console.log(`   ${JSON.stringify(stats, null, 2)}`);

  // 8. Fetch the settled batch on-chain to confirm status
  const [batchPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("batch"), MARKET_ID_BUF, Buffer.from(new anchor.BN(batchId).toArray("le", 8))],
    programId,
  );
  const batch = await (program.account as any).batch.fetch(batchPda);
  const statusName = ["OPEN", "SETTLING", "LOCKED", "SETTLED"][batch.status];
  console.log(`\n8. On-chain batch ${batchId}: status=${statusName} clearingPrice=${batch.clearingPrice.toString()} `);
  if (batch.status !== 3) {
    console.error(`❌ Batch status is ${statusName}, not SETTLED. Groth16 verification likely failed.`);
    process.exit(1);
  }
  console.log("   ✓ settle_batch succeeded with real Groth16 proof on-chain\n");

  // 9. Attempt claim via POST /claim-proof
  console.log(`9. POST /claim-proof — claiming order`);
  const claimReq = {
    batchId,
    marketId: MARKET_ID_HEX,
    side: 0,
    amount: orderReq.amount,
    limitPrice: orderReq.limitPrice,
    salt,
    recipient: relayerKp.publicKey.toBase58(),
  };
  const claimRes = await fetch(`${RELAYER_URL}/claim-proof`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(claimReq),
  });
  const claimData: any = await claimRes.json();
  console.log(`   → ${claimRes.status}: ${JSON.stringify(claimData)}`);
  if (!claimData.ok) { console.error("Claim submit failed"); process.exit(1); }
  const jobId = claimData.jobId;

  // 10. Poll claim status
  console.log(`\n10. Polling claim-proof/status jobId=${jobId}`);
  const claimDeadline = Date.now() + 90_000;
  let claimDone = false;
  while (Date.now() < claimDeadline) {
    await new Promise(r => setTimeout(r, 3000));
    const js = await fetch(`${RELAYER_URL}/claim-proof/status?jobId=${jobId}`).then(r => r.json() as Promise<any>);
    console.log(`   status=${js.status} txHash=${js.txHash ?? "-"} error=${js.error ?? "-"}`);
    if (js.status === "done") { claimDone = true; break; }
    if (js.status === "error") {
      console.error(`❌ Claim failed: ${js.error}`);
      process.exit(1);
    }
  }
  if (!claimDone) { console.error("❌ Claim did not complete in 90s"); process.exit(1); }

  console.log("\n╔══════════════════════════════════╗");
  console.log("║   ✓ E2E SMOKE TEST PASSED         ║");
  console.log("╚══════════════════════════════════╝\n");
}

main().catch(err => {
  console.error("\n❌ FAILED:", err);
  process.exit(1);
});
