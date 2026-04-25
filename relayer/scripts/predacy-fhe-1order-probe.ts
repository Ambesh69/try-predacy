/**
 * Probe: exactly 1 order × 4 sides — same shape as 1/4 of production graph.
 * Mixed types (Uint8 side + Uint64 limit/amount/clearing) → 4 Uint64 outputs.
 *
 * Inputs:
 *   side=YES_BUY (0), limit=0.60, amount=100 USDC, clearing=0.55
 * Expected:
 *   yb=100,000,000 (only YES_BUY fills since side=0 + limit≥clearing)
 *   ys=0, nb=0, ns=0
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ed25519 } from "@noble/curves/ed25519";
import * as fs from "fs";
import * as path from "path";
import { RPC_FAST_URL, ENCRYPT_GRPC_URL } from "../src/rpcConfig";

const PROGRAM_ID = new PublicKey("59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn");
const ENCRYPT_PROGRAM = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const NETWORK_KEY = Buffer.alloc(32, 0x55);

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function mockCt(fheType: number, value: bigint): Buffer {
  if (fheType === 1) {
    const b = Buffer.alloc(2); b[0] = 1; b[1] = Number(value & 0xffn); return b;
  }
  const b = Buffer.alloc(9); b[0] = 4; b.writeBigUInt64LE(value, 1); return b;
}

async function callCreateInput(inputs: { fheType: number; value: bigint }[], authorized: PublicKey): Promise<PublicKey[]> {
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, { keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true });
  const proto: any = grpc.loadPackageDefinition(packageDef);
  const client = new proto.encrypt.v1.EncryptService(ENCRYPT_GRPC_URL, grpc.credentials.createSsl());
  return await new Promise((resolve, reject) => {
    client.CreateInput({
      chain: 0,
      inputs: inputs.map(i => ({ ciphertext_bytes: mockCt(i.fheType, i.value), fhe_type: i.fheType })),
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

async function readPlaintext(client: any, ctPk: PublicKey, signer: Keypair): Promise<bigint> {
  const reencryptionKey = Buffer.alloc(32, 0);
  const message = Buffer.concat([
    Buffer.from([0]),                              // chain=0 (u8)
    Buffer.from([ctPk.toBuffer().length]),         // ULEB128 len
    ctPk.toBuffer(),
    Buffer.from([reencryptionKey.length]),
    reencryptionKey,
    Buffer.alloc(8),                                // epoch=0
  ]);
  const signature = ed25519.sign(message, signer.secretKey.slice(0, 32));
  return await new Promise((resolve, reject) => {
    client.ReadCiphertext({
      message: message,
      signature: Buffer.from(signature),
      signer: signer.publicKey.toBuffer(),
    }, { deadline: Date.now() + 30_000 }, (err: any, resp: any) => {
      if (err) return reject(err);
      const value = Buffer.from(resp.value);
      resolve(value.length === 8 ? value.readBigUInt64LE(0) : 0n);
    });
  });
}

async function main() {
  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));
  const connection = new Connection(RPC_FAST_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "predacy-fhe-idl.json"), "utf-8"));
  const program = new anchor.Program(idl, provider);

  const [encryptConfig] = pda([Buffer.from("encrypt_config")], ENCRYPT_PROGRAM);
  const [eventAuthority] = pda([Buffer.from("__event_authority")], ENCRYPT_PROGRAM);
  const [depositPda] = pda([Buffer.from("encrypt_deposit"), payer.publicKey.toBuffer()], ENCRYPT_PROGRAM);
  const [networkKeyPda] = pda([Buffer.from("network_encryption_key"), NETWORK_KEY], ENCRYPT_PROGRAM);
  const [cpiAuthority, cpiAuthorityBump] = pda([Buffer.from("__encrypt_cpi_authority")], PROGRAM_ID);

  console.log("\n══ 1-order × 4-sides probe (mirrors production per-order math) ══\n");

  // Inputs: side=0 (YES_BUY), limit=0.60, amount=100, clearing=0.55
  const ctPubkeys = await callCreateInput([
    { fheType: 1, value: 0n },          // side = YES_BUY
    { fheType: 4, value: 600_000n },    // limit
    { fheType: 4, value: 100_000_000n },// amount
    { fheType: 4, value: 550_000n },    // clearing
  ], PROGRAM_ID);
  console.log(`✓ inputs:  ${ctPubkeys.map(p => p.toBase58().slice(0,12)).join(", ")}`);

  // Pre-create 4 outputs
  const outputs: Keypair[] = [];
  for (let i = 0; i < 4; i++) outputs.push(Keypair.generate());
  for (const kp of outputs) {
    const ix = await (program.methods as any).createOutputCt(cpiAuthorityBump, 4)
      .accounts({
        ciphertext: kp.publicKey, config: encryptConfig, deposit: depositPda,
        cpiAuthority, callerProgram: PROGRAM_ID, networkEncryptionKey: networkKeyPda,
        eventAuthority, encryptProgram: ENCRYPT_PROGRAM, payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      }).instruction();
    const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const m = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [cu, ix] }).compileToV0Message();
    const v = new anchor.web3.VersionedTransaction(m); v.sign([payer, kp]);
    await connection.confirmTransaction(await connection.sendTransaction(v, {}), "confirmed");
  }
  console.log(`✓ outputs: ${outputs.map(o => o.publicKey.toBase58().slice(0,12)).join(", ")}`);

  const initialDigests = await Promise.all(outputs.map(async kp => {
    const info = await connection.getAccountInfo(kp.publicKey);
    return info!.data.subarray(2, 34).toString("hex");
  }));

  // Submit
  const settleIx = await (program.methods as any).settleBisect1Order4Sides(cpiAuthorityBump)
    .accounts({
      inA: ctPubkeys[0], inB: ctPubkeys[1], inC: ctPubkeys[2], inD: ctPubkeys[3],
      out1: outputs[0].publicKey, out2: outputs[1].publicKey, out3: outputs[2].publicKey, out4: outputs[3].publicKey,
      encryptProgram: ENCRYPT_PROGRAM, config: encryptConfig, deposit: depositPda,
      cpiAuthority, callerProgram: PROGRAM_ID, networkEncryptionKey: networkKeyPda,
      eventAuthority, payer: payer.publicKey, systemProgram: SystemProgram.programId,
    }).instruction();
  const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const m = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [cu, settleIx] }).compileToV0Message();
  const v = new anchor.web3.VersionedTransaction(m); v.sign([payer]);
  const sig = await connection.sendTransaction(v, {});
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`✓ submit: ${sig}\n  https://solscan.io/tx/${sig}?cluster=devnet`);

  // Poll
  const t0 = Date.now();
  let processedAt: number | null = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const digests = await Promise.all(outputs.map(async kp => (await connection.getAccountInfo(kp.publicKey))!.data.subarray(2, 34).toString("hex")));
    const changedAll = digests.every((d, idx) => d !== initialDigests[idx]);
    if (changedAll) { processedAt = Date.now() - t0; break; }
  }
  if (processedAt === null) {
    console.log(`\n✗ executor SKIPPED — even 4-input mixed-type 4-output graph doesn't process`);
    return;
  }
  console.log(`\n✓ EXECUTOR PROCESSED in +${processedAt}ms`);

  // Make all 4 public + read
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, { keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true });
  const proto: any = grpc.loadPackageDefinition(packageDef);
  const client = new proto.encrypt.v1.EncryptService(ENCRYPT_GRPC_URL, grpc.credentials.createSsl());

  const labels = ["yb (YES_BUY)", "ys (YES_SELL)", "nb (NO_BUY)", "ns (NO_SELL)"];
  for (let i = 0; i < 4; i++) {
    const mp = await (program.methods as any).makeOutputPublic(cpiAuthorityBump)
      .accounts({ ciphertext: outputs[i].publicKey, cpiAuthority, callerProgram: PROGRAM_ID, encryptProgram: ENCRYPT_PROGRAM })
      .instruction();
    const cuMp = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const { blockhash: bh } = await connection.getLatestBlockhash("confirmed");
    const mMp = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh, instructions: [cuMp, mp] }).compileToV0Message();
    const vMp = new anchor.web3.VersionedTransaction(mMp); vMp.sign([payer]);
    await connection.confirmTransaction(await connection.sendTransaction(vMp, {}), "confirmed");
    const v = await readPlaintext(client, outputs[i].publicKey, payer);
    console.log(`  ${labels[i].padEnd(16)} = ${v.toString()}`);
  }
  client.close();

  console.log("\nExpected: yb=100000000, ys=0, nb=0, ns=0");
}
main().catch(err => { console.error(err); process.exit(1); });
