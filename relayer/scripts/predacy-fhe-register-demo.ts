/**
 * Live-devnet demonstration of `predacy-fhe`'s register_batch instruction.
 *
 * Proves the Encrypt-integrated Anchor program (deployed at
 * `59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn`) is live and invocable.
 *
 * This calls the non-CPI path (register_batch) to confirm:
 *   - Deployment is healthy
 *   - Anchor instruction encoding works with our IDL
 *   - BatchSettlementRecord PDA is created
 *   - Program logic is reachable
 *
 * The full CPI path (settle_fhe_batch, which calls Encrypt's coprocessor)
 * requires setting up Encrypt's TS client SDK + registering encrypted
 * inputs via their gRPC network — see predacy-fhe-e2e.ts for that.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = "59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn";
const RPC_URL = `https://sol-devnet-rpc.rpcfast.com/?api_key=${process.env.RPC_FAST_API_KEY || "Mera4YdtfZgVWW3Nzkizi0LzY6wQb8PJrnUrjSvlNi3zbpdxm8tO7E6PAYSrggUH"}`;

async function main() {
  console.log("\n╔════ predacy-fhe register_batch live demo ════╗\n");

  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))),
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "predacy-fhe-idl.json"), "utf-8"));
  const program = new anchor.Program(idl, provider);

  console.log(`Program:   ${PROGRAM_ID}`);
  console.log(`Payer:     ${payer.publicKey.toBase58()}`);
  const bal = await connection.getBalance(payer.publicKey);
  console.log(`Balance:   ${(bal / 1e9).toFixed(4)} SOL\n`);

  // Fake market ID + batch index for the record's seeds.
  const marketId = Buffer.alloc(32);
  Buffer.from("predacy-fhe-demo-v1").copy(marketId);
  const batchIndex = BigInt(Date.now());
  const programId = new PublicKey(PROGRAM_ID);

  // Placeholder ciphertext account pubkeys — register_batch just stores the
  // 32-byte IDs into the record; actual ciphertexts would be created via
  // Encrypt's register-input flow in the full settle_fhe_batch demo.
  const yesBuyVolCt = Keypair.generate().publicKey;
  const noBuyVolCt = Keypair.generate().publicKey;
  const yesSellQtyCt = Keypair.generate().publicKey;
  const noSellQtyCt = Keypair.generate().publicKey;

  const [recordPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("fhe_batch"),
      marketId,
      Buffer.from(new anchor.BN(batchIndex.toString()).toArray("le", 8)),
    ],
    programId,
  );

  console.log(`Record PDA: ${recordPda.toBase58()}`);
  console.log(`Market ID:  predacy-fhe-demo-v1 (batch #${batchIndex.toString()})\n`);

  console.log("Submitting register_batch…");
  const tx = await (program.methods as any)
    .registerBatch(
      Array.from(marketId),
      new anchor.BN(batchIndex.toString()),
      Array.from(yesBuyVolCt.toBytes()),
      Array.from(noBuyVolCt.toBytes()),
      Array.from(yesSellQtyCt.toBytes()),
      Array.from(noSellQtyCt.toBytes()),
    )
    .accounts({
      record: recordPda,
      authority: payer.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });

  console.log(`\n✓ tx landed: ${tx}`);
  console.log(`\nFetching on-chain record…`);

  await new Promise((r) => setTimeout(r, 2000));
  const rec: any = await (program.account as any).batchSettlementRecord.fetch(recordPda);
  console.log(`  authority:        ${new PublicKey(rec.authority).toBase58()}`);
  console.log(`  marketId:         predacy-fhe-demo-v1`);
  console.log(`  batchIndex:       ${rec.batchIndex.toString()}`);
  console.log(`  yesBuyVolCt:      ${new PublicKey(rec.yesBuyVolCt).toBase58()}`);
  console.log(`  noBuyVolCt:       ${new PublicKey(rec.noBuyVolCt).toBase58()}`);
  console.log(`  yesSellQtyCt:     ${new PublicKey(rec.yesSellQtyCt).toBase58()}`);
  console.log(`  noSellQtyCt:      ${new PublicKey(rec.noSellQtyCt).toBase58()}`);

  console.log(`\n╔════ ✓ predacy-fhe is LIVE on devnet ════╗`);
  console.log(`║  Explorer: https://solscan.io/tx/${tx}?cluster=devnet  ║`);
}

main().catch((err) => {
  console.error("\n❌ FAILED:", err);
  process.exit(1);
});
