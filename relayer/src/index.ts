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
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getStreamer, GrpcEvent } from "./grpcStreamer";
import { getLogStreamer, StreamEvent } from "./logStreamer";
import { getIkaManager } from "./ika";

const config = loadConfig();
const client = new SolanaClient(config);
const processor = new BatchProcessor(
  client,
  config.circuitsPath,
  config.useRealZk,
);

// WebSocket-based log streamer — works on any RPC with WSS (RPC Fast Hackathon
// plan, public RPC, etc.). Primary path for Predacy program event streaming.
const logStreamer = getLogStreamer(client.getConnection(), config);
logStreamer.start().catch((err) => console.error("[logStreamer] Start failed:", err));

// Yellowstone gRPC streamer — optional upgrade path for RPC Fast Stream/Aperture
// plans (sub-ms latency, richer filters). Only starts when RPC_FAST_GRPC_ENABLED=true.
// When disabled (default), logStreamer handles everything.
const grpcStreamer = getStreamer(config);
if (config.rpcFastGrpcEnabled) {
  grpcStreamer.start().catch((err) => console.error("[grpcStreamer] Start failed:", err));
}

// Ika Pre-Alpha dWallet manager. Lazy-initialized on first request; noop
// when IKA_ENABLED != "true". Architecture §4 — backend-delegated DKG so
// users never see a Sui wallet or need to manage their own Ika shares.
const ikaManager = getIkaManager(config, client.getConnection());

// Claim job queue
const claimJobs = new Map<string, ClaimJob>();

// SSE subscriber registry — each connected frontend gets its own response object.
// When events arrive (from either log or gRPC streamer), fan out to subscribers.
const sseSubscribers = new Set<express.Response>();

const fanOut = (event: StreamEvent | GrpcEvent) => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseSubscribers) {
    try {
      res.write(payload);
    } catch { /* subscriber dropped; will be cleaned up on next close */ }
  }
};

logStreamer.on("event", fanOut);
grpcStreamer.on("event", fanOut);

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
    rpcFastEnabled: config.rpcFastEnabled,
    logStreaming: true,
    grpcStreaming: config.rpcFastGrpcEnabled && grpcStreamer.enabled,
    feeSponsorship: {
      available: true,
      ratePerMinute: FEE_RATE_LIMIT_PER_MIN,
    },
    ika: ikaManager.getStoreSummary(),
  });
});

// ─── Ika dWallet ──────────────────────────────────────────────────────
// Architecture §4 — backend-delegated Ika dWallets (A1). The relayer runs
// DKG on the user's behalf, stores the attestation, and drives sign flows
// when needed. Users never see Sui or need their own Ika onboarding.
//
// Pre-Alpha caveat: signing uses a single mock signer, not real 2PC-MPC.
// Real MPC ships with Ika Alpha 1. Integration shape is correct either way.

app.post("/ika/dwallet", async (req, res) => {
  try {
    const { userWallet, curve } = req.body;
    if (!userWallet) return res.status(400).json({ error: "userWallet required" });
    if (!ikaManager.enabled) return res.status(503).json({ error: "IKA_ENABLED=false on this relayer" });
    const chosenCurve: "Curve25519" | "Secp256k1" = curve === "Secp256k1" ? "Secp256k1" : "Curve25519";
    const record = await ikaManager.ensureDWallet(userWallet, chosenCurve);
    res.json({ ok: true, dwallet: record });
  } catch (err: any) {
    console.error("[ika/dwallet] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/ika/presign", async (req, res) => {
  try {
    const { userWallet } = req.body;
    if (!userWallet) return res.status(400).json({ error: "userWallet required" });
    if (!ikaManager.enabled) return res.status(503).json({ error: "IKA_ENABLED=false on this relayer" });
    const presignId = await ikaManager.requestPresign(userWallet);
    res.json({ ok: true, presignId: Buffer.from(presignId).toString("hex") });
  } catch (err: any) {
    console.error("[ika/presign] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /ika/transfer-authority — move dWallet authority from the DKG payer
// (relayer keypair) to Predacy's CPI authority PDA. Required before the
// Predacy program can approve_message on this dWallet. Idempotent.
app.post("/ika/transfer-authority", async (req, res) => {
  try {
    const { userWallet } = req.body;
    if (!userWallet) return res.status(400).json({ error: "userWallet required" });
    if (!ikaManager.enabled) return res.status(503).json({ error: "IKA_ENABLED=false on this relayer" });
    const record = await ikaManager.transferDWalletToPredacy(userWallet);
    res.json({ ok: true, dwallet: record });
  } catch (err: any) {
    console.error("[ika/transfer-authority] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /ika/approve-and-sign — complete end-to-end Sign flow in one call.
//   1. Hash the message to produce a 32-byte digest.
//   2. Derive MessageApproval PDA on Ika's program.
//   3. Call predacy.approve_ika_message (CPI into Ika creates the PDA).
//   4. Request a presign via Ika gRPC.
//   5. Request Sign via Ika gRPC, passing the approve tx signature + slot.
//   6. Return the final signature.
//
// Requires: the user's dWallet exists AND authority is transferred to Predacy
// CPI PDA (call /ika/dwallet + /ika/transfer-authority first).
//
// body: { userWallet: string, message: base64 }
// response: { ok: true, signature: hex, messageApprovalPda, approveTxSignature, approveSlot }
app.post("/ika/approve-and-sign", async (req, res) => {
  try {
    const { userWallet, message } = req.body;
    if (!userWallet || !message) {
      return res.status(400).json({ error: "userWallet + message required" });
    }
    if (!ikaManager.enabled) return res.status(503).json({ error: "IKA_ENABLED=false on this relayer" });

    const record = ikaManager.getDWallet(userWallet);
    if (!record) return res.status(404).json({ error: "No dWallet for user — call /ika/dwallet first" });
    if (!record.authorityTransferred) return res.status(400).json({ error: "Authority not transferred — call /ika/transfer-authority first" });

    const { keccak_256 } = await import("@noble/hashes/sha3.js");
    const bs58mod = await import("bs58");
    const bs58 = (bs58mod as any).default ?? bs58mod;

    const messageBytes = Uint8Array.from(Buffer.from(message, "base64"));
    const pubkeyBytes = Uint8Array.from(Buffer.from(record.publicKey, "hex"));

    // Pick curve + signature scheme. Despite the "EddsaSha512" name, Ika's
    // Pre-Alpha server hashes messages with Keccak-256 for all schemes when
    // computing the MessageApproval PDA. Verified empirically on devnet —
    // using sha256 or sha512 produces a digest that the server doesn't match.
    const curveByte = record.curve === "Curve25519" ? 2 : 0;
    const sigScheme = record.curve === "Curve25519" ? 5 : 0; // 5=EddsaSha512, 0=EcdsaKeccak256
    const digest = keccak_256(messageBytes);

    // Derive MessageApproval PDA — seeds mirror findMessageApprovalPda in
    // dwallet-labs/ika-pre-alpha's _shared/ika-setup.ts.
    const ikaProgramId = ikaManager.getProgramId();
    const payload = Buffer.alloc(2 + pubkeyBytes.length);
    payload.writeUInt16LE(curveByte, 0);
    Buffer.from(pubkeyBytes).copy(payload, 2);
    const pubkeyChunks: Buffer[] = [];
    for (let i = 0; i < payload.length; i += 32) {
      pubkeyChunks.push(payload.subarray(i, Math.min(i + 32, payload.length)));
    }
    const schemeBuf = Buffer.alloc(2);
    schemeBuf.writeUInt16LE(sigScheme, 0);
    const maSeeds = [
      Buffer.from("dwallet"),
      ...pubkeyChunks,
      Buffer.from("message_approval"),
      schemeBuf,
      Buffer.from(digest),
    ];
    const [messageApprovalPda, messageApprovalBump] = PublicKey.findProgramAddressSync(maSeeds, ikaProgramId);

    // Derive Predacy CPI authority PDA and Ika coordinator PDA
    const [cpiAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("__ika_cpi_authority")],
      new PublicKey(config.programId),
    );
    const [coordinator] = PublicKey.findProgramAddressSync(
      [Buffer.from("dwallet_coordinator")],
      ikaProgramId,
    );

    // Call predacy.approve_ika_message via the Anchor client
    const predacy = (client as any).program;
    const txSig: string = await predacy.methods
      .approveIkaMessage(
        Array.from(digest),
        Array.from(new Uint8Array(32)), // message_metadata_digest (empty)
        Array.from(pubkeyBytes.slice(0, 32)), // user_pubkey (truncate Secp256k1 to 32)
        sigScheme,
        messageApprovalBump,
      )
      .accounts({
        ikaProgram: ikaProgramId,
        ikaCoordinator: coordinator,
        messageApproval: messageApprovalPda,
        dwallet: new PublicKey(record.dwalletPda),
        cpiAuthority,
        predacyProgram: new PublicKey(config.programId),
        payer: config.relayerKeypair.publicKey,
      })
      .rpc();

    // Confirm and get the slot
    const conn = client.getConnection();
    await conn.confirmTransaction(txSig, "confirmed");
    const txInfo = await conn.getTransaction(txSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!txInfo) throw new Error("approve tx not found after confirmation");
    const slot = txInfo.slot;
    const approveTxBytes = Buffer.from(bs58.decode(txSig));

    // Allocate a presign
    const presignId = await ikaManager.requestPresign(userWallet);

    // Request Sign with the real approval proof
    const result = await ikaManager.signMessage(
      userWallet,
      messageBytes,
      presignId,
      approveTxBytes.toString("base64"),
      BigInt(slot),
    );

    res.json({
      ok: true,
      signature: Buffer.from(result.signature).toString("hex"),
      messageApprovalPda: messageApprovalPda.toBase58(),
      approveTxSignature: txSig,
      approveSlot: slot,
      sigScheme,
      digest: Buffer.from(digest).toString("hex"),
    });
  } catch (err: any) {
    console.error("[ika/approve-and-sign] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /ika/sign — request a signature from the user's dWallet.
//   body: {
//     userWallet:            string,              // which dWallet
//     message:               base64,              // bytes to sign
//     presignId:             hex,                 // from /ika/presign
//     approvalTxSignature?:  base64,              // Solana tx that CPI'd approve_message
//     approvalSlot?:         string | number,     // slot of that tx
//   }
// When approval params are omitted, placeholders are used — works on the
// Pre-Alpha mock signer for demo; real Alpha 1 will require the real CPI.
app.post("/ika/sign", async (req, res) => {
  try {
    const { userWallet, message, presignId, approvalTxSignature, approvalSlot } = req.body;
    if (!userWallet || !message || !presignId) {
      return res.status(400).json({ error: "userWallet, message, presignId required" });
    }
    if (!ikaManager.enabled) return res.status(503).json({ error: "IKA_ENABLED=false on this relayer" });

    const messageBytes = Uint8Array.from(Buffer.from(message, "base64"));
    const presignBytes = Uint8Array.from(Buffer.from(presignId, "hex"));
    const slot = approvalSlot !== undefined ? BigInt(approvalSlot) : undefined;

    const result = await ikaManager.signMessage(
      userWallet, messageBytes, presignBytes, approvalTxSignature, slot,
    );
    res.json({ ok: true, signature: Buffer.from(result.signature).toString("hex") });
  } catch (err: any) {
    console.error("[ika/sign] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SSE event stream (replaces polling) ───
// Frontend subscribes via EventSource. When RPC Fast gRPC is active, pushes
// on-chain events (commit_order, settle_batch, claim) in near-real time.
// When gRPC is disabled, this endpoint stays open but emits no events —
// frontend should fall back to /batch-status polling.
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  // Welcome event — lets client know which streaming mode is active.
  res.write(`event: ready\ndata: ${JSON.stringify({
    logStreaming: true,
    grpcStreaming: config.rpcFastGrpcEnabled && grpcStreamer.enabled,
  })}\n\n`);

  sseSubscribers.add(res);

  // Keep-alive ping every 30s so browsers don't time out the connection
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* dropped */ }
  }, 30_000);

  req.on("close", () => {
    clearInterval(ping);
    sseSubscribers.delete(res);
  });
});

// ─── Fee Sponsorship ───
// Relayer signs as fee payer for ephemeral-authored transactions, keeping
// Alice's main wallet completely absent from Tx B. Architecture §7.
//
// Request: { transaction: base64, ephemeralPubkey: string }
// The client builds the tx with ephemeral as signer, relayer as fee payer,
// partially signs with the ephemeral key, then sends the serialized tx here.
// We co-sign as fee payer and submit. Client gets the signature back.
//
// Anti-abuse:
//   - Fee payer MUST be this relayer's pubkey (prevent arbitrary tx submission)
//   - All instructions MUST target the Predacy program (no open relay)
//   - Per-ephemeral rate limit (5 requests per 60 seconds)
const FEE_RATE_LIMIT_PER_MIN = 5;
const feeRateLimit = new Map<string, { count: number; resetAt: number }>();

function checkFeeRateLimit(ephemeralPubkey: string): { ok: boolean; retryIn?: number } {
  const now = Date.now();
  const entry = feeRateLimit.get(ephemeralPubkey);
  if (!entry || now >= entry.resetAt) {
    feeRateLimit.set(ephemeralPubkey, { count: 1, resetAt: now + 60_000 });
    return { ok: true };
  }
  if (entry.count >= FEE_RATE_LIMIT_PER_MIN) {
    return { ok: false, retryIn: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true };
}

app.post("/sponsor-fee", async (req, res) => {
  try {
    const { transaction: txBase64, ephemeralPubkey } = req.body;
    if (!txBase64 || !ephemeralPubkey) {
      return res.status(400).json({ error: "transaction and ephemeralPubkey required" });
    }

    // Rate limit per ephemeral
    const rl = checkFeeRateLimit(ephemeralPubkey);
    if (!rl.ok) {
      return res.status(429).json({ error: `Rate limited, retry in ${rl.retryIn}s` });
    }

    // Deserialize — try legacy first, fall back to versioned
    const txBuf = Buffer.from(txBase64, "base64");
    let isVersioned = false;
    let tx: Transaction | VersionedTransaction;
    try {
      tx = Transaction.from(txBuf);
    } catch {
      try {
        tx = VersionedTransaction.deserialize(txBuf);
        isVersioned = true;
      } catch (e: any) {
        return res.status(400).json({ error: `Could not deserialize transaction: ${e.message}` });
      }
    }

    // Verify fee payer == relayer. If the client built it wrong or is trying
    // to route arbitrary txs through us, reject.
    const relayerPk = config.relayerKeypair.publicKey;
    if (isVersioned) {
      const vtx = tx as VersionedTransaction;
      const payer = vtx.message.staticAccountKeys[0];
      if (!payer.equals(relayerPk)) {
        return res.status(400).json({ error: "Fee payer must be the relayer" });
      }
    } else {
      const ltx = tx as Transaction;
      if (!ltx.feePayer || !ltx.feePayer.equals(relayerPk)) {
        return res.status(400).json({ error: "Fee payer must be the relayer" });
      }
    }

    // Verify all instructions target an allowed program. Prevents open relay.
    // Allowed programs:
    //   - Predacy (our program) — order commits, approve_ika_message, etc.
    //   - SPL Token program — "Move to address" transfers from ephemeral ATAs
    //   - SPL Associated Token — creating destination ATAs on demand
    //   - System program — tiny SOL transfers (rent / exempt accounts)
    const programPk = new PublicKey(config.programId);
    const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
    const ALLOWED = [programPk, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM];
    const instructionProgramIds: PublicKey[] = isVersioned
      ? (tx as VersionedTransaction).message.compiledInstructions.map((ix) =>
          (tx as VersionedTransaction).message.staticAccountKeys[ix.programIdIndex],
        )
      : (tx as Transaction).instructions.map((ix) => ix.programId);
    for (const pid of instructionProgramIds) {
      if (!ALLOWED.some((a) => a.equals(pid))) {
        return res.status(400).json({
          error: `Instruction targets disallowed program (${pid.toBase58()}). Sponsor supports Predacy + SPL Token + Associated Token + System programs only.`,
        });
      }
    }

    // Co-sign as fee payer and submit
    const connection = client.getConnection();
    if (isVersioned) {
      const vtx = tx as VersionedTransaction;
      vtx.sign([config.relayerKeypair]);
      const sig = await connection.sendTransaction(vtx, { skipPreflight: false });
      return res.json({ ok: true, signature: sig });
    } else {
      const ltx = tx as Transaction;
      ltx.partialSign(config.relayerKeypair);
      const sig = await connection.sendRawTransaction(ltx.serialize(), { skipPreflight: false });
      return res.json({ ok: true, signature: sig });
    }
  } catch (err: any) {
    console.error("[sponsor-fee] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
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
    active: state.currentBatchId !== null,
    currentBatchId: state.currentBatchId?.toString() || null,
    settlingBatchId: state.settlingBatchId?.toString() || null,
    orderCount: state.orders.size,
    batchRunningUsd: state.batchRunningUsd.toString(),
    processingBatch: state.processingBatch,
    openedAt: state.batchOpenedAt,
    settlingStartedAt: state.settlingStartedAt,
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

    res.json({
      usdc,
      yes,
      no,
      // Mint addresses for clients that need to construct SPL transfers
      // (e.g. "Move to address" from an ephemeral ATA).
      mints: {
        usdc: usdcMint.toBase58(),
        yes: yesMint.toBase58(),
        no: noMint.toBase58(),
      },
    });
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
