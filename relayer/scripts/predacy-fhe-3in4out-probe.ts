/**
 * Probe: 3in/4out (all Uint64, additions/mults). Verifies if multi-output
 * graphs return correct math or always zeros. Inputs a=10, b=20, c=30.
 * Expected outputs: (a+b, b+c, a*c, a>=b) = (30, 50, 300, 0).
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ed25519 } from "@noble/curves/ed25519";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn");
const ENCRYPT_PROGRAM = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const RPC_URL = `https://sol-devnet-rpc.rpcfast.com/?api_key=${process.env.RPC_FAST_API_KEY || "Mera4YdtfZgVWW3Nzkizi0LzY6wQb8PJrnUrjSvlNi3zbpdxm8tO7E6PAYSrggUH"}`;
const ENCRYPT_GRPC_URL = "pre-alpha-dev-1.encrypt.ika-network.net:443";
const NETWORK_KEY = Buffer.alloc(32, 0x55);

function pda(seeds: any[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function mockCt(value: bigint): Buffer {
  const b = Buffer.alloc(9); b[0] = 4; b.writeBigUInt64LE(value, 1); return b;
}

async function callCreateInput(values: bigint[], authorized: PublicKey): Promise<PublicKey[]> {
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, { keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true });
  const proto: any = grpc.loadPackageDefinition(packageDef);
  const client = new proto.encrypt.v1.EncryptService(ENCRYPT_GRPC_URL, grpc.credentials.createSsl());
  return await new Promise((resolve, reject) => {
    client.CreateInput({
      chain: 0,
      inputs: values.map(v => ({ ciphertext_bytes: mockCt(v), fhe_type: 4 })),
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
  const message = Buffer.concat([
    Buffer.from([0]),
    Buffer.from([32]), ctPk.toBuffer(),
    Buffer.from([32]), Buffer.alloc(32, 0),
    Buffer.alloc(8),
  ]);
  const signature = ed25519.sign(message, signer.secretKey.slice(0, 32));
  return await new Promise((resolve, reject) => {
    client.ReadCiphertext({ message, signature: Buffer.from(signature), signer: signer.publicKey.toBuffer() },
      { deadline: Date.now() + 30_000 }, (err: any, resp: any) => {
        if (err) return reject(err);
        const value = Buffer.from(resp.value);
        resolve(value.length === 8 ? value.readBigUInt64LE(0) : 0n);
      });
  });
}

async function main() {
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

  console.log("\n══ 3in/4out probe — verify multi-output math ══\n");
  const ctPubkeys = await callCreateInput([10n, 20n, 30n], PROGRAM_ID);
  console.log(`✓ inputs (a=10, b=20, c=30): ${ctPubkeys.map(p => p.toBase58().slice(0, 12)).join(", ")}`);

  const outputs = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const kp of outputs) {
    const ix = await (program.methods as any).createOutputCt(cpiAuthorityBump, 4)
      .accounts({ ciphertext: kp.publicKey, config: encryptConfig, deposit: depositPda, cpiAuthority, callerProgram: PROGRAM_ID, networkEncryptionKey: networkKeyPda, eventAuthority, encryptProgram: ENCRYPT_PROGRAM, payer: payer.publicKey, systemProgram: SystemProgram.programId }).instruction();
    const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const m = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [cu, ix] }).compileToV0Message();
    const v = new anchor.web3.VersionedTransaction(m); v.sign([payer, kp]);
    await connection.confirmTransaction(await connection.sendTransaction(v, {}), "confirmed");
  }

  const initialDigests = await Promise.all(outputs.map(async k => (await connection.getAccountInfo(k.publicKey))!.data.subarray(2, 34).toString("hex")));

  const settleIx = await (program.methods as any).settleBisect3In4Out(cpiAuthorityBump)
    .accounts({
      inA: ctPubkeys[0], inB: ctPubkeys[1], inC: ctPubkeys[2],
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
  console.log(`✓ submit: ${sig}`);

  // Wait for processing
  let processedAt: number | null = null;
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const digests = await Promise.all(outputs.map(async k => (await connection.getAccountInfo(k.publicKey))!.data.subarray(2, 34).toString("hex")));
    if (digests.every((d, idx) => d !== initialDigests[idx])) { processedAt = Date.now() - t0; break; }
  }
  if (processedAt === null) { console.log(`✗ not processed`); return; }
  console.log(`✓ processed in +${processedAt}ms\n`);

  // make public + read
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, { keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true });
  const proto: any = grpc.loadPackageDefinition(packageDef);
  const client = new proto.encrypt.v1.EncryptService(ENCRYPT_GRPC_URL, grpc.credentials.createSsl());

  const labels = ["sum_ab (a+b=30)", "sum_bc (b+c=50)", "prod_ac (a*c=300)", "diff_ab (a>=b=0)"];
  const expected = [30n, 50n, 300n, 0n];
  for (let i = 0; i < 4; i++) {
    const mp = await (program.methods as any).makeOutputPublic(cpiAuthorityBump)
      .accounts({ ciphertext: outputs[i].publicKey, cpiAuthority, callerProgram: PROGRAM_ID, encryptProgram: ENCRYPT_PROGRAM }).instruction();
    const cuMp = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const { blockhash: bh } = await connection.getLatestBlockhash("confirmed");
    const mMp = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh, instructions: [cuMp, mp] }).compileToV0Message();
    const vMp = new anchor.web3.VersionedTransaction(mMp); vMp.sign([payer]);
    await connection.confirmTransaction(await connection.sendTransaction(vMp, {}), "confirmed");
    const v = await readPlaintext(client, outputs[i].publicKey, payer);
    const ok = v === expected[i] ? "✓" : "✗";
    console.log(`  ${labels[i].padEnd(20)} = ${v.toString()}  ${ok}`);
  }
  client.close();
}
main().catch(err => { console.error(err); process.exit(1); });
