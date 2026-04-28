/**
 * On-chain FHE clearing via the predacy-fhe Anchor program.
 *
 * Replaces the TS-side mock encryptedClearing.ts when
 * `PRIVACY_MODE=onchain-fhe`. Submits up to 4 orders + a clearing price
 * through Encrypt's gRPC + on-chain CPI pipeline, gets back 4 byte-correct
 * decrypted aggregates (yes_buy_vol, no_buy_vol, yes_sell_qty, no_sell_qty).
 *
 * Pipeline:
 *   1. gRPC CreateInput — register 13 input ciphertexts (4 orders × 3
 *      fields + clearing price) on Encrypt's network.
 *   2. on-chain create_plaintext CPI — pre-create 4 output ciphertexts.
 *   3. settle_fhe_batch CPI — fire the FHE graph through Encrypt's coprocessor.
 *   4. Poll for executor to commit new digests (typically 2-5s).
 *   5. request_output_decryption per output — decryptor responds with plaintext.
 *
 * Production graph is hardcoded to 4 orders. Batches with fewer pad with
 * zero-amount dummies; batches with more chunk into groups of 4 and sum
 * the per-chunk aggregates.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as fs from "fs";
import * as path from "path";
import type { Order } from "./types";
import { ENCRYPT_GRPC_URL } from "./rpcConfig";

const PROGRAM_ID = new PublicKey("59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn");
const ENCRYPT_PROGRAM = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const NETWORK_KEY = Buffer.alloc(32, 0x55);
const FHE_TYPE_UINT8 = 1;
const FHE_TYPE_UINT64 = 4;

// Side encoding (matches predacy-fhe + clearingPrice.ts)
const SIDE_YES_BUY = 0;
const SIDE_YES_SELL = 1;
const SIDE_NO_BUY = 2;
const SIDE_NO_SELL = 3;

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function mockCt(fheType: number, value: bigint): Buffer {
  if (fheType === FHE_TYPE_UINT8) {
    const b = Buffer.alloc(2);
    b[0] = FHE_TYPE_UINT8;
    b[1] = Number(value & 0xffn);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = FHE_TYPE_UINT64;
  b.writeBigUInt64LE(value, 1);
  return b;
}

function loadProto() {
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDef) as any;
}

async function callCreateInput(
  inputs: { fheType: number; value: bigint }[],
  authorized: PublicKey,
): Promise<PublicKey[]> {
  const proto = loadProto();
  const client = new proto.encrypt.v1.EncryptService(ENCRYPT_GRPC_URL, grpc.credentials.createSsl());
  return await new Promise((resolve, reject) => {
    client.CreateInput(
      {
        chain: 0,
        inputs: inputs.map(i => ({ ciphertext_bytes: mockCt(i.fheType, i.value), fhe_type: i.fheType })),
        proof: Buffer.alloc(0),
        authorized: authorized.toBuffer(),
        network_encryption_public_key: NETWORK_KEY,
      },
      { deadline: Date.now() + 60_000 },
      (err: any, resp: any) => {
        client.close();
        if (err) return reject(new Error(`gRPC CreateInput failed: ${err.message}`));
        resolve(resp.ciphertext_identifiers.map((b: Uint8Array) => new PublicKey(Buffer.from(b))));
      },
    );
  });
}

export interface OnchainFheClearingResult {
  filledYesBuyVol: bigint;
  filledNoBuyVol: bigint;
  filledYesSellQty: bigint;
  filledNoSellQty: bigint;
  /** Tx signature of the settle_fhe_batch on-chain CPI. */
  settleTxSig: string;
  /** Latency in ms from submit to executor-committed digests. */
  executorLatencyMs: number;
  /** Total wall-clock elapsed including gRPC + decryption. */
  totalElapsedMs: number;
}

interface Order4 {
  side: number;     // 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL
  limit: bigint;    // micro-USDC (e.g. 0.55 → 550000)
  amount: bigint;   // total amount in micro-USDC
}

/**
 * Settle one chunk of exactly 4 orders via the on-chain FHE graph.
 * Returns the 4 side-aggregate fills.
 */
async function settleOneChunk(
  connection: Connection,
  payer: Keypair,
  program: any,
  orders: Order4[],
  clearingPrice: bigint,
): Promise<{
  yesBuy: bigint;
  noBuy: bigint;
  yesSell: bigint;
  noSell: bigint;
  txSig: string;
  executorLatencyMs: number;
}> {
  if (orders.length !== 4) throw new Error(`expected 4 orders, got ${orders.length}`);

  const [encryptConfig] = pda([Buffer.from("encrypt_config")], ENCRYPT_PROGRAM);
  const [eventAuthority] = pda([Buffer.from("__event_authority")], ENCRYPT_PROGRAM);
  const [depositPda, depositBump] = pda(
    [Buffer.from("encrypt_deposit"), payer.publicKey.toBuffer()],
    ENCRYPT_PROGRAM,
  );
  const [networkKeyPda] = pda(
    [Buffer.from("network_encryption_key"), NETWORK_KEY],
    ENCRYPT_PROGRAM,
  );
  const [cpiAuthority, cpiAuthorityBump] = pda(
    [Buffer.from("__encrypt_cpi_authority")],
    PROGRAM_ID,
  );

  // Ensure deposit PDA exists (one-time bootstrap)
  const depositInfo = await connection.getAccountInfo(depositPda);
  if (!depositInfo) {
    const cfgInfo = await connection.getAccountInfo(encryptConfig);
    if (!cfgInfo) throw new Error("Encrypt config missing on devnet");
    const vault = new PublicKey(cfgInfo.data.subarray(100, 132));
    const vaultPk = vault.equals(SystemProgram.programId) ? payer.publicKey : vault;
    const depData = Buffer.alloc(18);
    depData[0] = 14;
    depData[1] = depositBump;
    const ix = new anchor.web3.TransactionInstruction({
      programId: ENCRYPT_PROGRAM,
      data: depData,
      keys: [
        { pubkey: depositPda, isSigner: false, isWritable: true },
        { pubkey: encryptConfig, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultPk, isSigner: vaultPk.equals(payer.publicKey), isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
    const tx = new anchor.web3.Transaction().add(ix);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    await connection.sendRawTransaction(tx.serialize());
    await new Promise(r => setTimeout(r, 3000));
  }

  // 1. Register 13 inputs via gRPC
  const grpcInputs: { fheType: number; value: bigint }[] = [];
  for (const o of orders) {
    grpcInputs.push({ fheType: FHE_TYPE_UINT8, value: BigInt(o.side) });
    grpcInputs.push({ fheType: FHE_TYPE_UINT64, value: o.limit });
    grpcInputs.push({ fheType: FHE_TYPE_UINT64, value: o.amount });
  }
  grpcInputs.push({ fheType: FHE_TYPE_UINT64, value: clearingPrice });
  const ctPubkeys = await callCreateInput(grpcInputs, PROGRAM_ID);
  const [
    o0Side, o0Limit, o0Amount,
    o1Side, o1Limit, o1Amount,
    o2Side, o2Limit, o2Amount,
    o3Side, o3Limit, o3Amount,
    clearingCt,
  ] = ctPubkeys;

  // 2. Pre-create 4 output cts via on-chain create_plaintext CPI
  const outputs: Keypair[] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const kp of outputs) {
    const ix = await (program.methods as any)
      .createOutputCt(cpiAuthorityBump, FHE_TYPE_UINT64)
      .accounts({
        ciphertext: kp.publicKey,
        config: encryptConfig,
        deposit: depositPda,
        cpiAuthority,
        callerProgram: PROGRAM_ID,
        networkEncryptionKey: networkKeyPda,
        eventAuthority,
        encryptProgram: ENCRYPT_PROGRAM,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const m = new anchor.web3.TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [cu, ix],
    }).compileToV0Message();
    const v = new anchor.web3.VersionedTransaction(m);
    v.sign([payer, kp]);
    await connection.confirmTransaction(await connection.sendTransaction(v, {}), "confirmed");
  }

  // 3. register_batch
  const marketId = Buffer.alloc(32);
  Buffer.from("predacy-fhe-prod-v1").copy(marketId);
  const batchIndex = BigInt(Date.now());
  const [recordPda] = pda(
    [
      Buffer.from("fhe_batch"),
      marketId,
      Buffer.from(new anchor.BN(batchIndex.toString()).toArray("le", 8)),
    ],
    PROGRAM_ID,
  );
  const regSig = await (program.methods as any)
    .registerBatch(
      Array.from(marketId),
      new anchor.BN(batchIndex.toString()),
      Array.from(outputs[0].publicKey.toBytes()),
      Array.from(outputs[1].publicKey.toBytes()),
      Array.from(outputs[2].publicKey.toBytes()),
      Array.from(outputs[3].publicKey.toBytes()),
    )
    .accounts({
      record: recordPda,
      authority: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });

  // 4. settle_fhe_batch
  const initialDigests = await Promise.all(
    outputs.map(async kp => {
      const info = await connection.getAccountInfo(kp.publicKey);
      return info!.data.subarray(2, 34).toString("hex");
    }),
  );

  const settleIx = await (program.methods as any)
    .settleFheBatch(cpiAuthorityBump)
    .accounts({
      record: recordPda,
      o0SideCt: o0Side, o0LimitCt: o0Limit, o0AmountCt: o0Amount,
      o1SideCt: o1Side, o1LimitCt: o1Limit, o1AmountCt: o1Amount,
      o2SideCt: o2Side, o2LimitCt: o2Limit, o2AmountCt: o2Amount,
      o3SideCt: o3Side, o3LimitCt: o3Limit, o3AmountCt: o3Amount,
      clearingPriceCt: clearingCt,
      yesBuyVolCt: outputs[0].publicKey,
      noBuyVolCt: outputs[1].publicKey,
      yesSellQtyCt: outputs[2].publicKey,
      noSellQtyCt: outputs[3].publicKey,
      encryptProgram: ENCRYPT_PROGRAM,
      config: encryptConfig,
      deposit: depositPda,
      cpiAuthority,
      callerProgram: PROGRAM_ID,
      networkEncryptionKey: networkKeyPda,
      eventAuthority,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new anchor.web3.TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cu, settleIx],
  }).compileToV0Message();
  const vtx = new anchor.web3.VersionedTransaction(msg);
  vtx.sign([payer]);
  const settleSig = await connection.sendTransaction(vtx, { skipPreflight: false });
  await connection.confirmTransaction(settleSig, "confirmed");

  // 5. Poll for executor to commit new digests. Encrypt's pre-Alpha
  // executor typically takes 2-5s but can spike to 30-90s under load
  // (observed batches 277 ✓ at ~6s, 278 ✗ at >60s on 2026-04-28).
  // Budget 120s; log progress every 20s so a slow batch is visible
  // rather than feeling stuck. Plaintext fallback in batchProcessor
  // catches the throw if even 120s isn't enough.
  const POLL_INTERVAL_MS = 2000;
  const POLL_MAX_ITERATIONS = 60;          // 60 × 2s = 120s budget
  const PROGRESS_LOG_EVERY_ITERATIONS = 10; // every 20s
  const submittedAt = Date.now();
  let executorLatencyMs = 0;
  for (let i = 0; i < POLL_MAX_ITERATIONS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const digests = await Promise.all(
      outputs.map(async kp => {
        const info = await connection.getAccountInfo(kp.publicKey);
        return info!.data.subarray(2, 34).toString("hex");
      }),
    );
    if (digests.every((d, idx) => d !== initialDigests[idx])) {
      executorLatencyMs = Date.now() - submittedAt;
      break;
    }
    if ((i + 1) % PROGRESS_LOG_EVERY_ITERATIONS === 0) {
      const elapsedSec = Math.round((Date.now() - submittedAt) / 1000);
      console.log(
        `[onchain-FHE] still waiting for executor commit, ${elapsedSec}s elapsed (budget 120s) — tx ${settleSig.slice(0, 12)}…`,
      );
    }
  }
  if (executorLatencyMs === 0) {
    throw new Error(
      `onchain FHE executor didn't commit within 120s for tx ${settleSig}` +
        ` — Encrypt pre-Alpha capacity issue, falling back to plaintext`,
    );
  }

  // 6. request_output_decryption per output → poll DecryptionRequest accounts
  const aggregates: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    const reqAcct = Keypair.generate();
    const reqIx = await (program.methods as any)
      .requestOutputDecryption(cpiAuthorityBump)
      .accounts({
        record: recordPda,
        outputCt: outputs[i].publicKey,
        requestAcct: reqAcct.publicKey,
        config: encryptConfig,
        deposit: depositPda,
        cpiAuthority,
        callerProgram: PROGRAM_ID,
        networkEncryptionKey: networkKeyPda,
        eventAuthority,
        encryptProgram: ENCRYPT_PROGRAM,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const cu2 = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const { blockhash: bh2 } = await connection.getLatestBlockhash("confirmed");
    const m2 = new anchor.web3.TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: bh2,
      instructions: [cu2, reqIx],
    }).compileToV0Message();
    const v2 = new anchor.web3.VersionedTransaction(m2);
    v2.sign([payer, reqAcct]);
    await connection.confirmTransaction(await connection.sendTransaction(v2, {}), "confirmed");

    let revealed: bigint | null = null;
    for (let j = 0; j < 30; j++) {
      await new Promise(r => setTimeout(r, 2000));
      const info = await connection.getAccountInfo(reqAcct.publicKey);
      if (!info) continue;
      const total = info.data.readUInt32LE(99);
      const written = info.data.readUInt32LE(103);
      if (written > 0 && written >= total && total === 8) {
        revealed = info.data.readBigUInt64LE(107);
        break;
      }
    }
    if (revealed === null) throw new Error(`decryption timeout for output ${i}`);
    aggregates.push(revealed);
  }

  return {
    yesBuy: aggregates[0],
    noBuy: aggregates[1],
    yesSell: aggregates[2],
    noSell: aggregates[3],
    txSig: settleSig,
    executorLatencyMs,
  };
}

/**
 * Compute clearing aggregates for a batch via the on-chain FHE program.
 *
 * Pads to multiples of 4 with zero-amount dummies. For batches with more
 * than 4 orders, chunks into groups of 4 and sums the per-chunk aggregates.
 *
 * `clearingPrice` is computed by the caller (plaintext); the FHE graph
 * uses it as input. (The graph computes the 4 fill aggregates given a
 * fixed clearing price — clearing-price discovery itself is plaintext.)
 */
export async function computeOnchainFheClearing(
  connection: Connection,
  payer: Keypair,
  program: any,
  orders: Order[],
  clearingPrice: bigint,
): Promise<OnchainFheClearingResult> {
  const t0 = Date.now();

  // Convert orders to fixed-shape Order4[].
  const order4s: Order4[] = orders.map(o => ({
    side: o.side,
    limit: o.limitPrice,
    amount: o.amount,
  }));

  // Pad to multiple of 4 with zero-amount dummies (side=0 with amount=0
  // contributes 0 to all aggregates regardless of price comparison).
  while (order4s.length % 4 !== 0 || order4s.length === 0) {
    order4s.push({ side: SIDE_YES_BUY, limit: 0n, amount: 0n });
  }

  // Chunk into groups of 4 and accumulate
  let yesBuy = 0n, noBuy = 0n, yesSell = 0n, noSell = 0n;
  let lastTxSig = "";
  let lastLatency = 0;
  for (let i = 0; i < order4s.length; i += 4) {
    const chunk = order4s.slice(i, i + 4);
    const r = await settleOneChunk(connection, payer, program, chunk, clearingPrice);
    yesBuy += r.yesBuy;
    noBuy += r.noBuy;
    yesSell += r.yesSell;
    noSell += r.noSell;
    lastTxSig = r.txSig;
    lastLatency = r.executorLatencyMs;
  }

  return {
    filledYesBuyVol: yesBuy,
    filledNoBuyVol: noBuy,
    filledYesSellQty: yesSell,
    filledNoSellQty: noSell,
    settleTxSig: lastTxSig,
    executorLatencyMs: lastLatency,
    totalElapsedMs: Date.now() - t0,
  };
}

/** Load the predacy-fhe Anchor Program from the bundled IDL. */
export function loadPredacyFheProgram(provider: anchor.AnchorProvider): any {
  const idlPath = path.join(__dirname, "..", "predacy-fhe-idl.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  return new anchor.Program(idl, provider);
}
