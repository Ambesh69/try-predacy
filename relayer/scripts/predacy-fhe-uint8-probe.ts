/**
 * Probe: 3 in / 1 out where input[0] is EUint8. Tests if production's
 * Uint8 side type or `==` operator is the executor's blocker.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn");
const ENCRYPT_PROGRAM = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const RPC_URL = `https://sol-devnet-rpc.rpcfast.com/?api_key=${process.env.RPC_FAST_API_KEY || "Mera4YdtfZgVWW3Nzkizi0LzY6wQb8PJrnUrjSvlNi3zbpdxm8tO7E6PAYSrggUH"}`;
const ENCRYPT_GRPC_URL = "pre-alpha-dev-1.encrypt.ika-network.net:443";
const NETWORK_KEY = Buffer.alloc(32, 0x55);

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function mockCt(fheType: number, value: bigint): Buffer {
  if (fheType === 1) {
    const b = Buffer.alloc(2);
    b[0] = 1;
    b[1] = Number(value & 0xffn);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 4;
  b.writeBigUInt64LE(value, 1);
  return b;
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

  console.log("\n══ Uint8/== probe ══\n");

  // Inputs: side=EUint8(0), limit=EUint64(600_000), clearing=EUint64(550_000)
  // Expected: is_buy=1, fill=1, output = 1*1*600_000 = 600_000
  const ctPubkeys = await callCreateInput(
    [
      { fheType: 1, value: 0n },        // side = YES_BUY
      { fheType: 4, value: 600_000n },  // limit
      { fheType: 4, value: 550_000n },  // clearing
    ],
    PROGRAM_ID,
  );
  console.log(`✓ inputs: side=${ctPubkeys[0].toBase58().slice(0,12)} limit=${ctPubkeys[1].toBase58().slice(0,12)} clearing=${ctPubkeys[2].toBase58().slice(0,12)}`);

  // Output ct via on-chain create_plaintext
  const outKp = Keypair.generate();
  const createIx = await (program.methods as any).createOutputCt(cpiAuthorityBump, 4)
    .accounts({
      ciphertext: outKp.publicKey, config: encryptConfig, deposit: depositPda,
      cpiAuthority, callerProgram: PROGRAM_ID, networkEncryptionKey: networkKeyPda,
      eventAuthority, encryptProgram: ENCRYPT_PROGRAM, payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    }).instruction();
  const cu0 = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash: bh0 } = await connection.getLatestBlockhash("confirmed");
  const m0 = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh0, instructions: [cu0, createIx] }).compileToV0Message();
  const v0 = new anchor.web3.VersionedTransaction(m0); v0.sign([payer, outKp]);
  await connection.confirmTransaction(await connection.sendTransaction(v0, {}), "confirmed");
  console.log(`✓ output: ${outKp.publicKey.toBase58().slice(0,12)}`);

  const initialDigest = (await connection.getAccountInfo(outKp.publicKey))!.data.subarray(2, 34).toString("hex");

  // Submit
  const settleIx = await (program.methods as any).settleBisectUint8Eq(cpiAuthorityBump)
    .accounts({
      inA: ctPubkeys[0], inB: ctPubkeys[1], inC: ctPubkeys[2],
      out1: outKp.publicKey,
      encryptProgram: ENCRYPT_PROGRAM, config: encryptConfig, deposit: depositPda,
      cpiAuthority, callerProgram: PROGRAM_ID, networkEncryptionKey: networkKeyPda,
      eventAuthority, payer: payer.publicKey, systemProgram: SystemProgram.programId,
    }).instruction();
  const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const m = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [cu, settleIx] }).compileToV0Message();
  const v = new anchor.web3.VersionedTransaction(m); v.sign([payer]);
  const sig = await connection.sendTransaction(v, {});
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`✓ submit: ${sig}`);

  // Poll
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const info = await connection.getAccountInfo(outKp.publicKey);
    const dig = info!.data.subarray(2, 34).toString("hex");
    if (dig !== initialDigest) {
      console.log(`✓ EXECUTOR PROCESSED Uint8/== in +${Date.now() - t0}ms  digest=${dig.slice(0, 16)}`);
      return;
    }
  }
  console.log(`✗ NOT processed after 120s — Uint8 type or == operator IS the blocker`);
}
main().catch(err => { console.error(err); process.exit(1); });
