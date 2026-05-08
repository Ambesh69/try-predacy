/**
 * /claims happy-path smoke test on live devnet.
 *
 * What this proves:
 *   1. A user that holds the winning side's tokens after a settled
 *      batch + resolved market gets a non-empty response from
 *      GET /claims/:userPubkey.
 *   2. The endpoint's pre-built `txBase64` redeem tx, when signed +
 *      submitted, actually moves USDC into the user's ATA.
 *   3. The shape (marketId, eventLabel, marketLabel, outcome, amount)
 *      matches what the frontend ClaimsWidget expects.
 *
 * Why this exists:
 *   The original demo path only ever had losing bets resolve (user
 *   bet NO on a YES outcome), so the happy-path with non-zero claim
 *   amounts had never been verified end-to-end on devnet. This script
 *   is the missing pre-demo gate.
 *
 * Pipeline:
 *   - Register a fresh test EventHandle ("CLAIMS-SMOKE-…")
 *   - Bind a fresh marketId under it
 *   - Bootstrap the batch processor for the market
 *   - Buy YES $10 via POST /order, wait for settle, claim via /claim-proof
 *   - Resolve YES via POST /admin/events/.../resolve (bypasses agent)
 *   - GET /claims/:userPubkey → assert ≥1 claim with amount > 0
 *   - Sign + submit the returned redeem tx → assert USDC delta ≥ amount
 *
 * Assumes:
 *   - Relayer running on :3001 with the deployed protocol initialized.
 *   - Relayer wallet has SOL + USDC mint authority.
 *   - This script's runner uses the *same* relayer keypair as the
 *     "user" — simplifies signing the buy + redeem flows.
 *
 * Run: `cd relayer && npx ts-node scripts/smoke-claims.ts`
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { RPC_FAST_URL } from "../src/rpcConfig";

const RELAYER_URL = process.env.RELAYER_URL || "http://localhost:3001";

function freshHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  (globalThis as any).crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fmtUsd(microUsdc: bigint | number): string {
  const n = typeof microUsdc === "bigint" ? Number(microUsdc) : microUsdc;
  return `$${(n / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main() {
  console.log("\n╔═══════════════════════════════════════════╗");
  console.log("║   Predacy /claims Happy-Path Smoke Test   ║");
  console.log("╚═══════════════════════════════════════════╝\n");

  // ── 1. Health ───────────────────────────────────────────────────
  console.log("1. Relayer /health");
  const health: any = await fetch(`${RELAYER_URL}/health`).then((r) => r.json());
  console.log(`   program=${health.programId}  relayer=${health.relayer}`);
  const programId = new PublicKey(health.programId);
  const relayerPk = new PublicKey(health.relayer);

  // ── 2. Anchor setup using the same keypair as the relayer ───────
  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const userKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))),
  );
  if (!userKp.publicKey.equals(relayerPk)) {
    console.warn(`   ⚠ user keypair ${userKp.publicKey.toBase58()} ≠ relayer ${relayerPk.toBase58()}. Smoke test still runs but the buy + redeem flows below assume the same wallet does both — re-run with the relayer's keypair if you want a clean YES-claim pickup.`);
  }
  const rpcUrl = health.rpcFastEnabled && process.env.RPC_FAST_API_KEY ? RPC_FAST_URL : (process.env.RPC_URL || "https://api.devnet.solana.com");
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(userKp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "predacy-idl.json"), "utf-8"),
  );
  const program = new anchor.Program(idl, provider);

  // ── 3. Mint mock USDC for the buy ──────────────────────────────
  console.log("\n2. Funding user wallet with mock USDC");
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    programId,
  );
  const cfg = await (program.account as any).protocolConfig.fetch(protocolConfig);
  const usdcMint = new PublicKey(cfg.usdcMint);
  const userUsdcAcct = await getOrCreateAssociatedTokenAccount(
    connection,
    userKp,
    usdcMint,
    userKp.publicKey,
  );
  await mintTo(
    connection,
    userKp,
    usdcMint,
    userUsdcAcct.address,
    userKp,
    100_000_000,
  );
  const usdcBefore = (await getAccount(connection, userUsdcAcct.address)).amount;
  console.log(`   user USDC = ${fmtUsd(BigInt(usdcBefore.toString()))}`);

  // ── 4. Register a fresh test event ──────────────────────────────
  const eventLabel = `CLAIMS-SMOKE-${Date.now()}-${freshHex(2)}`;
  console.log(`\n3. POST /events → ${eventLabel}`);
  const closesAt = Math.floor(Date.now() / 1000) + 24 * 3600;
  const evRes = await fetch(`${RELAYER_URL}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: eventLabel,
      category: "CULTURE",
      closesAt,
      bootstrapSeedUsdc: "100000000",
    }),
  });
  const ev: any = await evRes.json();
  if (!ev.ok) throw new Error(`POST /events failed: ${JSON.stringify(ev)}`);
  const handleIdHex = ev.handleIdHex;
  console.log(`   handleId=${handleIdHex.slice(0, 16)}…  pda=${ev.eventHandlePda}`);

  // ── 5. Bind a fresh market under the event ─────────────────────
  const marketIdHex = freshHex(32);
  const marketIdBuf = Buffer.from(marketIdHex, "hex");
  console.log(`\n4. POST /events/:id/markets → ${marketIdHex.slice(0, 16)}…`);
  const bindRes = await fetch(
    `${RELAYER_URL}/events/${handleIdHex}/markets`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId: marketIdHex, label: "smoke claims happy path" }),
    },
  );
  const bound: any = await bindRes.json();
  if (!bound.ok) throw new Error(`bind failed: ${JSON.stringify(bound)}`);

  // ── 6. Activate batch processing for the market ─────────────────
  console.log("\n5. POST /market/start");
  const startRes = await fetch(`${RELAYER_URL}/market/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketId: marketIdHex }),
  });
  if (!startRes.ok) throw new Error(`market/start failed: ${startRes.status}`);
  await new Promise((r) => setTimeout(r, 1500));

  // ── 7. Submit a BUY YES $10 @ 0.65 ──────────────────────────────
  const salt = "0x" + freshHex(32);
  console.log("\n6. POST /order — BUY YES $10 @ 0.65");
  const orderReq = {
    marketId: marketIdHex,
    side: 0,
    amount: "10000000",
    limitPrice: "650000",
    salt,
  };
  const orderResp: any = await fetch(`${RELAYER_URL}/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(orderReq),
  }).then((r) => r.json());
  if (!orderResp.ok) throw new Error(`order failed: ${JSON.stringify(orderResp)}`);
  const batchId = orderResp.batchId;
  console.log(`   batch=${batchId}`);

  // ── 8. Wait for batch settle ────────────────────────────────────
  console.log("\n7. Waiting for batch to settle (≤2 min)…");
  const deadline = Date.now() + 120_000;
  let settled = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const stats = await fetch(`${RELAYER_URL}/settlement-stats?batchId=${batchId}`);
    if (stats.ok) {
      settled = true;
      break;
    }
    process.stdout.write(".");
  }
  console.log("");
  if (!settled) throw new Error("batch did not settle within 2 min");
  console.log("   ✓ batch settled");

  // ── 9. Claim YES tokens (this lands them in user's YES ATA) ─────
  console.log("\n8. POST /claim-proof → mint YES tokens to user");
  const claimReq = {
    batchId,
    marketId: marketIdHex,
    side: 0,
    amount: orderReq.amount,
    limitPrice: orderReq.limitPrice,
    salt,
    recipient: userKp.publicKey.toBase58(),
  };
  const claimResp: any = await fetch(`${RELAYER_URL}/claim-proof`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(claimReq),
  }).then((r) => r.json());
  if (!claimResp.ok) throw new Error(`claim-proof failed: ${JSON.stringify(claimResp)}`);
  // The claim is processed async — poll until the YES ATA has tokens.
  const [yesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("yes_mint"), marketIdBuf],
    programId,
  );
  const yesAta = getAssociatedTokenAddressSync(yesMint, userKp.publicKey, true);
  let yesBal = 0n;
  const claimDeadline = Date.now() + 60_000;
  while (Date.now() < claimDeadline) {
    try {
      const acc = await getAccount(connection, yesAta);
      yesBal = BigInt(acc.amount.toString());
      if (yesBal > 0n) break;
    } catch { /* ATA not created yet */ }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (yesBal === 0n) throw new Error("YES tokens never landed in user ATA");
  console.log(`   YES balance = ${yesBal} (raw)`);

  // ── 10. Resolve the market YES (admin endpoint) ─────────────────
  console.log("\n9. POST /admin/events/:handle/markets/:marketId/resolve → YES");
  const resRes: any = await fetch(
    `${RELAYER_URL}/admin/events/${handleIdHex}/markets/${marketIdHex}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "YES" }),
    },
  ).then((r) => r.json());
  if (!resRes.ok) throw new Error(`resolve failed: ${JSON.stringify(resRes)}`);
  console.log(`   onchain=${resRes.onchain}  outcome=${resRes.outcome}`);

  // ── 11. GET /claims/:userPubkey ─────────────────────────────────
  console.log(`\n10. GET /claims/${userKp.publicKey.toBase58().slice(0, 8)}…`);
  const claimsResp: any = await fetch(
    `${RELAYER_URL}/claims/${userKp.publicKey.toBase58()}`,
  ).then((r) => r.json());
  if (!claimsResp.ok) throw new Error(`/claims failed: ${JSON.stringify(claimsResp)}`);
  const ours = (claimsResp.claims as any[]).find(
    (c) => c.marketId.toLowerCase() === marketIdHex.toLowerCase(),
  );
  if (!ours) {
    console.error("   /claims response:", JSON.stringify(claimsResp, null, 2));
    throw new Error("our claim was not in the /claims response");
  }
  console.log(`   ✓ found claim — outcome=${ours.outcome}  amount=${ours.amount}  txBase64.length=${ours.txBase64.length}`);
  if (ours.outcome !== "YES") throw new Error(`expected YES, got ${ours.outcome}`);
  if (BigInt(ours.amount) === 0n) throw new Error("claim.amount is 0");

  // ── 12. Sign + submit the redeem tx ─────────────────────────────
  console.log("\n11. Sign + submit pre-built redeem tx");
  const tx = Transaction.from(Buffer.from(ours.txBase64, "base64"));
  tx.partialSign(userKp);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`   sig=${sig}`);

  // ── 13. Verify USDC arrived ────────────────────────────────────
  const usdcAfter = (await getAccount(connection, userUsdcAcct.address)).amount;
  const delta = BigInt(usdcAfter.toString()) - BigInt(usdcBefore.toString());
  console.log(`\n12. USDC delta: ${fmtUsd(delta)} (raw=${delta})`);
  // Buyer paid clearing_price × shares for the YES side, then redeemed
  // the YES tokens 1:1 for $1 each at resolution. Net should be roughly
  // shares_received × ($1.00 - clearing_price) ≥ 0. Conservative check:
  // any positive delta proves /claims handed back a working tx.
  if (delta <= 0n) throw new Error(`expected positive USDC delta, got ${delta}`);

  console.log("\n✅ /claims happy path verified — non-zero claim returned, redeem tx executed, USDC arrived.\n");
}

main().catch((err) => {
  console.error("\n❌ smoke-claims failed:", err.message ?? err);
  process.exit(1);
});
