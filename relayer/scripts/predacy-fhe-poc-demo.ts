/**
 * Tiny-graph proof-of-concept demo: 3 inputs (limit, clearing, amount) →
 * 1 output (fill = (limit≥clearing) * amount). Shape matches what
 * Encrypt's pre-alpha mock executor processes (12 accounts, ~5 ops).
 *
 * Inputs:
 *   limit    = 0.60 (600,000)
 *   clearing = 0.55 (550,000)
 *   amount   = 100 USDC (100,000,000)
 *
 * Expected output (after executor processes):
 *   fill = 1 * 100,000,000 = 100,000,000
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn");
const ENCRYPT_PROGRAM = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const RPC_URL = `https://sol-devnet-rpc.rpcfast.com/?api_key=${process.env.RPC_FAST_API_KEY || "Mera4YdtfZgVWW3Nzkizi0LzY6wQb8PJrnUrjSvlNi3zbpdxm8tO7E6PAYSrggUH"}`;
const ENCRYPT_GRPC_URL = "pre-alpha-dev-1.encrypt.ika-network.net:443";
const NETWORK_KEY = Buffer.alloc(32, 0x55);
const FHE_TYPE_UINT64 = 4;

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function mockCiphertext(value: bigint): Buffer {
  // Uint64: [fhe_type=4, ...le_8_bytes]
  const buf = Buffer.alloc(9);
  buf[0] = FHE_TYPE_UINT64;
  buf.writeBigUInt64LE(value, 1);
  return buf;
}

async function callCreateInput(inputs: { ciphertext_bytes: Buffer; fhe_type: number }[], authorized: PublicKey): Promise<PublicKey[]> {
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true,
  });
  const proto: any = grpc.loadPackageDefinition(packageDef);
  const client = new proto.encrypt.v1.EncryptService(ENCRYPT_GRPC_URL, grpc.credentials.createSsl());

  return await new Promise((resolve, reject) => {
    client.CreateInput({
      chain: 0,
      inputs: inputs.map(i => ({ ciphertext_bytes: i.ciphertext_bytes, fhe_type: i.fhe_type })),
      proof: Buffer.alloc(0),
      authorized: authorized.toBuffer(),
      network_encryption_public_key: NETWORK_KEY,
    }, { deadline: Date.now() + 60_000 }, (err: any, resp: any) => {
      client.close();
      if (err) return reject(err);
      resolve(resp.ciphertext_identifiers.map((b: Uint8Array) => new PublicKey(Buffer.from(b))));
    });
  });
}

async function main() {
  console.log("\n╔══ predacy-fhe PoC tiny-graph demo (executor-friendly size) ══╗\n");

  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "predacy-fhe-idl.json"), "utf-8"));
  const program = new anchor.Program(idl, provider);

  const [encryptConfig] = pda([Buffer.from("encrypt_config")], ENCRYPT_PROGRAM);
  const [eventAuthority] = pda([Buffer.from("__event_authority")], ENCRYPT_PROGRAM);
  const [depositPda] = pda([Buffer.from("encrypt_deposit"), payer.publicKey.toBuffer()], ENCRYPT_PROGRAM);
  const [networkKeyPda] = pda([Buffer.from("network_encryption_key"), NETWORK_KEY], ENCRYPT_PROGRAM);
  const [cpiAuthority, cpiAuthorityBump] = pda([Buffer.from("__encrypt_cpi_authority")], PROGRAM_ID);

  console.log(`predacy-fhe: ${PROGRAM_ID.toBase58()}`);
  console.log(`Encrypt:     ${ENCRYPT_PROGRAM.toBase58()}\n`);

  // ── Create 3 input ciphertexts via gRPC ─────────────────────────────
  const inputs = [
    { value: 600_000n, label: "limit (0.60)" },
    { value: 550_000n, label: "clearing (0.55)" },
    { value: 100_000_000n, label: "amount (100 USDC)" },
  ];
  const grpcInputs = inputs.map(i => ({ ciphertext_bytes: mockCiphertext(i.value), fhe_type: FHE_TYPE_UINT64 }));
  console.log(`Calling CreateInput gRPC for 3 inputs…`);
  const ctPubkeys = await callCreateInput(grpcInputs, PROGRAM_ID);
  for (let i = 0; i < ctPubkeys.length; i++) {
    console.log(`  ${inputs[i].label.padEnd(22)} → ${ctPubkeys[i].toBase58().slice(0, 24)}…`);
  }
  const [limitCt, clearingCt, amountCt] = ctPubkeys;

  // ── Create 1 output ciphertext via on-chain create_plaintext CPI ────
  const fillCtKp = Keypair.generate();
  const createIx = await (program.methods as any)
    .createOutputCt(cpiAuthorityBump, FHE_TYPE_UINT64)
    .accounts({
      ciphertext: fillCtKp.publicKey,
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
  const cu0 = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash: bh0 } = await connection.getLatestBlockhash("confirmed");
  const m0 = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh0, instructions: [cu0, createIx] }).compileToV0Message();
  const v0 = new anchor.web3.VersionedTransaction(m0); v0.sign([payer, fillCtKp]);
  const sig0 = await connection.sendTransaction(v0, { skipPreflight: false });
  await connection.confirmTransaction(sig0, "confirmed");
  console.log(`  ${"output: fill".padEnd(22)} → ${fillCtKp.publicKey.toBase58().slice(0, 24)}…  (created via CPI)\n`);

  // ── Submit settle_poc_batch ────────────────────────────────────────
  console.log(`Submitting settle_poc_batch…`);
  const settleIx = await (program.methods as any)
    .settlePocBatch(cpiAuthorityBump)
    .accounts({
      limitCt: limitCt,
      clearingCt: clearingCt,
      amountCt: amountCt,
      fillCt: fillCtKp.publicKey,
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
  const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const m = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh0, instructions: [cu, settleIx] }).compileToV0Message();
  const v = new anchor.web3.VersionedTransaction(m); v.sign([payer]);

  const sim = await connection.simulateTransaction(v, { commitment: "confirmed", sigVerify: false });
  console.log(`Simulation logs (${sim.value.logs?.length ?? 0}):`);
  for (const l of (sim.value.logs ?? [])) console.log(`  ${l}`);
  console.log(`err: ${JSON.stringify(sim.value.err)}\n`);

  const settleSig = await connection.sendTransaction(v, { skipPreflight: false });
  await connection.confirmTransaction(settleSig, "confirmed");
  console.log(`✓ tx: ${settleSig}`);
  console.log(`  https://solscan.io/tx/${settleSig}?cluster=devnet\n`);

  // ── Poll output for executor processing ────────────────────────────
  const initialDigest = (await connection.getAccountInfo(fillCtKp.publicKey))!.data.subarray(2, 34).toString("hex");
  console.log(`Polling fill_ct for executor commit (initial digest: ${initialDigest.slice(0, 16)}…)…`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const info = await connection.getAccountInfo(fillCtKp.publicKey);
    const digest = info!.data.subarray(2, 34).toString("hex");
    process.stdout.write(`\r  poll ${(i + 1).toString().padStart(2)}/60: digest=${digest.slice(0, 16)}…`);
    if (digest !== initialDigest) {
      console.log(` ✓ COMMITTED!\n`);
      break;
    }
  }
  console.log();

  // ── Make output public so we can read it via gRPC ──────────────────
  console.log(`Calling make_output_public to authorize public reads…`);
  const mpIx = await (program.methods as any)
    .makeOutputPublic(cpiAuthorityBump)
    .accounts({
      ciphertext: fillCtKp.publicKey,
      cpiAuthority,
      callerProgram: PROGRAM_ID,
      encryptProgram: ENCRYPT_PROGRAM,
    })
    .instruction();
  const cuMp = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const { blockhash: bhMp } = await connection.getLatestBlockhash("confirmed");
  const mMp = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bhMp, instructions: [cuMp, mpIx] }).compileToV0Message();
  const vMp = new anchor.web3.VersionedTransaction(mMp); vMp.sign([payer]);
  const sigMp = await connection.sendTransaction(vMp, { skipPreflight: false });
  await connection.confirmTransaction(sigMp, "confirmed");
  console.log(`  ✓ ${sigMp}\n`);

  // Decrypt
  console.log(`Decrypting fill_ct via gRPC ReadCiphertext…`);
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, { keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true });
  const proto: any = grpc.loadPackageDefinition(packageDef);
  const client = new proto.encrypt.v1.EncryptService(ENCRYPT_GRPC_URL, grpc.credentials.createSsl());

  // BCS-encode ReadCiphertextMessage: chain(u8) || ct_id_len(uleb) || ct_id || rk_len(uleb) || rk || epoch(u64 LE)
  const reencryptionKey = Buffer.alloc(32, 0);
  const ctIdent = fillCtKp.publicKey.toBuffer();
  const message = Buffer.concat([
    Buffer.from([0]), // chain=0
    Buffer.from([ctIdent.length]), ctIdent,
    Buffer.from([reencryptionKey.length]), reencryptionKey,
    Buffer.alloc(8), // epoch=0
  ]);
  const { ed25519 } = await import("@noble/curves/ed25519");
  const signature = ed25519.sign(message, payer.secretKey.slice(0, 32));

  await new Promise<void>((resolve, reject) => {
    client.ReadCiphertext({
      message: message,
      signature: Buffer.from(signature),
      signer: payer.publicKey.toBuffer(),
    }, { deadline: Date.now() + 30_000 }, (err: any, resp: any) => {
      client.close();
      if (err) {
        console.log(`  ReadCiphertext failed: ${err.message}`);
        // Try with PROGRAM_ID as authorized
        return reject(err);
      }
      const value = Buffer.from(resp.value);
      const plain = value.length === 8 ? value.readBigUInt64LE(0) : 0n;
      console.log(`\n  fill = ${plain.toString()} (expected: 100,000,000)`);
      console.log(`\n${plain === 100_000_000n ? "✓ MATCH — FHE compute end-to-end on devnet" : "✗ Unexpected value"}`);
      resolve();
    });
  });
}

main().catch(err => { console.error("\n❌", err); process.exit(1); });
