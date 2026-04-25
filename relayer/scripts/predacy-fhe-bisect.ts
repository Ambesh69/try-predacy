/**
 * Controlled bisect of Encrypt's pre-alpha executor envelope.
 *
 * Submits 5 probe graphs of varied shapes from predacy-fhe and polls
 * each output ciphertext to see if the executor processes it.
 *
 *   probe              shape                 dimension tested
 *   ─────────────────  ────────────────────  ──────────────────────────
 *   3in_2out           3 in / 2 out / 2 ops  num_outputs > 1
 *   3in_4out           3 in / 4 out / 6 ops  num_outputs = 4
 *   5in_1out           5 in / 1 out / 4 ops  num_inputs > 3
 *   7in_1out           7 in / 1 out / 6 ops  num_inputs >> 3
 *   3in_1out_15ops     3 in / 1 out / 15 ops num_ops > 5
 *   poc_yes_buy_fill   3 in / 1 out / 2 ops  CONTROL (known to process)
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as fs from "fs";
import * as path from "path";
import { RPC_FAST_URL, ENCRYPT_GRPC_URL } from "../src/rpcConfig";

const PROGRAM_ID = new PublicKey("59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn");
const ENCRYPT_PROGRAM = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const NETWORK_KEY = Buffer.alloc(32, 0x55);
const FHE_TYPE_UINT64 = 4;

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function mockCiphertext(value: bigint): Buffer {
  const buf = Buffer.alloc(9);
  buf[0] = FHE_TYPE_UINT64;
  buf.writeBigUInt64LE(value, 1);
  return buf;
}

async function callCreateInput(values: bigint[], authorized: PublicKey): Promise<PublicKey[]> {
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, { keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true });
  const proto: any = grpc.loadPackageDefinition(packageDef);
  const client = new proto.encrypt.v1.EncryptService(ENCRYPT_GRPC_URL, grpc.credentials.createSsl());
  return await new Promise((resolve, reject) => {
    client.CreateInput({
      chain: 0,
      inputs: values.map(v => ({ ciphertext_bytes: mockCiphertext(v), fhe_type: FHE_TYPE_UINT64 })),
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

interface ProbeResult {
  name: string;
  numIn: number;
  numOut: number;
  expectedOps: string;
  txSig: string;
  outputDigests: string[];
  initialDigests: string[];
  processedAt: number | null; // ms after submit when first digest changed
}

async function runProbe(
  conn: Connection,
  provider: anchor.AnchorProvider,
  program: any,
  payer: Keypair,
  encryptConfig: PublicKey,
  depositPda: PublicKey,
  networkKeyPda: PublicKey,
  eventAuthority: PublicKey,
  cpiAuthority: PublicKey,
  cpiAuthorityBump: number,
  name: string,
  numIn: number,
  numOut: number,
  ixName: string,
  expectedOps: string,
  inputValues: bigint[],
): Promise<ProbeResult> {
  console.log(`\n── ${name} ── (${numIn}in / ${numOut}out / ${expectedOps} ops)`);

  // Create N input cts via gRPC
  const inputs = await callCreateInput(inputValues, PROGRAM_ID);
  console.log(`  ✓ inputs:  ${inputs.map(p => p.toBase58().slice(0, 12)).join(", ")}`);

  // Pre-create M outputs via on-chain create_plaintext CPI
  const outputs: Keypair[] = [];
  for (let i = 0; i < numOut; i++) outputs.push(Keypair.generate());

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
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const m = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [cu, ix] }).compileToV0Message();
    const v = new anchor.web3.VersionedTransaction(m); v.sign([payer, kp]);
    const sig = await conn.sendTransaction(v, { skipPreflight: false });
    await conn.confirmTransaction(sig, "confirmed");
  }
  console.log(`  ✓ outputs: ${outputs.map(o => o.publicKey.toBase58().slice(0, 12)).join(", ")}`);

  // Capture initial digests
  const initialDigests: string[] = [];
  for (const kp of outputs) {
    const info = await conn.getAccountInfo(kp.publicKey);
    initialDigests.push(info!.data.subarray(2, 34).toString("hex"));
  }

  // Build accounts dict — works for any of the bisect ix variants
  const accounts: any = {
    encryptProgram: ENCRYPT_PROGRAM,
    config: encryptConfig,
    deposit: depositPda,
    cpiAuthority,
    callerProgram: PROGRAM_ID,
    networkEncryptionKey: networkKeyPda,
    eventAuthority,
    payer: payer.publicKey,
    systemProgram: SystemProgram.programId,
  };
  const inLetters = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
  for (let i = 0; i < numIn; i++) accounts[`in${inLetters[i].toUpperCase()}`] = inputs[i];
  for (let i = 0; i < numOut; i++) accounts[`out${i + 1}`] = outputs[i].publicKey;

  // Need camelCase: in_a → inA, out_1 → out1
  const camelAccounts: any = {};
  for (const k of Object.keys(accounts)) {
    const c = k.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
    camelAccounts[c] = accounts[k];
  }

  // Submit settle ix
  const settleIx = await (program.methods as any)[ixName](cpiAuthorityBump)
    .accounts(camelAccounts)
    .instruction();
  const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const m = new anchor.web3.TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [cu, settleIx] }).compileToV0Message();
  const v = new anchor.web3.VersionedTransaction(m); v.sign([payer]);
  const txSig = await conn.sendTransaction(v, { skipPreflight: false });
  await conn.confirmTransaction(txSig, "confirmed");
  console.log(`  ✓ submit:  ${txSig}`);

  const submittedAt = Date.now();

  // Poll up to 60s for digest change
  let processedAt: number | null = null;
  const finalDigests: string[] = [...initialDigests];
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    let allChanged = true;
    for (let j = 0; j < outputs.length; j++) {
      const info = await conn.getAccountInfo(outputs[j].publicKey);
      finalDigests[j] = info!.data.subarray(2, 34).toString("hex");
      if (finalDigests[j] === initialDigests[j]) allChanged = false;
    }
    if (allChanged && processedAt === null) {
      processedAt = Date.now() - submittedAt;
      console.log(`  ✓ EXECUTOR PROCESSED — all ${outputs.length} digests changed at +${processedAt}ms`);
      break;
    }
  }
  if (processedAt === null) {
    console.log(`  ✗ executor SKIPPED — digests unchanged after 120s`);
  }

  return {
    name, numIn, numOut, expectedOps, txSig,
    outputDigests: finalDigests,
    initialDigests,
    processedAt,
  };
}

async function main() {
  console.log("\n╔══ predacy-fhe executor envelope bisect ══╗\n");

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

  const probes = [
    { name: "3in_1out_50ops    ", numIn: 3, numOut: 1, ix: "settleBisect3In1Out50Ops", ops: "~50", inputs: [10n, 20n, 30n] },
    { name: "3in_1out_100ops   ", numIn: 3, numOut: 1, ix: "settleBisect3In1Out100Ops", ops: "~100", inputs: [10n, 20n, 30n] },
  ];

  const results: ProbeResult[] = [];
  for (const p of probes) {
    try {
      const r = await runProbe(connection, provider, program, payer, encryptConfig, depositPda, networkKeyPda, eventAuthority, cpiAuthority, cpiAuthorityBump, p.name, p.numIn, p.numOut, p.ix, p.ops, p.inputs);
      results.push(r);
    } catch (err: any) {
      console.error(`  ✗ probe failed: ${err.message?.slice(0, 100)}`);
    }
  }

  console.log(`\n\n╔══ RESULTS ══╗\n`);
  console.log("probe                shape       processed?  latency");
  console.log("-------------------- ----------- ----------  -------");
  for (const r of results) {
    console.log(
      `${r.name} ${r.numIn}in/${r.numOut}out/${r.expectedOps}    ${r.processedAt !== null ? "✓" : "✗"}          ${r.processedAt !== null ? r.processedAt + "ms" : "skip"}`
    );
  }
  console.log("\nDimension verdict:");
  const r3in2out = results.find(r => r.name.includes("3in_2out"));
  const r3in4out = results.find(r => r.name.includes("3in_4out"));
  const r5in1out = results.find(r => r.name.includes("5in_1out"));
  const r7in1out = results.find(r => r.name.includes("7in_1out"));
  const r15ops = results.find(r => r.name.includes("15ops"));
  const ok = (r: ProbeResult | undefined) => r ? (r.processedAt !== null ? "✓" : "✗") : "?";
  console.log(`  num_outputs > 1:   ${ok(r3in2out)} (3in/2out)`);
  console.log(`  num_outputs = 4:   ${ok(r3in4out)} (3in/4out)`);
  console.log(`  num_inputs = 5:    ${ok(r5in1out)} (5in/1out)`);
  console.log(`  num_inputs = 7:    ${ok(r7in1out)} (7in/1out)`);
  console.log(`  num_ops = 15:      ${ok(r15ops)} (3in/1out/15ops)`);
}

main().catch(err => { console.error("\n❌", err); process.exit(1); });
