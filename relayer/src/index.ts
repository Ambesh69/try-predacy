import "dotenv/config";
import express from "express";
import cors from "cors";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { loadConfig } from "./config";
import { SolanaClient } from "./solanaClient";
import { BatchProcessor } from "./batchProcessor";
import { generateClaimProof, computeNullifier, pubkeyToFieldElement } from "./zkClaimProver";
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
  {
    privacyMode: config.privacyMode,
    fheBackend: config.fheBackend,
  },
);

// Single-line error formatter — stops Node's default Error stringification
// (which spills the stack across multiple Railway log lines on every
// transient OpenAI 429 / network blip) from blowing up log volume.
const oneLineErr = (err: unknown, max = 200): string => {
  const raw = err instanceof Error
    ? err.message
    : typeof err === "string"
      ? err
      : err == null
        ? "(unknown error)"
        : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
};

// WebSocket-based log streamer — works on any RPC with WSS (RPC Fast,
// public RPC, etc.). Primary path for Predacy program event streaming.
const logStreamer = getLogStreamer(client.getConnection(), config);
logStreamer.start().catch((err) => console.error(`[logStreamer] Start failed: ${oneLineErr(err)}`));

// Yellowstone gRPC streamer — optional upgrade path for RPC Fast Stream/Aperture
// plans (sub-ms latency, richer filters). Only starts when RPC_FAST_GRPC_ENABLED=true.
// When disabled (default), logStreamer handles everything.
const grpcStreamer = getStreamer(config);
if (config.rpcFastGrpcEnabled) {
  grpcStreamer.start().catch((err) => console.error(`[grpcStreamer] Start failed: ${oneLineErr(err)}`));
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
// Build identity — surfaced to /health so we know which deploy is live.
// RAILWAY_GIT_COMMIT_SHA is auto-injected by Railway; falls back to
// reading the synthetic .build-sha file written by Dockerfile if present.
const BUILD_SHA = (() => {
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 12);
  try {
    const f = path.join(__dirname, "..", ".build-sha");
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf-8").trim().slice(0, 12);
  } catch { /* noop */ }
  return "unknown";
})();

// Circuits artifact check — proves the Dockerfile copied /circuits/ into
// the container. If false, snarkjs proof generation will crash with ENOENT.
const CIRCUITS_OK = (() => {
  try {
    const wasm = path.join(config.circuitsPath, "batch_clearing/batch_clearing_js/batch_clearing.wasm");
    const zkey = path.join(config.circuitsPath, "setup/batch_clearing_final.zkey");
    return fs.existsSync(wasm) && fs.existsSync(zkey);
  } catch {
    return false;
  }
})();

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    build: BUILD_SHA,
    relayer: config.relayerKeypair.publicKey.toBase58(),
    programId: config.programId,
    useRealZk: config.useRealZk,
    privacyMode: config.privacyMode,
    fheBackend: config.privacyMode === "strict" ? config.fheBackend : null,
    rpcFastEnabled: config.rpcFastEnabled,
    logStreaming: true,
    grpcStreaming: config.rpcFastGrpcEnabled && grpcStreamer.enabled,
    grpcConnected: grpcStreamer.connected,
    grpcReconnects: grpcStreamer.reconnects,
    circuitsOk: CIRCUITS_OK,
    circuitsPath: config.circuitsPath,
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
    // @ts-ignore
    const bs58mod: any = await import("bs58");
    const bs58: any = bs58mod.default ?? bs58mod;

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
app.get("/stream", (req, res) => {
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

// ─── LP registry — Polygon USDC liquidity market (mock, devnet) ───
// See lpRegistry.ts for the design. LPs quote Polygon USDC for CLOB
// residuals at a basis-point fee; the relayer's polymarketRouter picks
// the cheapest available LP per batch. Real Ika-orchestrated atomic swaps
// are Todo #19.
app.get("/lps", (_req, res) => {
  const { getLPRegistry } = require("./lpRegistry");
  const registry = getLPRegistry();
  res.json({
    lps: registry.list().map((lp: any) => ({
      ...lp,
      availableUsdc: lp.availableUsdc.toString(),
      earnedFeesUsdc: lp.earnedFeesUsdc.toString(),
      totalVolumeUsdc: lp.totalVolumeUsdc.toString(),
    })),
  });
});

app.post("/lps/register", (req, res) => {
  try {
    const {
      id,
      displayName,
      solanaReceiveAddress,
      polygonPayoutAddress,
      availableUsdc,
      feeBps,
    } = req.body;
    if (!id || !displayName || !solanaReceiveAddress || !polygonPayoutAddress) {
      return res.status(400).json({ error: "missing required fields" });
    }
    const { getLPRegistry } = require("./lpRegistry");
    const lp = getLPRegistry().register({
      id,
      displayName,
      solanaReceiveAddress,
      polygonPayoutAddress,
      availableUsdc: BigInt(availableUsdc ?? 0),
      feeBps: Number(feeBps ?? 20),
    });
    res.json({
      ok: true,
      lp: {
        ...lp,
        availableUsdc: lp.availableUsdc.toString(),
        earnedFeesUsdc: lp.earnedFeesUsdc.toString(),
        totalVolumeUsdc: lp.totalVolumeUsdc.toString(),
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/lps/:id/active", (req, res) => {
  const { active } = req.body;
  const { getLPRegistry } = require("./lpRegistry");
  const ok = getLPRegistry().setActive(req.params.id, Boolean(active));
  if (!ok) return res.status(404).json({ error: "LP not found" });
  res.json({ ok: true });
});

// ─── Cross-chain bundle (Ika orchestrator) ───
// Planned legs for a settled batch: unlock Solana → LP fund Polygon →
// Polymarket execute → distribute. See ikaOrchestrator.ts for the design.
// On devnet these are plans only (real signatures require the Polygon side
// to exist); Ika signature legs can be exercised individually via
// /ika/approve-and-sign. Production flips this from "planned" to "executed"
// with Ika 2PC-MPC running all legs atomically.
app.get("/batch/:id/cross-chain", (req, res) => {
  const { getBundleStore, serializeBundle } = require("./ikaOrchestrator");
  const bundle = getBundleStore().get(req.params.id);
  if (!bundle) return res.status(404).json({ error: "No bundle for that batch — not settled yet?" });
  res.json(serializeBundle(bundle));
});

app.get("/cross-chain/recent", (_req, res) => {
  const { getBundleStore, serializeBundle } = require("./ikaOrchestrator");
  res.json({
    recent: getBundleStore().list().map(serializeBundle),
  });
});

// POST /batch/:id/cross-chain/execute
// body: { userWallet: string }
//
// Fire real Ika signatures for each signable leg in the bundle. Requires
// the user to already have a dWallet + authority transferred (`POST
// /ika/dwallet` then `/ika/transfer-authority`). Each leg's messageDigest
// is signed via the same approveAndSign flow that's already proven on
// devnet (`GG5MrTah…`). Completes the bundle's cryptographic authorization
// path; Polygon-side tx submission still requires CTF Exchange on Amoy
// and is tracked separately. ~1 Solana tx + gRPC round-trip per leg.
app.post("/batch/:id/cross-chain/execute", async (req, res) => {
  try {
    const { userWallet } = req.body;
    if (!userWallet) return res.status(400).json({ error: "userWallet required" });
    const {
      getBundleStore,
      executeBundle,
      serializeBundle,
    } = require("./ikaOrchestrator");
    const store = getBundleStore();
    const bundle = store.get(req.params.id);
    if (!bundle) return res.status(404).json({ error: "No bundle for that batch" });

    // Inline approveAndSign wrapper: reuses ikaManager + the same digest
    // path as POST /ika/approve-and-sign. We derive the MessageApproval
    // PDA on the fly and fire the CPI, then request the Ika presign+sign.
    const { keccak_256 } = await import("@noble/hashes/sha3.js");
    // @ts-ignore
    const bs58mod: any = await import("bs58");
    const bs58: any = bs58mod.default ?? bs58mod;

    const approveAndSign = async (uw: string, digest: Uint8Array) => {
      const record = ikaManager.getDWallet(uw);
      if (!record) throw new Error(`No dWallet for ${uw}`);
      if (!record.authorityTransferred) throw new Error("Authority not transferred");
      const pubkeyBytes = Uint8Array.from(Buffer.from(record.publicKey, "hex"));
      const curveByte = record.curve === "Curve25519" ? 2 : 0;
      const sigScheme = record.curve === "Curve25519" ? 5 : 0;

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

      const [cpiAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("__ika_cpi_authority")],
        new PublicKey(config.programId),
      );
      const [coordinator] = PublicKey.findProgramAddressSync(
        [Buffer.from("dwallet_coordinator")],
        ikaProgramId,
      );

      const predacy = (client as any).program;
      const txSig: string = await predacy.methods
        .approveIkaMessage(
          Array.from(digest),
          Array.from(new Uint8Array(32)),
          Array.from(pubkeyBytes.slice(0, 32)),
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
      const conn = client.getConnection();
      await conn.confirmTransaction(txSig, "confirmed");
      const approveTxBytes = Buffer.from(bs58.decode(txSig));
      const presignId = await ikaManager.requestPresign(uw);
      const signResult = await ikaManager.signMessage(uw, digest, presignId, approveTxBytes.toString("base64"), 0n);
      return {
        signature: Buffer.from(signResult.signature).toString("hex"),
        approveTxSignature: txSig,
      };
    };

    const executed = await executeBundle(bundle, approveAndSign, userWallet);
    store.save(executed);
    res.json({ ok: true, bundle: serializeBundle(executed) });
  } catch (err: any) {
    console.error(`[POST /batch/:id/cross-chain/execute] error: ${oneLineErr(err)}`);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ─── Settlement stats — matched-pair / CLOB breakdown ───
// Populated after processBatch finishes. See pairMatcher.ts + polymarketRouter.ts
// for the classification logic. Used by the UI to show `X% matched as
// complete-set pairs, Y% routed to Polymarket CLOB`.
app.get("/settlement-stats", (req, res) => {
  const batchId = req.query.batchId as string | undefined;
  if (batchId) {
    const stats = processor.getSettlementStats(BigInt(batchId));
    if (!stats) return res.status(404).json({ error: "No stats for that batch yet" });
    return res.json(stats);
  }
  // No batchId → return the most recent settled batches (bounded).
  res.json({ recent: processor.listSettlementStats() });
});

// Idempotency index: maps (marketId, batchId, salt) → jobId so duplicate
// POSTs return the existing job instead of starting a second snarkjs proof.
// Frontend has at least one path where PositionsPanel is mounted twice (in
// MarketPageClient + EventPageClient), so a single user-click can fan out
// to two POSTs. Deduping here makes the backend idempotent regardless.
const claimDedupKey = (marketIdHex: string, batchId: bigint, salt: bigint) =>
  `${marketIdHex.toLowerCase().replace(/^0x/, "")}|${batchId.toString()}|${salt.toString()}`;
const claimJobByKey = new Map<string, string>();

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

    // Dedup: if a job for this (marketId, batchId, salt) is already running
    // or done, return its jobId. salt is the user-private nonce so it's a
    // strong identifier for "this user's claim of this position".
    const dedupKey = claimDedupKey(marketId, BigInt(batchId), BigInt(salt));
    const existingId = claimJobByKey.get(dedupKey);
    if (existingId) {
      const existing = claimJobs.get(existingId);
      if (existing && existing.status !== "error") {
        console.log(`[POST /claim-proof] dedup hit → reusing job ${existingId} (status=${existing.status})`);
        return res.status(202).json({ ok: true, jobId: existingId, deduped: true });
      }
      // Previous attempt errored — clear and let a new job try.
      claimJobByKey.delete(dedupKey);
    }

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
    claimJobByKey.set(dedupKey, jobId);
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

    // Rebuild the batch's commitment list from the order store. Must match
    // the order the Merkle tree was built in during settleBatch (insertion
    // order), otherwise the membership proof's root won't match the on-chain
    // claim_merkle_root and the on-chain verifier will reject.
    const batchOrders = await processor.getBatchOrders(job.batchId);
    const allCommitments: bigint[] = [];
    for (const o of batchOrders) {
      allCommitments.push(
        await computeCommitment(marketIdBigInt, o.side, o.amount, o.limitPrice, o.salt),
      );
    }

    // This order's leaf position in the tree.
    const commitment = await computeCommitment(
      marketIdBigInt, order.side, order.amount, order.limitPrice, order.salt,
    );
    const leafIndex = allCommitments.findIndex((c) => c === commitment);
    if (leafIndex < 0) {
      throw new Error(`Order commitment not found in batch ${job.batchId} — cannot prove membership`);
    }

    // ── Resolve recipient token ATA (both real + mock paths) ──
    // The instruction accepts any TokenAccount; which mint it should be
    // depends on side: buyers get YES/NO, sellers get USDC refund back.
    const { getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
    const connection = client.getConnection();
    const isBuy = order.side === 0 || order.side === 2; // YES_BUY or NO_BUY
    const isYes = order.side === 0 || order.side === 1; // YES_BUY or YES_SELL
    let recipientAta: PublicKey;
    if (isBuy) {
      const [mint] = isYes ? client.yesMintPda(job.marketId) : client.noMintPda(job.marketId);
      const ata = await getOrCreateAssociatedTokenAccount(connection, config.relayerKeypair, mint, job.recipient);
      recipientAta = ata.address;
    } else {
      const protocolCfg = await client.fetchProtocolConfig();
      const usdcMint = (protocolCfg as any).usdcMint as PublicKey;
      const ata = await getOrCreateAssociatedTokenAccount(connection, config.relayerKeypair, usdcMint, job.recipient);
      recipientAta = ata.address;
    }

    // Recipient field element — must match what's used inside the proof.
    // pubkeyToFieldElement masks top 3 bits so value < BN254 scalar modulus.
    const { fieldBigint: recipientFieldBigint, fieldBytes: recipientFieldBytes } =
      pubkeyToFieldElement(job.recipient.toBytes());

    if (config.useRealZk) {
      const result = await generateClaimProof(
        marketIdBigInt,
        order,
        job.batchId,
        clearingPrice,
        allCommitments,
        leafIndex,
        recipientFieldBigint,
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
        recipientAta,
        Array.from(recipientFieldBytes),
      );

      job.txHash = txHash;
    } else {
      // On-chain Groth16 verification is now always enforced. Mock proofs
      // (all-zero bytes) will fail verification, so this path is no longer
      // usable end-to-end. Kept behind a hard error so the failure mode is
      // loud — flip USE_REAL_ZK=true in .env to enable claims.
      throw new Error(
        "USE_REAL_ZK=false but on-chain verifier requires real proofs. " +
          "Set USE_REAL_ZK=true and restart the relayer.",
      );
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

// ─── Liquidity Stack — HTTP API (docs/LIQUIDITY.md) ───

import { getEventLedger, deriveHandleId, handleIdToHex } from "./eventLedger";
import { getLiquidityStack } from "./liquidityStack";

const eventLedger = getEventLedger();
const liquidityStack = getLiquidityStack(client, eventLedger);

// ─── Shared event/market helpers ─────────────────────────────────────
// Both the HTTP handlers (POST /events, POST /events/:id/markets) and the
// stream-monitor agent need to create events / seed markets through the
// same code path. Factored here so the agent doesn't drift from the
// operator-API behavior (idempotency, rebate-pool init, label storage).

const CATEGORY_NUM_MAP: Record<string, number> = {
  LiveStream: 0, Sports: 1, Crypto: 2, Politics: 3, Custom: 4,
};

interface CreateEventInput {
  label: string;
  category?: string;
  closesAt: number;
  graduationThresholdUsdc?: string;
  graduationBatches?: number;
  feeBpsTaker?: number;
  feeBpsTreasury?: number;
  feeBpsRebates?: number;
  bootstrapSeedUsdc?: string;
}

interface CreateEventOutput {
  handleIdHex: string;
  eventHandlePda: string;
  txSig: string | null;
}

async function createEventOnChain(input: CreateEventInput): Promise<CreateEventOutput> {
  const {
    label,
    category = "LiveStream",
    closesAt,
    graduationThresholdUsdc = "1000000000",   // $1k default
    graduationBatches = 2,
    feeBpsTaker = 30,
    feeBpsTreasury = 10,
    feeBpsRebates = 20,
    bootstrapSeedUsdc = "100000000",          // $100 default
  } = input;
  const categoryNum = CATEGORY_NUM_MAP[category] ?? 4;

  const handleId = deriveHandleId(label);
  const handleIdHex = handleIdToHex(handleId);
  const [eventHandlePda] = client.eventHandlePda(handleId);

  // Try the on-chain create. If the EventHandle PDA already exists, the
  // ledger upsert below still runs so the (possibly new) label persists.
  let txSig: string | null = null;
  try {
    txSig = await client.createEventHandle({
      handleId,
      category: categoryNum,
      closesAt: BigInt(closesAt),
      graduationThresholdUsdc: BigInt(graduationThresholdUsdc),
      graduationBatches,
      feeBpsTaker,
      feeBpsTreasury,
      feeBpsRebates,
      bootstrapSeedUsdc: BigInt(bootstrapSeedUsdc),
    });
  } catch (err: any) {
    const msg = String(err?.message || "");
    const accountExists = msg.includes("already in use") || msg.includes("custom program error: 0x0");
    // Solana RPC confirmation timeouts (WSS subscription cap on burst
    // tx creation) — the tx is in-flight, may yet land. Treat as
    // success-pending: the ledger.register below is idempotent on
    // handleId, and the next attempt to use the EventHandle (e.g. seed
    // a market under it) will either succeed or surface "already in
    // use" which we already tolerate. Logging the sig lets the operator
    // sanity-check on Explorer if anything misbehaves later.
    const confirmationTimeout =
      msg.includes("was not confirmed") || msg.includes("It is unknown if it succeeded");
    if (!accountExists && !confirmationTimeout) throw err;
    if (accountExists) {
      console.log(`[createEventOnChain] EventHandle ${handleIdHex.slice(0, 8)}… exists on-chain, upserting label only`);
    } else {
      console.warn(`[createEventOnChain] EventHandle ${handleIdHex.slice(0, 8)}… create timed out on confirmation — tx in flight; proceeding with ledger upsert`);
    }
  }

  eventLedger.register({
    handleId: handleIdHex,
    label,
    category: category as any,
    eventHandlePda: eventHandlePda.toBase58(),
    authority: client.relayer.publicKey.toBase58(),
    closesAt: Number(closesAt),
    graduationThresholdUsdc: BigInt(graduationThresholdUsdc),
    graduationBatches,
    feeBpsTaker,
    feeBpsTreasury,
    feeBpsRebates,
    bootstrapSeedUsdc: BigInt(bootstrapSeedUsdc),
  });

  // Stand up the rebate pool — Tier 2 needs it before any fills happen.
  // Idempotent on retries (already-initialized error caught).
  try {
    await client.initRebatePool(eventHandlePda);
  } catch (err: any) {
    console.warn(`[createEventOnChain] initRebatePool warning: ${err.message}`);
  }

  return {
    handleIdHex,
    eventHandlePda: eventHandlePda.toBase58(),
    txSig,
  };
}

/** Idempotent: create the on-chain market if missing, init the bootstrap
 *  pool, attach to the event in the ledger with a label. Used by the
 *  agent to seed prop markets and by POST /events/:id/markets for
 *  operator-driven attaches. */
/** Ensure the relayer's USDC ATA holds at least `needed` micro-USDC.
 *  Devnet-only — the relayer is the USDC mint authority so it can self-
 *  mint up to a target buffer. Mints `needed × 10` so we don't
 *  re-trigger on every market seed (50 markets/hour at $100 each =
 *  $5K/hour, batched mint of $1K covers ~10 seeds). On mainnet this
 *  helper would be a no-op since the relayer can't mint real USDC —
 *  the operator would need to fund the ATA out-of-band. */
async function ensureRelayerUsdcForSeed(needed: bigint): Promise<void> {
  if (needed === 0n) return;
  try {
    const { getAssociatedTokenAddressSync, getAccount, getOrCreateAssociatedTokenAccount, mintTo } =
      await import("@solana/spl-token");
    const protocolConfig = await client.fetchProtocolConfig();
    const usdcMint = (protocolConfig as any).usdcMint as PublicKey;
    const connection = client.getConnection();
    const relayerKeypair = config.relayerKeypair;
    const ata = getAssociatedTokenAddressSync(usdcMint, relayerKeypair.publicKey, true);
    let bal = 0n;
    try {
      const acc = await getAccount(connection, ata);
      bal = BigInt(acc.amount.toString());
    } catch {
      // ATA doesn't exist yet — create it.
      await getOrCreateAssociatedTokenAccount(
        connection, relayerKeypair, usdcMint, relayerKeypair.publicKey,
      );
    }
    if (bal >= needed) return;
    // Top up to a multiple of `needed` to amortise mint calls.
    const topUp = needed * 10n;
    await mintTo(connection, relayerKeypair, usdcMint, ata, relayerKeypair, Number(topUp));
    console.log(`[ensureRelayerUsdcForSeed] minted ${topUp} micro-USDC to relayer ATA (had ${bal}, needed ≥ ${needed})`);
  } catch (err: any) {
    console.warn(`[ensureRelayerUsdcForSeed] top-up failed: ${oneLineErr(err)}`);
    // Don't throw — let initBootstrapPool surface the real error if the
    // ATA is genuinely under-funded after this.
  }
}

async function seedMarketUnderEvent(
  eventHandleHex: string,
  marketIdHex: string,
  label: string,
): Promise<void> {
  const ev = eventLedger.get(eventHandleHex);
  if (!ev) throw new Error(`seedMarketUnderEvent: unknown event ${eventHandleHex.slice(0, 8)}…`);

  const marketIdBuf = Buffer.from(marketIdHex.replace("0x", ""), "hex");
  const eventHandleKey = new PublicKey(ev.eventHandlePda);

  // 1. Auto-create the on-chain market account if it doesn't exist (and
  //    register the in-memory batch state). Tolerate confirmation
  //    timeouts (WSS sub cap on burst seeds) — the tx is in flight and
  //    will land; the next attempt to use the market will succeed or
  //    hit "already in use" which is also caught downstream.
  try {
    await processor.startMarket(marketIdBuf);
  } catch (err: any) {
    const msg = String(err?.message || "");
    const tolerable =
      msg.includes("already in use") ||
      msg.includes("custom program error: 0x0") ||
      msg.includes("was not confirmed") ||
      msg.includes("It is unknown if it succeeded");
    if (!tolerable) throw err;
    console.warn(`[seedMarketUnderEvent] startMarket ${marketIdHex.slice(0, 8)}… tolerated: ${msg.slice(0, 120)}`);
  }

  // 2. Init Tier 0 bootstrap pool. The on-chain ix transfers
  //    `bootstrap_seed_usdc` from the relayer's USDC ATA into the
  //    market's PDA-owned vault — so the LMSR's worst-case payout is
  //    actually collateralized. Top up the relayer's USDC ATA first if
  //    it would dip below the seed (devnet only — relayer is the mint
  //    authority). Idempotent — already-exists is caught.
  try {
    await ensureRelayerUsdcForSeed(BigInt(ev.bootstrapSeedUsdc.toString()));
    await client.initBootstrapPool(marketIdBuf, eventHandleKey);
  } catch (err: any) {
    console.warn(`[seedMarketUnderEvent] initBootstrapPool warning for ${marketIdHex.slice(0, 8)}…: ${oneLineErr(err)}`);
  }

  // 3. Bind in the ledger with the human-readable label.
  eventLedger.attachMarket(eventHandleHex, marketIdHex.toLowerCase().replace("0x", ""), label);
}

// ─── Stream-monitor agent ────────────────────────────────────────────
// Polls YouTube Data API for the configured poker-stream channels going
// live. On detection: creates an EventHandle for the session and seeds
// the standard generic prop markets. Player-aware market instantiation
// + transcript-based settlement get layered on by later phases.
import { StreamMonitor } from "./agent/streamMonitor";
import { getSessionStats } from "./agent/sessionStats";
import { getSettlementEngine } from "./agent/settlementEngine";
import { getSignalAggregator, SignalKeys, type SignalSource } from "./agent/signalAggregator";

const sessionStats = getSessionStats();
const settlementEngine = getSettlementEngine(client, eventLedger, sessionStats);
// Cross-signal aggregator: gates live + hand-level settlement on
// ≥2-source confirmation (≥2 vision frames, or vision + audio/chat/manual).
// Both SessionStats (publishes observations during recordSnapshot) and
// SettlementEngine (queries the gate before firing on-chain) share the
// same singleton.
const signalAggregator = getSignalAggregator();
sessionStats.setAggregator(signalAggregator);
settlementEngine.setAggregator(signalAggregator);
// Sweep expired (single-source) entries every 30s. The aggregator's
// expirySec is 60s — pruning at half that cadence keeps the in-memory
// map bounded without affecting correctness (confirmed entries never
// expire, single-signal pending entries that haven't been re-observed
// in 60s drop out).
setInterval(() => {
  const dropped = signalAggregator.prune(Math.floor(Date.now() / 1000));
  if (dropped.length > 0) {
    console.log(`[Aggregator] pruned ${dropped.length} expired pending entr${dropped.length === 1 ? "y" : "ies"}: ${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? `, +${dropped.length - 3} more` : ""}`);
  }
}, 30_000);
const streamMonitor = new StreamMonitor({
  apiKey: process.env.YOUTUBE_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  ledger: eventLedger,
  stats: sessionStats,
  createEvent: async ({ label, category, closesAt }) => {
    const out = await createEventOnChain({ label, category, closesAt });
    return { handleIdHex: out.handleIdHex, eventHandlePda: out.eventHandlePda };
  },
  seedMarket: seedMarketUnderEvent,
  // Live settlement trigger: after every gameState snapshot, settle
  // any event-driven markets whose condition is now met. Idempotent
  // via the engine's resolved-set cache.
  onSnapshot: async (handleIdHex) => {
    await settlementEngine.settleLive(handleIdHex);
  },
  // Hand-level real-time markets: seed fresh "Will X win hand #N?"
  // markets for each in-hand player at the start of every new hand,
  // settle them the moment a winner is declared on screen.
  onHandStart: async (handleIdHex, sessionLabel, handIdx, players) => {
    const { handLevelMarketsFor } = await import("./agent/marketTemplates");
    const markets = handLevelMarketsFor(
      sessionLabel,
      handIdx,
      players.map((name, i) => ({ seat: i + 1, name })),
    );
    console.log(`[handStart] ${sessionLabel} hand #${handIdx} seeding ${markets.length} market(s) for: ${players.join(", ")}`);
    for (const m of markets) {
      try {
        await seedMarketUnderEvent(handleIdHex, m.marketIdHex, m.label);
      } catch (err: any) {
        console.warn(`[handStart] seed ${m.slug} failed: ${err.message?.slice(0, 160)}`);
      }
    }
  },
  onHandResolved: async (handleIdHex, _sessionLabel, handIdx, winners, _players) => {
    await settlementEngine.settleHand(handleIdHex, handIdx, winners);
  },
});
streamMonitor.start();

/**
 * POST /agent/pause
 * Stops the streamMonitor's YouTube polling loop AND every active
 * session's 5s game-state OCR ticker. No new OpenAI / YouTube quota
 * burn until /agent/resume. Active session state stays in memory so a
 * resume picks up exactly where pause left off.
 */
app.post("/agent/pause", (_req, res) => {
  streamMonitor.stop();
  console.log("[StreamMonitor] paused via /agent/pause");
  res.json({ ok: true, paused: true });
});

/**
 * POST /agent/resume
 * Restarts the streamMonitor (idempotent — no-op if already running).
 * Re-detects live streams + restarts game-state loops for any active
 * session that's still in memory.
 */
app.post("/agent/resume", (_req, res) => {
  streamMonitor.start();
  // Restart per-session OCR loops immediately rather than waiting for
  // the next YouTube poll cycle (which is minutes away).
  streamMonitor.resumeActiveSessions();
  console.log("[StreamMonitor] resumed via /agent/resume");
  res.json({ ok: true, paused: false });
});

/**
 * GET /agent/stats?handleId=…  or  ?session=…
 * Returns the SessionStats record for a given session or EventHandle.
 * Used by the live-standings panel on the event detail page.
 */
app.get("/agent/stats", (req, res) => {
  const handleId = (req.query.handleId as string) || "";
  const sessionLabel = (req.query.session as string) || "";
  if (!handleId && !sessionLabel) {
    return res.status(400).json({ error: "handleId or session required" });
  }
  const all = sessionStats.list();
  const hit = sessionLabel
    ? all.find((s) => s.sessionLabel === sessionLabel)
    : all.find((s) => s.handleIdHex.toLowerCase() === handleId.toLowerCase());
  if (!hit) return res.status(404).json({ error: "no stats for that session" });
  res.json(hit);
});

/**
 * GET /agent/aggregator
 * Snapshot of the cross-signal aggregator. Returns the confirmed and
 * pending event keys with their observation history. The window/expiry
 * config is included so consumers can render "X observed, needs Y more"
 * progress UI without hardcoding the thresholds.
 *
 * Public visibility: the gate decisions drive on-chain settlement, so
 * surfacing the aggregator state is part of the demo's "the agent's
 * resolution rationale is auditable" narrative.
 */
app.get("/agent/aggregator", (_req, res) => {
  const snap = signalAggregator.snapshot();
  res.json({
    config: signalAggregator.config,
    confirmed: snap.confirmed.map((s) => ({
      key: s.key,
      confirmedAt: s.confirmedAt,
      firstSeenAt: s.firstSeenAt,
      observations: s.observations.map((o) => ({ source: o.source, at: o.at })),
    })),
    pending: snap.pending.map((s) => ({
      key: s.key,
      firstSeenAt: s.firstSeenAt,
      observations: s.observations.map((o) => ({ source: o.source, at: o.at })),
    })),
  });
});

/**
 * POST /agent/aggregator/observe
 *
 * Operator-injected cross-confirmation hook. Useful when:
 *   - audio/chat pipelines aren't running (pre-mainnet, no quota)
 *     and an operator wants to manually confirm a deterministic signal
 *     they observed in the broadcast (judges' demo path).
 *   - resolving a stuck market where vision saw the event once but the
 *     overlay flickered off before a 2nd frame.
 *
 * Body: { key: string, source?: SignalSource } — defaults source=manual.
 * Returns { confirmed: boolean, ... } so the caller can verify the gate
 * cleared.
 */
app.post("/agent/aggregator/observe", express.json(), (req, res) => {
  const { key, source } = req.body ?? {};
  if (typeof key !== "string" || !key) {
    return res.status(400).json({ error: "key required" });
  }
  const allowed: SignalSource[] = ["vision", "audio", "chat", "manual"];
  const src: SignalSource = allowed.includes(source) ? source : "manual";
  const at = Math.floor(Date.now() / 1000);
  const confirmed = signalAggregator.observe(key, src, at, `op-${at}`);
  res.json({ confirmed, key, source: src, at });
});

/**
 * Convenience: pre-built keys (so the operator UI / docs don't need to
 * mirror the SignalKeys constructors). Returns the canonical key for
 * common gate kinds; POST to /agent/aggregator/observe with the
 * resulting key + source=manual to clear a gate.
 */
app.get("/agent/aggregator/keys", (req, res) => {
  const handleId = (req.query.handleId as string) || "";
  if (!handleId) {
    return res.status(400).json({ error: "handleId required" });
  }
  // Dynamic templates are returned as canonical strings rather than
  // closures so the response stays JSON-serialisable. Operator UIs +
  // CLI scripts substitute the placeholders client-side.
  res.json({
    static: {
      quads: SignalKeys.quads(handleId),
      royal: SignalKeys.royal(handleId),
    },
    templates: {
      firstBust: SignalKeys.firstBust(handleId, "<player>"),
      handWinner: SignalKeys.handWinner(handleId, 42, "<player>")
        .replace(":42:", ":<handIdx>:"),
    },
  });
});

/**
 * POST /agent/extract?videoId=X
 * Debug endpoint — runs the lineup extractor against an arbitrary
 * YouTube videoId and returns what GPT-4o saw. Doesn't touch the
 * ledger or the active-session map. Useful for tuning the prompt and
 * sampling parameters without burning a poll cycle.
 *
 * Optional query params:
 *   numFrames    (default 4)  — how many frames to sample
 *   intervalSec  (default 12) — gap between frames in seconds
 */
import { LineupExtractor } from "./agent/lineupExtractor";
import { GameStateExtractor } from "./agent/gameStateExtractor";
const debugExtractor = new LineupExtractor(process.env.OPENAI_API_KEY ?? "");
const debugGameState = new GameStateExtractor(process.env.OPENAI_API_KEY ?? "");
app.post("/agent/extract", async (req, res) => {
  try {
    const videoId = (req.query.videoId as string) || (req.body?.videoId as string);
    if (!videoId) return res.status(400).json({ error: "videoId required" });
    const numFrames = req.query.numFrames ? Number(req.query.numFrames) : undefined;
    const intervalSec = req.query.intervalSec ? Number(req.query.intervalSec) : undefined;
    const t0 = Date.now();
    const result = await debugExtractor.extract(videoId, { numFrames, intervalSec });
    res.json({
      ok: !!result,
      elapsedMs: Date.now() - t0,
      result,
    });
  } catch (err: any) {
    console.error("[POST /agent/extract] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /agent/snapshot?videoId=X
 * Debug endpoint — runs ONE game-state OCR snapshot against an arbitrary
 * videoId (no agent loop, no stats accumulation, no ledger touch).
 * Useful for tuning the gameState prompt and seeing what the OCR is
 * actually reporting for a given moment.
 */
app.post("/agent/snapshot", async (req, res) => {
  try {
    const videoId = (req.query.videoId as string) || (req.body?.videoId as string);
    if (!videoId) return res.status(400).json({ error: "videoId required" });
    const t0 = Date.now();
    const result = await debugGameState.snapshot(videoId);
    res.json({
      ok: !!result,
      elapsedMs: Date.now() - t0,
      result,
    });
  } catch (err: any) {
    console.error("[POST /agent/snapshot] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /agent/start-session?videoId=…&channelTag=…
 * Debug endpoint — manually run the full session-start path that the
 * monitor would normally trigger after a YouTube poll discovers a new
 * live video. Useful for bootstrapping demo data without waiting for
 * the YouTube quota to reset.
 *
 * Pipeline (mirrors streamMonitor.startSession):
 *   1. Multi-frame lineup extract (8 × 15s by default — full table read)
 *   2. Compute session label = "{TAG}-SESSION-{date}-{lineup_hash8}"
 *   3. Create EventHandle on-chain (idempotent on label)
 *   4. Seed generic + player-aware + head-to-head markets
 *
 * Returns the lineup + the event id so the operator can verify.
 */
app.post("/agent/start-session", async (req, res) => {
  try {
    const videoId = (req.query.videoId as string) || "";
    const channelTag = ((req.query.channelTag as string) || "").toUpperCase();
    if (!videoId || !channelTag) {
      return res.status(400).json({ error: "videoId + channelTag required" });
    }
    if (!["TRITON", "HCL"].includes(channelTag)) {
      return res.status(400).json({ error: "channelTag must be TRITON or HCL" });
    }

    // Lazy-load the templates — keeps the import line tidy.
    const { genericMarketsFor, playerMarketsFor } = await import("./agent/marketTemplates");

    const t0 = Date.now();
    const lineup = await debugExtractor.extract(videoId);
    if (!lineup || !lineup.confident || lineup.players.length === 0) {
      return res.status(502).json({
        error: "lineup extract failed or non-confident",
        elapsedMs: Date.now() - t0,
        lineup,
      });
    }

    const date = new Date().toISOString().slice(0, 10);
    const sessionLabel = `${channelTag}-SESSION-${date}-${lineup.hash.slice(0, 8)}`;
    const closesAt = Math.floor(Date.now() / 1000) + 12 * 3600;

    const ev = await createEventOnChain({
      label: sessionLabel,
      category: "LiveStream",
      closesAt,
    });

    // Seed generic + player-aware markets. Errors per-market are caught
    // so a single failure doesn't abort the whole seeding pass.
    const seededLabels: string[] = [];
    const failed: string[] = [];
    const allMarkets = [
      ...genericMarketsFor(channelTag as any, sessionLabel),
      ...playerMarketsFor(sessionLabel, lineup.players),
    ];
    for (const m of allMarkets) {
      try {
        await seedMarketUnderEvent(ev.handleIdHex, m.marketIdHex, m.label);
        seededLabels.push(m.label);
      } catch (err: any) {
        failed.push(`${m.label} (${err.message?.slice(0, 80) ?? "?"})`);
      }
    }

    res.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      sessionLabel,
      handleIdHex: ev.handleIdHex,
      eventHandlePda: ev.eventHandlePda,
      lineup: lineup.players,
      seededCount: seededLabels.length,
      failedCount: failed.length,
      failed,
    });
  } catch (err: any) {
    console.error("[POST /agent/start-session] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /agent/events/:handle/settlement/preview
 * Dry-run — show what each market under this event WOULD resolve to
 * if we settled now. No on-chain effects. Useful for verifying the
 * resolution rules + spot-checking ahead of a real settle.
 *
 * Query: ?trigger=live|end (default end)
 */
app.get("/agent/events/:handle/settlement/preview", (req, res) => {
  try {
    const handle = req.params.handle;
    const trigger = (req.query.trigger as string) === "live" ? "live" : "end";
    const pending = settlementEngine.preview(handle, trigger);
    res.json({
      ok: true,
      trigger,
      count: pending.length,
      resolutions: pending.map((p) => ({
        marketIdHex: p.marketIdHex,
        label: p.label,
        kind: p.classified?.kind ?? null,
        outcome: p.outcome === 1 ? "YES" : "NO",
        reason: p.reason,
      })),
    });
  } catch (err: any) {
    console.error("[GET /agent/events/:handle/settlement/preview] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /agent/events/:handle/settlement/end
 * Settle every still-UNRESOLVED market under this event using the
 * final session stats. Used to manually trigger end-of-session
 * settlement without ending the session in the StreamMonitor (which
 * is gated on YouTube grace periods etc).
 */
app.post("/agent/events/:handle/settlement/end", async (req, res) => {
  try {
    const handle = req.params.handle;
    const t0 = Date.now();
    const applied = await settlementEngine.settleEnd(handle);
    res.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      count: applied.length,
      resolutions: applied.map((p) => ({
        marketIdHex: p.marketIdHex,
        label: p.label,
        kind: p.classified?.kind ?? null,
        outcome: p.outcome === 1 ? "YES" : "NO",
        reason: p.reason,
      })),
    });
  } catch (err: any) {
    console.error("[POST /agent/events/:handle/settlement/end] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/events/:handle/markets/:marketId/resolve
 *
 * Operator-only. Force a deterministic on-chain resolution + ledger
 * write for a single market under a known event. Bypasses the
 * SettlementEngine's signal pipeline (no SessionStats, no aggregator
 * gate) — used by the /claims happy-path smoke test to set up a
 * resolved state without standing up a live session.
 *
 * body: { outcome: "YES" | "NO" }
 *
 * Idempotent: if the market is already resolved on-chain, the on-chain
 * call gracefully short-circuits (MarketAlreadyResolved); the ledger
 * write below is also idempotent.
 */
app.post("/admin/events/:handle/markets/:marketId/resolve", express.json(), async (req, res) => {
  try {
    const handle = req.params.handle;
    const marketIdHex = req.params.marketId.replace(/^0x/, "");
    const outcomeStr = String(req.body?.outcome ?? "").toUpperCase();
    if (outcomeStr !== "YES" && outcomeStr !== "NO") {
      return res.status(400).json({ error: 'outcome must be "YES" or "NO"' });
    }
    if (!eventLedger.get(handle)) {
      return res.status(404).json({ error: "EventHandle not found in ledger" });
    }
    const outcome = outcomeStr === "YES" ? 1 : 2;
    const marketIdBuf = Buffer.from(marketIdHex, "hex");
    let onchainResult: "resolved" | "already-resolved" = "resolved";
    try {
      await client.resolveMarket(marketIdBuf, outcome);
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("MarketAlreadyResolved") || msg.includes("already resolved")) {
        onchainResult = "already-resolved";
      } else {
        throw err;
      }
    }
    eventLedger.setMarketResolution(handle, marketIdHex, outcomeStr as "YES" | "NO");
    res.json({ ok: true, onchain: onchainResult, outcome: outcomeStr });
  } catch (err: any) {
    console.error(`[POST /admin/.../resolve] Error: ${oneLineErr(err)}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /agent/sessions
 * Lists every session the StreamMonitor has in its in-memory active map.
 * Useful for debugging when the EventLedger shows an event but the
 * monitor has dropped it from active (post-redeploy, post-grace period,
 * etc) — the refresh endpoint only operates on active sessions.
 */
app.get("/agent/sessions", (_req, res) => {
  const active = streamMonitor.listActive();
  res.json({
    count: active.length,
    sessions: active.map((s) => ({
      sessionLabel: s.sessionLabel,
      channelTag: s.channelTag,
      videoId: s.videoId,
      handleIdHex: s.handleIdHex,
      lineupHash: s.lineupHash,
      lineup: s.lineup.map((p) => p.name),
      startedAt: s.startedAt,
      lastSeenAt: s.lastSeenAt,
      lastLineupCheckAt: s.lastLineupCheckAt,
    })),
  });
});

/**
 * POST /agent/sessions/:identifier/refresh
 * Force a lineup re-extraction on an active session right now,
 * bypassing both the 10-min recheck interval and the per-videoId
 * failure backoff. Additive: any newly-seen players get their per-
 * player markets seeded; existing markets stay untouched. Use when
 * a session was created during a heads-up moment and only caught a
 * partial lineup.
 *
 * `identifier` is either the lineup hash (session key) or the
 * EventHandle hex — UI surfaces the handle hex on each card.
 */
app.post("/agent/sessions/:identifier/refresh", async (req, res) => {
  try {
    const identifier = req.params.identifier;
    if (!identifier) return res.status(400).json({ error: "identifier required" });
    // Optional videoId override — required when the session is no longer
    // in the monitor's active map (e.g. cleared on redeploy) but the
    // EventHandle still lives in the EventLedger and the operator wants
    // to additively re-extract under it without losing the on-chain
    // state. Pass via ?videoId=… (or body.videoId for tools that POST
    // JSON).
    const videoId = (req.query.videoId as string) || (req.body?.videoId as string) || undefined;
    // mode controls what the refresh does with the captured lineup:
    //   additive (default) — only seed markets for newly-seen players
    //   reseed             — idempotently re-run market seeding for every
    //                        captured player. Use when the active session
    //                        knows about a player but their markets were
    //                        never (or only partially) attached on-chain.
    //   replace            — drop markets for players in the prior lineup
    //                        but NOT in this capture (ghost players from
    //                        a turned-over table). Captured players get
    //                        idempotent reseed.
    const modeRaw = ((req.query.mode as string) || (req.body?.mode as string) || "additive").toLowerCase();
    const mode = (["additive", "reseed", "replace"].includes(modeRaw) ? modeRaw : "additive") as
      | "additive" | "reseed" | "replace";
    // Manual lineup override — bypasses the OpenAI extractor when the
    // broadcast cuts between multiple tables (HCL streams 3+ live tables
    // + recap reels on a single videoId; extractor can't pin the
    // current one). Accepts either ?players=NAME1,NAME2 query string or
    // body.players[]. Each name becomes a Player at sequential seat
    // index. Downstream prune / reseed / replace logic is unchanged.
    let overrideLineup: string[] | undefined;
    const playersBody = req.body?.players;
    const playersQuery = req.query.players as string | undefined;
    if (Array.isArray(playersBody)) {
      overrideLineup = playersBody.map((n) => String(n).trim()).filter(Boolean);
    } else if (typeof playersQuery === "string" && playersQuery.length > 0) {
      overrideLineup = playersQuery.split(",").map((n) => n.trim()).filter(Boolean);
    }
    const t0 = Date.now();
    const result = await streamMonitor.forceRefresh(identifier, videoId, mode, overrideLineup);
    res.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      ...result,
    });
  } catch (err: any) {
    console.error("[POST /agent/sessions/:identifier/refresh] Error:", err.message);
    const status = err.message?.includes("no active session") || err.message?.includes("no EventHandle")
      ? 404
      : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /admin/events/:handle/close
 *
 * Closes an EventHandle for new orders + tears down the agent session
 * pointing at it + adds the underlying videoId to the streamMonitor's
 * blocklist so the polling loop won't re-spawn a session on this video.
 *
 * Use case: a YouTube channel airing mixed programming (e.g. multiple
 * tables/shows on the same videoId) where the auto-extracted lineup
 * keeps drifting and there's no single coherent "current table." Muting
 * the videoId keeps the agent focused on the channels with single-table
 * broadcasts.
 *
 * Returns { closed: boolean, blockedVideoId: string|null, sessionEnded: boolean }.
 */
/**
 * POST /admin/events/:handle/extend-onchain
 * Body: { newClosesAt?: number } (defaults to now + 48h)
 *
 * Calls the `update_event_close` ix on-chain to update the EventHandle
 * account's `closes_at`. Required when the originally-registered close
 * window has expired but downstream constraints (commit_lp_capital,
 * commit_lp_capital_blind, settle_batch) still need future timestamps
 * to validate against.
 *
 * Authority: relayer keypair (= EventHandle.authority by convention).
 * Returns { tx, prevClosesAt, newClosesAt }.
 */
app.post("/admin/events/:handle/extend-onchain", express.json(), async (req, res) => {
  try {
    const handle = req.params.handle.toLowerCase();
    const ev = eventLedger.get(handle);
    if (!ev) return res.status(404).json({ error: `unknown handle ${handle}` });

    const now = Math.floor(Date.now() / 1000);
    const newClosesAt = typeof req.body?.newClosesAt === "number"
      ? req.body.newClosesAt
      : now + 48 * 3600;

    if (newClosesAt <= now) {
      return res.status(400).json({ error: "newClosesAt must be in the future" });
    }

    const tx = await client.updateEventClose(handle, newClosesAt);
    // Mirror into the ledger so off-chain reads stay consistent.
    eventLedger.markOpen(handle, newClosesAt);

    res.json({ ok: true, tx, newClosesAt, newClosesAtDelta: newClosesAt - now });
  } catch (err: any) {
    console.error("[POST /admin/events/:handle/extend-onchain] Error:", oneLineErr(err));
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/events/:handle/reopen
 *
 * Inverse of /close. Sets `closed=false` and extends `closesAt` to a
 * future timestamp (body.closesAt, or now + 48h if omitted). Also
 * unblocks the videoId (if it was on the streamMonitor blocklist) and
 * lets the polling loop rediscover the channel if it's still live.
 *
 * Returns { reopened: true, closesAt, videoIdUnblocked: boolean }.
 */
app.post("/admin/events/:handle/reopen", express.json(), async (req, res) => {
  try {
    const handle = req.params.handle.toLowerCase();
    const ev = eventLedger.get(handle);
    if (!ev) return res.status(404).json({ error: `unknown handle ${handle}` });

    const now = Math.floor(Date.now() / 1000);
    const requestedClosesAt = req.body?.closesAt;
    // Default: 48 hours from now. Only extend if the existing closesAt
    // is already in the past — operator-set future closesAt stays.
    const newClosesAt = typeof requestedClosesAt === "number"
      ? requestedClosesAt
      : (ev.closesAt > now + 3600 ? ev.closesAt : now + 48 * 3600);

    eventLedger.markOpen(handle, newClosesAt);

    // Try to unblock any videoId associated with this handle (won't be
    // in the active session map after a close, so we have to look at
    // the recently-blocked list and best-effort match — there's no
    // handle ↔ videoId backlink on the ledger today).
    let videoIdUnblocked = false;
    for (const vid of streamMonitor.blockedList()) {
      // No way to reverse-lookup which handle owned this vid. Heuristic:
      // if a closed event's videoId is on the blocklist, unblock it and
      // let the discovery loop re-check liveness on its next poll.
      if (streamMonitor.unblockVideoId(vid)) {
        videoIdUnblocked = true;
        console.log(`[admin/reopen] unblocked videoId ${vid}`);
        break;
      }
    }

    res.json({
      reopened: true,
      closesAt: newClosesAt,
      closesAtDelta: newClosesAt - now,
      videoIdUnblocked,
    });
  } catch (err: any) {
    console.error("[POST /admin/events/:handle/reopen] Error:", oneLineErr(err));
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/events/:handle/label
 * Body: { label: string }
 *
 * Rename an event's human-readable label. Off-chain only — the
 * on-chain handleId stays canonical. Used to give auto-generated
 * session labels (e.g. "TRITON-SESSION-2026-05-04-…") cleaner display
 * names without re-registering the EventHandle.
 */
app.post("/admin/events/:handle/label", express.json(), async (req, res) => {
  try {
    const handle = req.params.handle.toLowerCase();
    const label = req.body?.label;
    if (typeof label !== "string" || !label.trim()) {
      return res.status(400).json({ error: "body.label (non-empty string) required" });
    }
    const ev = eventLedger.get(handle);
    if (!ev) return res.status(404).json({ error: `unknown handle ${handle}` });
    const prev = ev.label;
    eventLedger.setLabel(handle, label.trim());
    res.json({ ok: true, prev, label: label.trim() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/events/:handle/close", async (req, res) => {
  try {
    const handle = req.params.handle.toLowerCase();
    const ev = eventLedger.get(handle);
    if (!ev) return res.status(404).json({ error: `unknown handle ${handle}` });

    // 1. Find the active session (if any) tied to this handle so we can
    //    capture the videoId for the blocklist before tearing it down.
    const active = streamMonitor.listActive();
    const sess = active.find((s) => s.handleIdHex.toLowerCase() === handle);
    const videoId = sess?.videoId ?? null;

    // 2. Mark closed in the ledger (filters it out of the public events list,
    //    blocks any further commit_order intake at the relayer level).
    eventLedger.markClosed(handle);

    // 3. Block the videoId + end its session via the streamMonitor.
    if (videoId) streamMonitor.blockVideoId(videoId);

    res.json({
      closed: true,
      blockedVideoId: videoId,
      sessionEnded: !!sess,
    });
  } catch (err: any) {
    console.error("[POST /admin/events/:handle/close] Error:", oneLineErr(err));
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /agent/sessions/:identifier/prune-stale-markets
 *
 * Resolves every unresolved market attached to the session's EventHandle
 * whose embedded player name doesn't match the current session.lineup.
 * Stale markets surface when a session's lineup has been pruned (via
 * mode=replace or a manual override) AFTER the agent already seeded
 * per-player markets for the old roster — the lineup is clean but the
 * EventLedger still carries the historical market labels.
 *
 * Resolution outcome: NO (2). A player who has left the table can no
 * longer bluff, bust first, or win biggest pot in *this* session, so NO
 * is the correct (and only) closeout.
 *
 * Returns { resolved: [marketIds], skipped: [{marketId, reason}] }.
 * Idempotent — already-resolved markets are silently skipped via
 * `MarketAlreadyResolved` from the on-chain program.
 */
app.post("/agent/sessions/:identifier/prune-stale-markets", async (req, res) => {
  try {
    const identifier = req.params.identifier.toLowerCase();
    const active = streamMonitor.listActive();
    const session = active.find(
      (s) => s.handleIdHex.toLowerCase() === identifier || s.lineupHash === identifier,
    );
    if (!session) return res.status(404).json({ error: `no active session for ${identifier}` });

    const ev = eventLedger.get(session.handleIdHex);
    if (!ev?.marketLabels) return res.json({ resolved: [], skipped: [] });

    // Build a fuzzy-match set of currently-active player names.
    const canon = (s: string): string =>
      s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
    const activeCanon = new Set(session.lineup.map((p) => canon(p.name)));
    const isActivePlayer = (label: string): boolean => {
      // Markets without a player name (e.g. "Anyone hits quads tonight?")
      // are always considered active.
      const m = label.match(/^Will (.+?) (bluff|bust|win|hit)/i);
      if (!m) return true;
      const player = m[1].trim();
      if (activeCanon.has(canon(player))) return true;
      // Substring fallback handles OCR-shortened nameplate forms like
      // "phil" vs "PHIL IVEY" that the strict canon misses.
      const pCanon = canon(player);
      for (const a of activeCanon) {
        if (a.includes(pCanon) || pCanon.includes(a)) {
          if (Math.min(a.length, pCanon.length) >= 3) return true;
        }
      }
      return false;
    };

    const alreadyResolved = ev.resolutions ?? {};
    const resolved: string[] = [];
    const skipped: Array<{ marketId: string; reason: string }> = [];

    for (const [marketIdHex, label] of Object.entries(ev.marketLabels)) {
      if (alreadyResolved[marketIdHex]) continue;
      if (isActivePlayer(label)) continue;
      try {
        const marketIdBuf = Buffer.from(marketIdHex.replace(/^0x/, ""), "hex");
        await client.resolveMarket(marketIdBuf, 2 /* NO */);
        eventLedger.setMarketResolution(session.handleIdHex, marketIdHex, "NO");
        resolved.push(marketIdHex);
        console.log(`[prune-stale] resolved ${marketIdHex.slice(0, 8)}… → NO  (label: ${label})`);
      } catch (err: any) {
        const msg = String(err?.message || "");
        if (msg.includes("MarketAlreadyResolved") || msg.includes("already resolved")) {
          eventLedger.setMarketResolution(session.handleIdHex, marketIdHex, "NO");
          continue;
        }
        skipped.push({ marketId: marketIdHex, reason: msg.slice(0, 160) });
      }
    }
    res.json({ ok: true, resolved, skipped, lineupSize: session.lineup.length });
  } catch (err: any) {
    console.error("[POST /agent/sessions/:identifier/prune-stale-markets] Error:", oneLineErr(err));
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /agent/manual-tick?handleId=…&videoId=…
 * Debug endpoint — captures one game-state snapshot AND records it
 * into SessionStats under the given EventHandle. Lets us populate
 * the live-standings panel for an existing event without waiting on
 * the YouTube poll loop.
 *
 * Repeated calls accumulate (sessionStats edge-detection still
 * dedupes hand-strength flags / all-ins, so it's safe to spam).
 */
app.post("/agent/manual-tick", async (req, res) => {
  try {
    const handleId = (req.query.handleId as string) || "";
    const videoId = (req.query.videoId as string) || "";
    if (!handleId || !videoId) {
      return res.status(400).json({ error: "handleId + videoId required" });
    }
    const ev = eventLedger.get(handleId);
    if (!ev) return res.status(404).json({ error: "EventHandle not in ledger" });
    const t0 = Date.now();
    const snap = await debugGameState.snapshot(videoId);
    if (!snap) return res.status(502).json({ error: "snapshot failed", elapsedMs: Date.now() - t0 });
    const sessionLabel = ev.label ?? `event-${handleId.slice(0, 8)}`;
    sessionStats.recordSnapshot(sessionLabel, handleId, snap);
    const stats = sessionStats.get(sessionLabel);
    res.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      snapshot: snap,
      stats,
    });
  } catch (err: any) {
    console.error("[POST /agent/manual-tick] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /events
 * Operator-only — create a new EventHandle on-chain + register in ledger.
 * body: { label, category, closesAt, graduationThresholdUsdc?, graduationBatches?, feeBpsTaker?, feeBpsTreasury?, feeBpsRebates?, bootstrapSeedUsdc? }
 */
app.post("/events", async (req, res) => {
  try {
    if (!req.body?.label || !req.body?.closesAt) {
      return res.status(400).json({ error: "label + closesAt required" });
    }
    const out = await createEventOnChain(req.body);
    res.json({
      ok: true,
      txSig: out.txSig,
      handleIdHex: out.handleIdHex,
      eventHandlePda: out.eventHandlePda,
    });
  } catch (err: any) {
    console.error("[POST /events] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /events — list registered events. Closed events are filtered
 *  out by default; pass `?includeClosed=1` for ops/admin tooling that
 *  needs the full set. */
app.get("/events", (req, res) => {
  const includeClosed = req.query.includeClosed === "1" || req.query.includeClosed === "true";
  const all = eventLedger.list();
  const visible = includeClosed ? all : all.filter((ev) => !ev.closed);
  const events = visible.map((ev) => ({
    handleId: ev.handleId,
    label: ev.label,
    category: ev.category,
    eventHandlePda: ev.eventHandlePda,
    closesAt: ev.closesAt,
    graduationThresholdUsdc: ev.graduationThresholdUsdc.toString(),
    graduationBatches: ev.graduationBatches,
    graduated: ev.graduated,
    cumulativeVolumeUsdc: ev.cumulativeVolumeUsdc.toString(),
    marketCount: ev.marketIds.length,
    marketIds: ev.marketIds,
    marketLabels: ev.marketLabels ?? {},
    resolutions: ev.resolutions ?? {},
    feeBpsTaker: ev.feeBpsTaker,
    feeBpsTreasury: ev.feeBpsTreasury,
    feeBpsRebates: ev.feeBpsRebates,
    bootstrapSeedUsdc: ev.bootstrapSeedUsdc.toString(),
    closed: ev.closed,
  }));
  res.json({ events });
});

/**
 * POST /events/:handleIdHex/markets
 * Bind an existing market to an event. Stands up the bootstrap pool too.
 * body: { marketId: hex }
 */
app.post("/events/:handleIdHex/markets", async (req, res) => {
  try {
    const handleIdHex = req.params.handleIdHex;
    const { marketId: marketIdHex, label } = req.body || {};
    if (!marketIdHex) return res.status(400).json({ error: "marketId required" });
    if (!eventLedger.get(handleIdHex)) {
      return res.status(404).json({ error: "EventHandle not found in ledger" });
    }
    await seedMarketUnderEvent(handleIdHex, marketIdHex, label);
    res.json({ ok: true, marketCount: eventLedger.get(handleIdHex)!.marketIds.length });
  } catch (err: any) {
    console.error("[POST /events/.../markets] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /events/:handleIdHex
 * Drop an event from the off-chain ledger so it stops showing up in
 * /events lists and the EVENTS tab on the homepage. The on-chain
 * EventHandle PDA is left in place — it's immutable rent-funded
 * state, not worth a close-account flow for the demo. Operators can
 * re-register the event later (idempotent on handleId).
 *
 * Mostly used to nuke dev-iteration garbage (failed seeds, v1-v2
 * label drift) without redeploying the volume.
 */
app.delete("/events/:handleIdHex", (req, res) => {
  try {
    const handleIdHex = req.params.handleIdHex;
    const ev = eventLedger.get(handleIdHex);
    if (!ev) return res.status(404).json({ error: "EventHandle not in ledger" });
    eventLedger.remove(handleIdHex);
    res.json({ ok: true, removed: handleIdHex });
  } catch (err: any) {
    console.error("[DELETE /events/:handleIdHex] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /events/:handleIdHex/markets
 * Clear all market bindings under an event. Used to swap the market set
 * (e.g., reset demo data) without disturbing the on-chain EventHandle or
 * its accumulated graduation/volume state.
 */
app.delete("/events/:handleIdHex/markets", (req, res) => {
  try {
    const handleIdHex = req.params.handleIdHex;
    const ev = eventLedger.get(handleIdHex);
    if (!ev) return res.status(404).json({ error: "EventHandle not found in ledger" });
    const before = ev.marketIds.length;
    eventLedger.detachAllMarkets(handleIdHex);
    res.json({ ok: true, detached: before });
  } catch (err: any) {
    console.error("[DELETE /events/.../markets] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /market/:marketIdHex
 * Return metadata for a Predacy-native market — handle id of the parent
 * event, its label, and the market's own label (if attached with one).
 * The trading UI uses this to render the market detail page without
 * relying on Polymarket data.
 */
/**
 * GET /claims/:userPubkey
 * Scan every resolved market in the EventLedger and return the ones
 * where the user holds the winning side's token. Each entry includes
 * a pre-built unsigned redeem tx (base64) so the frontend can sign +
 * submit without an extra round-trip — the auto-claim UX equivalent
 * of Pumpcade's instant payout, modulo the user's signature.
 *
 * Response shape:
 *   { ok: true, claims: [
 *       { marketId, eventLabel, marketLabel, outcome, amount, txBase64 },
 *       ...
 *     ]
 *   }
 *
 * 200 with claims=[] when nothing redeemable. Errors propagate as 5xx.
 */
app.get("/claims/:userPubkey", async (req, res) => {
  try {
    const userKey = new PublicKey(req.params.userPubkey);
    const { getAssociatedTokenAddressSync, getAccount } = await import("@solana/spl-token");
    const protocolCfg = await client.fetchProtocolConfig();
    const usdcMint = (protocolCfg as any).usdcMint as PublicKey;
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, userKey, true);
    const conn = client.getConnection();
    const { blockhash } = await conn.getLatestBlockhash("confirmed");

    const claims: Array<{
      marketId: string;
      eventHandleId: string;
      eventLabel: string | null;
      marketLabel: string | null;
      outcome: "YES" | "NO";
      amount: string;
      txBase64: string;
    }> = [];

    for (const ev of eventLedger.list()) {
      if (!ev.resolutions) continue;
      for (const [marketIdHex, outcome] of Object.entries(ev.resolutions)) {
        const marketIdBuf = Buffer.from(marketIdHex, "hex");
        const winningMint = (outcome === "YES"
          ? client.yesMintPda(marketIdBuf)
          : client.noMintPda(marketIdBuf))[0];
        const userTokenAccount = getAssociatedTokenAddressSync(winningMint, userKey, true);
        let amount = 0n;
        try {
          const acc = await getAccount(conn, userTokenAccount);
          amount = BigInt(acc.amount.toString());
        } catch { /* user has no ATA on this side — skip */ }
        if (amount === 0n) continue;

        const tx = await client.buildRedeemOutcomeTx({
          marketId: marketIdBuf,
          user: userKey,
          userTokenAccount,
          userUsdcAccount: usdcAta,
          winningMint,
          amount,
        });
        tx.recentBlockhash = blockhash;
        const txBase64 = tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString("base64");

        claims.push({
          marketId: marketIdHex,
          eventHandleId: ev.handleId,
          eventLabel: ev.label ?? null,
          marketLabel: ev.marketLabels?.[marketIdHex] ?? null,
          outcome,
          amount: amount.toString(),
          txBase64,
        });
      }
    }

    res.json({ ok: true, count: claims.length, claims });
  } catch (err: any) {
    console.error("[GET /claims/:userPubkey] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /market/:marketIdHex/lmsr
 * Surface the on-chain BootstrapPool state + the LMSR's current
 * marginal-YES price (the anchor BatchProcessor will use on the next
 * batch). Returns 404 when the pool isn't init'd, 410 when it's
 * graduated to Tier 1. Used to verify Tier 0 price discovery without
 * waiting for a settled batch.
 */
app.get("/market/:marketIdHex/lmsr", async (req, res) => {
  try {
    const marketIdHex = req.params.marketIdHex.toLowerCase().replace(/^0x/, "");
    const marketIdBuf = Buffer.from(marketIdHex, "hex");
    let pool: any;
    try {
      pool = await client.fetchBootstrapPool(marketIdBuf);
    } catch {
      return res.status(404).json({ error: "bootstrap pool not initialised for this market" });
    }
    if (pool.graduated) {
      return res.status(410).json({ error: "pool graduated to Tier 1", graduated: true });
    }
    const { marginalPrice } = await import("./bootstrapCurve");
    const state = {
      currentQ: BigInt(pool.currentQ.toString()),
      bParam: BigInt(pool.bParam.toString()),
      yesShares: BigInt(pool.yesShares.toString()),
      noShares: BigInt(pool.noShares.toString()),
    };
    const yesProb = marginalPrice(state, "yes");
    res.json({
      marketId: marketIdHex,
      currentQ: state.currentQ.toString(),
      bParam: state.bParam.toString(),
      yesShares: state.yesShares.toString(),
      noShares: state.noShares.toString(),
      marginalYesProb: yesProb,
      marginalYesCents: Math.round(yesProb * 100),
      anchorMicroPrice: Math.round(yesProb * 1_000_000),
      graduated: false,
    });
  } catch (err: any) {
    console.error("[GET /market/:id/lmsr] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/market/:marketIdHex", (req, res) => {
  const marketIdHex = req.params.marketIdHex.toLowerCase().replace("0x", "");
  for (const ev of eventLedger.list()) {
    if (!ev.marketIds.includes(marketIdHex)) continue;
    const resolution = ev.resolutions?.[marketIdHex] ?? null;
    return res.json({
      marketId: marketIdHex,
      label: ev.marketLabels?.[marketIdHex] ?? null,
      eventHandleId: ev.handleId,
      eventLabel: ev.label ?? null,
      eventCategory: ev.category,
      eventClosesAt: ev.closesAt,
      feeBpsTaker: ev.feeBpsTaker,
      feeBpsRebates: ev.feeBpsRebates,
      graduated: ev.graduated,
      resolved: resolution !== null,
      outcome: resolution,
    });
  }
  return res.status(404).json({ error: "market not found in any event" });
});

/**
 * POST /redeem-outcome
 * Build an unsigned redeem_outcome tx the user can sign + submit.
 * Burns the user's full balance of winning tokens 1:1 for USDC.
 *
 * body: { marketIdHex, user, userUsdcAccount? }
 *   userUsdcAccount optional — if omitted we derive the standard ATA.
 *
 * response: { ok, txBase64, amount, outcome, marketLabel }
 */
app.post("/redeem-outcome", async (req, res) => {
  try {
    const { marketIdHex, user, userUsdcAccount } = req.body || {};
    if (!marketIdHex || !user) {
      return res.status(400).json({ error: "marketIdHex + user required" });
    }
    const marketIdHexNorm = String(marketIdHex).toLowerCase().replace(/^0x/, "");
    const evMatch = eventLedger.list().find((ev) => ev.marketIds.includes(marketIdHexNorm));
    if (!evMatch) return res.status(404).json({ error: "market not found in any event" });
    const outcome = evMatch.resolutions?.[marketIdHexNorm];
    if (!outcome) return res.status(409).json({ error: "market not resolved yet" });

    const userKey = new PublicKey(user);
    const marketIdBuf = Buffer.from(marketIdHexNorm, "hex");
    const winningMint = (outcome === "YES"
      ? client.yesMintPda(marketIdBuf)
      : client.noMintPda(marketIdBuf))[0];

    const { getAssociatedTokenAddressSync, getAccount } = await import("@solana/spl-token");
    const userTokenAccount = getAssociatedTokenAddressSync(winningMint, userKey, true);

    // Fetch the user's winning-side token balance — that's the amount we'll redeem.
    let amount: bigint = 0n;
    try {
      const acc = await getAccount(client.getConnection(), userTokenAccount);
      amount = BigInt(acc.amount.toString());
    } catch {
      return res.status(404).json({ error: `no ${outcome} tokens held by user for this market` });
    }
    if (amount === 0n) {
      return res.status(404).json({ error: `${outcome} token balance is zero — nothing to redeem` });
    }

    let usdcAta: PublicKey;
    if (userUsdcAccount) {
      usdcAta = new PublicKey(userUsdcAccount);
    } else {
      const protocolCfg = await client.fetchProtocolConfig();
      const usdcMint = (protocolCfg as any).usdcMint as PublicKey;
      usdcAta = getAssociatedTokenAddressSync(usdcMint, userKey, true);
    }

    const tx = await client.buildRedeemOutcomeTx({
      marketId: marketIdBuf,
      user: userKey,
      userTokenAccount,
      userUsdcAccount: usdcAta,
      winningMint,
      amount,
    });

    const { blockhash } = await client.getConnection().getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    const txBase64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");

    res.json({
      ok: true,
      txBase64,
      amount: amount.toString(),
      outcome,
      marketLabel: evMatch.marketLabels?.[marketIdHexNorm] ?? null,
    });
  } catch (err: any) {
    console.error("[POST /redeem-outcome] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /lp/commit
 * Build an unsigned commit_lp_capital transaction for the user to sign.
 * body: { handleIdHex, depositor, amount, commitmentExpiresAt }
 * response: { ok, txBase64 }  — frontend signs + submits, returning tx sig.
 */
app.post("/lp/commit", async (req, res) => {
  try {
    const { handleIdHex, depositor, amount, commitmentExpiresAt } = req.body || {};
    if (!handleIdHex || !depositor || !amount || !commitmentExpiresAt) {
      return res.status(400).json({ error: "handleIdHex + depositor + amount + commitmentExpiresAt required" });
    }
    const ev = eventLedger.get(handleIdHex);
    if (!ev) return res.status(404).json({ error: "EventHandle not found" });

    const { PublicKey } = await import("@solana/web3.js");
    const { getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
    const eventHandleKey = new PublicKey(ev.eventHandlePda);
    const depositorKey = new PublicKey(depositor);

    const protocolCfg = await client.fetchProtocolConfig();
    const usdcMint = (protocolCfg as any).usdcMint as PublicKey;

    // Vault USDC ATA — owned by the LP vault PDA. Created on demand by relayer
    // since vault PDAs can't sign their own ATA-creation rent-payer.
    const [vaultPda] = client.lpVaultPda(eventHandleKey);
    const vaultAta = await getOrCreateAssociatedTokenAccount(
      client.getConnection(),
      client.relayer,
      usdcMint,
      vaultPda,
      true, // allowOwnerOffCurve — required for PDA-owned ATA
    );
    const depositorAta = await getOrCreateAssociatedTokenAccount(
      client.getConnection(),
      client.relayer,
      usdcMint,
      depositorKey,
    );

    const tx = await client.commitLpCapital({
      eventHandleKey,
      depositor: depositorKey,
      depositorUsdc: depositorAta.address,
      vaultUsdc: vaultAta.address,
      amount: BigInt(amount),
      commitmentExpiresAt: BigInt(commitmentExpiresAt),
    });

    const blockhash = await client.getConnection().getLatestBlockhash();
    tx.recentBlockhash = blockhash.blockhash;
    const serialised = tx.serialize({ requireAllSignatures: false }).toString("base64");
    res.json({ ok: true, txBase64: serialised });
  } catch (err: any) {
    console.error("[POST /lp/commit] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /lp/commit-blind
 * Tier 1 Blind LP deposit. Same shape as /lp/commit but the deposit amount
 * is FHE-encrypted via Encrypt's CreateInput first; the resulting
 * ciphertext id is embedded in the on-chain ix.
 *
 * v1 trust model: relayer holds Encrypt's network key (same as batch
 * clearing). LP-self-decrypt at withdraw ships in Encrypt Alpha 1.
 *
 * body: { handleIdHex, depositor, amount, commitmentExpiresAt }
 * response: { ok, txBase64, ciphertextIdHex }
 */
app.post("/lp/commit-blind", async (req, res) => {
  try {
    const { handleIdHex, depositor, amount, commitmentExpiresAt } = req.body || {};
    if (!handleIdHex || !depositor || !amount || !commitmentExpiresAt) {
      return res.status(400).json({ error: "handleIdHex + depositor + amount + commitmentExpiresAt required" });
    }
    const ev = eventLedger.get(handleIdHex);
    if (!ev) return res.status(404).json({ error: "EventHandle not found" });

    const { PublicKey } = await import("@solana/web3.js");
    const { getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
    const { encryptDepositAmount } = await import("./blindLp");
    const eventHandleKey = new PublicKey(ev.eventHandlePda);
    const depositorKey = new PublicKey(depositor);

    // Sprint 2.4 bypass: if BLIND_LP_ENABLED=false (or unset), or if Encrypt
    // gRPC is unreachable, attempt plaintext fallback so the demo doesn't
    // hard-fail on infra outages. The on-chain ix path differs (commit_lp_capital
    // vs commit_lp_capital_blind), so the response signals which one to expect.
    const blindEnabled = process.env.BLIND_LP_ENABLED !== "false";
    let encryption;
    let mode: "blind" | "plaintext-fallback" = "blind";
    if (!blindEnabled) {
      mode = "plaintext-fallback";
      encryption = { ciphertextId: Buffer.alloc(32, 0), plaintextEcho: BigInt(amount) };
      console.log("[POST /lp/commit-blind] BLIND_LP_ENABLED=false — falling back to plaintext");
    } else {
      try {
        // Step 1: gRPC encrypt the deposit amount.
        encryption = await encryptDepositAmount(BigInt(amount), depositorKey);
      } catch (err: any) {
        mode = "plaintext-fallback";
        encryption = { ciphertextId: Buffer.alloc(32, 0), plaintextEcho: BigInt(amount) };
        console.warn(`[POST /lp/commit-blind] Encrypt gRPC unavailable, plaintext fallback: ${err.message}`);
      }
    }

    // Step 2: derive USDC ATAs the same way the plaintext path does.
    const protocolCfg = await client.fetchProtocolConfig();
    const usdcMint = (protocolCfg as any).usdcMint as PublicKey;
    const [vaultPda] = client.lpVaultPda(eventHandleKey);
    const vaultAta = await getOrCreateAssociatedTokenAccount(
      client.getConnection(), client.relayer, usdcMint, vaultPda, true,
    );
    const depositorAta = await getOrCreateAssociatedTokenAccount(
      client.getConnection(), client.relayer, usdcMint, depositorKey,
    );

    // Step 3: build the on-chain tx. In blind mode we use the new
    // commit_lp_capital_blind ix (carries ciphertext id). In plaintext-
    // fallback we use the existing commit_lp_capital so the deposit still
    // lands cleanly even when Encrypt is down.
    let tx;
    if (mode === "blind") {
      tx = await client.commitLpCapitalBlind({
        eventHandleKey,
        depositor: depositorKey,
        depositorUsdc: depositorAta.address,
        vaultUsdc: vaultAta.address,
        amount: BigInt(amount),
        commitmentExpiresAt: BigInt(commitmentExpiresAt),
        fheCiphertextId: encryption.ciphertextId,
      });
    } else {
      tx = await client.commitLpCapital({
        eventHandleKey,
        depositor: depositorKey,
        depositorUsdc: depositorAta.address,
        vaultUsdc: vaultAta.address,
        amount: BigInt(amount),
        commitmentExpiresAt: BigInt(commitmentExpiresAt),
      });
    }
    const blockhash = await client.getConnection().getLatestBlockhash();
    tx.recentBlockhash = blockhash.blockhash;
    const serialised = tx.serialize({ requireAllSignatures: false }).toString("base64");
    res.json({
      ok: true,
      mode,
      txBase64: serialised,
      ciphertextIdHex: mode === "blind" ? encryption.ciphertextId.toString("hex") : null,
    });
  } catch (err: any) {
    // Full error dump — Solana RPC errors often have empty .message but
    // detail under .logs / .transactionMessage / .stack. Default catch
    // was silently dropping these.
    const detail = {
      message: err?.message || String(err),
      logs: err?.logs,
      name: err?.name,
      code: err?.code,
      stack: err?.stack?.split("\n").slice(0, 4).join(" | "),
    };
    console.error("[POST /lp/commit-blind] Error:", JSON.stringify(detail));
    res.status(500).json({ error: detail.message, detail });
  }
});

/**
 * GET /lp/positions?wallet=...
 * Returns the LP's positions across all events.
 */
app.get("/lp/positions", async (req, res) => {
  try {
    const wallet = req.query.wallet as string;
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const { PublicKey } = await import("@solana/web3.js");
    const walletKey = new PublicKey(wallet);

    const positions: any[] = [];
    for (const ev of eventLedger.list()) {
      const eventHandleKey = new PublicKey(ev.eventHandlePda);
      const [vault] = client.lpVaultPda(eventHandleKey);
      try {
        const pos = await client.fetchLpPosition(vault, walletKey);
        positions.push({
          handleId: ev.handleId,
          category: ev.category,
          eventHandlePda: ev.eventHandlePda,
          shares: pos.sharesPlaintext.toString(),
          depositedUsdc: pos.depositedUsdc.toString(),
          depositedAt: Number(pos.depositedAt),
          commitmentExpiresAt: Number(pos.commitmentExpiresAt),
          withdrawn: pos.withdrawn,
        });
      } catch {
        // No position in this event — skip silently.
      }
    }
    res.json({ positions });
  } catch (err: any) {
    console.error("[GET /lp/positions] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /lp/withdraw
 * Build an unsigned withdraw_lp_capital transaction. Cranker (= caller)
 * pays the tx; payout always goes to depositor.
 * body: { handleIdHex, depositor, cranker }
 */
app.post("/lp/withdraw", async (req, res) => {
  try {
    const { handleIdHex, depositor, cranker } = req.body || {};
    if (!handleIdHex || !depositor || !cranker) {
      return res.status(400).json({ error: "handleIdHex + depositor + cranker required" });
    }
    const ev = eventLedger.get(handleIdHex);
    if (!ev) return res.status(404).json({ error: "EventHandle not found" });

    const { PublicKey } = await import("@solana/web3.js");
    const { getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
    const eventHandleKey = new PublicKey(ev.eventHandlePda);
    const depositorKey = new PublicKey(depositor);
    const crankerKey = new PublicKey(cranker);

    const protocolCfg = await client.fetchProtocolConfig();
    const usdcMint = (protocolCfg as any).usdcMint as PublicKey;
    const [vaultPda] = client.lpVaultPda(eventHandleKey);

    const vaultAta = await getOrCreateAssociatedTokenAccount(
      client.getConnection(), client.relayer, usdcMint, vaultPda, true,
    );
    const depositorAta = await getOrCreateAssociatedTokenAccount(
      client.getConnection(), client.relayer, usdcMint, depositorKey,
    );

    const tx = await client.withdrawLpCapital({
      eventHandleKey,
      depositor: depositorKey,
      depositorUsdc: depositorAta.address,
      vaultUsdc: vaultAta.address,
      cranker: crankerKey,
    });

    const blockhash = await client.getConnection().getLatestBlockhash();
    tx.recentBlockhash = blockhash.blockhash;
    const serialised = tx.serialize({ requireAllSignatures: false }).toString("base64");
    res.json({ ok: true, txBase64: serialised });
  } catch (err: any) {
    console.error("[POST /lp/withdraw] Error:", err.message);
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
