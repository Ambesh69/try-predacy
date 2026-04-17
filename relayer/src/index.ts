import "dotenv/config";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { loadConfig } from "./config";
import { SolanaClient } from "./solanaClient";
import { BatchProcessor } from "./batchProcessor";
import { generateClaimProof, computeNullifier } from "./zkClaimProver";
import { computeCommitment } from "./zkProver";
import { ClaimJob, OrderSide, Order } from "./types";
import { PublicKey } from "@solana/web3.js";

const config = loadConfig();
const client = new SolanaClient(config);
const processor = new BatchProcessor(
  client,
  config.circuitsPath,
  config.useRealZk,
);

// Claim job queue
const claimJobs = new Map<string, ClaimJob>();

const app = express();
app.use(cors());
app.use(express.json());

// ─── Health ───
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    relayer: config.relayerKeypair.publicKey.toBase58(),
    programId: config.programId,
    useRealZk: config.useRealZk,
  });
});

// ─── Submit Order ───
// Frontend sends order details after user commits on-chain
app.post("/order", async (req, res) => {
  try {
    const { marketId, side, amount, limitPrice, salt } = req.body;

    if (!marketId || side === undefined || !amount || !limitPrice || !salt) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const order: Order = {
      side: side as OrderSide,
      amount: BigInt(amount),
      limitPrice: BigInt(limitPrice),
      salt: BigInt(salt),
    };

    // Auto-start market if not active yet
    const marketIdHex = marketId.replace("0x", "");
    if (!processor.getMarketState(marketIdHex)) {
      const marketIdBuf = Buffer.from(marketIdHex, "hex");
      await processor.startMarket(marketIdBuf);
    }

    const result = await processor.submitOrder(marketIdHex, order);

    res.json({
      ok: true,
      batchId: result.batchId.toString(),
      commitment: result.commitment.toString(),
    });
  } catch (err: any) {
    console.error("[POST /order] Error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── Start Market ───
app.post("/market/start", async (req, res) => {
  try {
    const { marketId } = req.body;
    if (!marketId) {
      return res.status(400).json({ error: "marketId required" });
    }

    const marketIdBuf = Buffer.from(marketId.replace("0x", ""), "hex");
    await processor.startMarket(marketIdBuf);

    res.json({ ok: true, marketId });
  } catch (err: any) {
    console.error("[POST /market/start] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Batch Status ───
app.get("/batch-status", (req, res) => {
  const marketId = req.query.marketId as string;
  if (!marketId) {
    return res.status(400).json({ error: "marketId required" });
  }

  const state = processor.getMarketState(marketId.replace("0x", ""));
  if (!state) {
    // Return 200 with inactive state — no batch exists yet, but that's not an error
    return res.json({
      active: false,
      currentBatchId: null,
      settlingBatchId: null,
      orderCount: 0,
      batchRunningUsd: "0",
      processingBatch: false,
      openedAt: null,
      commitments: [],
    });
  }

  // Collect commitment hashes for the feed (without revealing amounts/sides)
  const commitments: Array<{ hash: string; timestamp: number }> = [];
  for (const [hash, order] of state.orders.entries()) {
    commitments.push({ hash: "0x" + BigInt(hash).toString(16).padStart(64, "0"), timestamp: state.batchOpenedAt * 1000 });
  }

  res.json({
    currentBatchId: state.currentBatchId?.toString() || null,
    settlingBatchId: state.settlingBatchId?.toString() || null,
    orderCount: state.orders.size,
    batchRunningUsd: state.batchRunningUsd.toString(),
    processingBatch: state.processingBatch,
    openedAt: state.batchOpenedAt,
    commitments,
  });
});

// ─── Claim Proof (Async) ───
app.post("/claim-proof", async (req, res) => {
  try {
    const {
      batchId,
      marketId,
      side,
      amount,
      limitPrice,
      salt,
      recipient,
    } = req.body;

    const jobId = uuidv4();
    const job: ClaimJob = {
      id: jobId,
      status: "pending",
      batchId: BigInt(batchId),
      marketId: Buffer.from(marketId.replace("0x", ""), "hex"),
      side: side as OrderSide,
      amount: BigInt(amount),
      limitPrice: BigInt(limitPrice),
      salt: BigInt(salt),
      recipient: new PublicKey(recipient),
    };

    claimJobs.set(jobId, job);
    res.status(202).json({ ok: true, jobId });

    // Process claim in background
    processClaimJob(job).catch(console.error);
  } catch (err: any) {
    console.error("[POST /claim-proof] Error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── Claim Status ───
app.get("/claim-proof/status", (req, res) => {
  const jobId = req.query.jobId as string;
  if (!jobId) {
    return res.status(400).json({ error: "jobId required" });
  }

  const job = claimJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json({
    status: job.status,
    txHash: job.txHash || null,
    error: job.error || null,
  });
});

// ─── Claim Job Processor ───
async function processClaimJob(job: ClaimJob): Promise<void> {
  try {
    job.status = "proving";

    const marketIdBigInt = BigInt("0x" + job.marketId.toString("hex"));
    const order: Order = {
      side: job.side,
      amount: job.amount,
      limitPrice: job.limitPrice,
      salt: job.salt,
    };

    // Fetch batch to get clearing price and commitments
    const batch = await client.fetchBatch(job.marketId, job.batchId);
    const clearingPrice = BigInt((batch as any).clearingPrice.toString());

    // TODO: Fetch all commitments from on-chain CommitmentStore
    // For now, use stored orders
    const commitment = await computeCommitment(
      marketIdBigInt, order.side, order.amount, order.limitPrice, order.salt,
    );
    const allCommitments = [commitment]; // simplified — needs all batch commitments

    const recipientBigInt = BigInt("0x" + Buffer.from(job.recipient.toBytes()).toString("hex"));

    if (config.useRealZk) {
      const result = await generateClaimProof(
        marketIdBigInt,
        order,
        job.batchId,
        clearingPrice,
        allCommitments,
        0, // leafIndex — simplified
        recipientBigInt,
        config.circuitsPath,
      );

      const nullifierBytes = bigintToBytes32Array(result.nullifier);

      job.status = "submitting";
      const txHash = await client.claimWithProof(
        job.marketId,
        job.batchId,
        nullifierBytes,
        order.side,
        result.fillAmount,
        result.refundAmount,
        Array.from(result.proof.proofA),
        Array.from(result.proof.proofB),
        Array.from(result.proof.proofC),
        job.recipient,
      );

      job.txHash = txHash;
    } else {
      // Mock proof path
      const nullifier = await computeNullifier(commitment, job.batchId, order.salt);
      const nullifierBytes = bigintToBytes32Array(nullifier);

      // Create recipient's token ATA if needed (YES or NO depending on side)
      const { getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
      const connection = client.getConnection();
      const isBuy = order.side === 0 || order.side === 2; // YES_BUY or NO_BUY
      const isYes = order.side === 0 || order.side === 1; // YES_BUY or YES_SELL
      let recipientAta: PublicKey;
      if (isBuy) {
        // Buyer receives YES or NO tokens
        const [mint] = isYes ? client.yesMintPda(job.marketId) : client.noMintPda(job.marketId);
        const ata = await getOrCreateAssociatedTokenAccount(connection, config.relayerKeypair, mint, job.recipient);
        recipientAta = ata.address;
      } else {
        // Seller receives USDC refund
        const protocolCfg = await client.fetchProtocolConfig();
        const usdcMint = (protocolCfg as any).usdcMint as PublicKey;
        const ata = await getOrCreateAssociatedTokenAccount(connection, config.relayerKeypair, usdcMint, job.recipient);
        recipientAta = ata.address;
      }

      job.status = "submitting";
      const txHash = await client.claimWithProof(
        job.marketId,
        job.batchId,
        nullifierBytes,
        order.side,
        order.amount, // simplified fill amount
        0n,
        new Array(64).fill(0),
        new Array(128).fill(0),
        new Array(64).fill(0),
        recipientAta,
      );
      job.txHash = txHash;
    }

    job.status = "done";
    console.log(`[ClaimJob] ${job.id} completed: ${job.txHash}`);
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    console.error(`[ClaimJob] ${job.id} failed:`, err.message);
  }
}

function bigintToBytes32Array(n: bigint): number[] {
  const buf = new Array(32).fill(0);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

// ─── Faucet (devnet mock USDC) ───
app.post("/faucet", async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const recipientPubkey = new PublicKey(wallet);
    const amount = 1000_000_000; // 1000 USDC (6 decimals)

    // Get USDC mint from protocol config
    const protocolConfig = await client.fetchProtocolConfig();
    const usdcMint = (protocolConfig as any).usdcMint as PublicKey;

    // Import SPL token helpers
    const { getOrCreateAssociatedTokenAccount, mintTo } = await import("@solana/spl-token");
    const connection = client.getConnection();
    const relayerKeypair = config.relayerKeypair;

    // Create ATA for recipient if needed
    const ata = await getOrCreateAssociatedTokenAccount(
      connection, relayerKeypair, usdcMint, recipientPubkey,
    );

    // Mint mock USDC
    await mintTo(connection, relayerKeypair, usdcMint, ata.address, relayerKeypair, amount);

    console.log(`[Faucet] Minted 1000 USDC to ${wallet}`);
    res.json({ ok: true, amount: "1000", mint: usdcMint.toBase58(), ata: ata.address.toBase58() });
  } catch (err: any) {
    console.error("[Faucet] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Token Balances ───
app.get("/balances", async (req, res) => {
  try {
    const wallet = req.query.wallet as string;
    const marketId = req.query.marketId as string;
    if (!wallet || !marketId) return res.status(400).json({ error: "wallet and marketId required" });

    const { getAssociatedTokenAddress, getAccount } = await import("@solana/spl-token");
    const connection = client.getConnection();
    const ownerPubkey = new PublicKey(wallet);
    const marketIdBuf = Buffer.from(marketId.replace("0x", ""), "hex");

    const protocolCfg = await client.fetchProtocolConfig();
    const usdcMint = (protocolCfg as any).usdcMint as PublicKey;
    const [yesMint] = client.yesMintPda(marketIdBuf);
    const [noMint] = client.noMintPda(marketIdBuf);

    const getBalance = async (mint: PublicKey): Promise<string> => {
      try {
        const ata = await getAssociatedTokenAddress(mint, ownerPubkey);
        const account = await getAccount(connection, ata);
        return account.amount.toString();
      } catch {
        return "0";
      }
    };

    const [usdc, yes, no] = await Promise.all([
      getBalance(usdcMint),
      getBalance(yesMint),
      getBalance(noMint),
    ]);

    res.json({ usdc, yes, no });
  } catch (err: any) {
    console.error("[Balances] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ───
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   Predacy Relayer v0.1.0                  ║
║   Port: ${PORT}                              ║
║   RPC: ${config.solanaRpcUrl.slice(0, 30).padEnd(30)}    ║
║   Program: ${config.programId.slice(0, 22)}...  ║
║   ZK Mode: ${config.useRealZk ? "REAL  " : "MOCK  "}                         ║
╚═══════════════════════════════════════════╝
  `);
});

export default app;
