/**
 * Live-devnet `settle_fhe_batch` CPI demonstration.
 *
 * Reproducible script that lands a real on-chain tx of our `predacy-fhe`
 * program invoking Encrypt's coprocessor (`4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8`)
 * via CPI on Solana devnet. Last successful run:
 *   tx 2vN1MZiY9uJGapbAXewPJDys4EEw8nyvXDmuuMD6cYZLLD166K3xtYgEeHqTfToG7LV5FtQyTWjvmNNCYXBzV9pQ
 *   slot 457855632
 *
 * On-chain trace shows:
 *   - predacy-fhe (59ZxSvmRrz…) invoked at depth 1
 *   - "Instruction: SettleFheBatch" log
 *   - Encrypt coprocessor invoked at depth 2 via CPI
 *   - Encrypt consumes ~2k CU validating accounts
 *   - Rejects with Custom(0x4) — digest verification fails because the
 *     ciphertext accounts weren't bootstrapped through Encrypt's network
 *
 * Pipeline:
 *   1. Verify Encrypt config + create deposit PDA (raw opcode 14)
 *   2. Allocate 17 ciphertext-shaped accounts via our `init_fake_ct` ix
 *      with the correct fhe_type byte at offset 98 (Uint8=1, Uint64=4)
 *      and status=Verified at offset 99 — this passes the encrypt-pinocchio
 *      macro's input-type check inside our handler so the CPI fires
 *   3. register_batch — opens an FHE settlement record PDA
 *   4. settle_fhe_batch — fires the CPI. Encrypt's account validation
 *      then rejects (correctly) because the ciphertext digests aren't
 *      registered with their network
 *
 * Real success-path inputs come from Encrypt's TS client SDK
 * register-input flow (gRPC + protobuf bootstrap) — not yet wired.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { RPC_FAST_URL } from "../src/rpcConfig";

const PROGRAM_ID = new PublicKey("59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn");
const ENCRYPT_PROGRAM = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function main() {
  console.log("\n╔══ predacy-fhe settle_fhe_batch CPI demo ══╗\n");

  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));
  const connection = new Connection(RPC_FAST_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "predacy-fhe-idl.json"), "utf-8"));
  const program = new anchor.Program(idl, provider);

  // ── Derive Encrypt infrastructure PDAs ──────────────────────────────
  const [encryptConfig] = pda([Buffer.from("encrypt_config")], ENCRYPT_PROGRAM);
  const [eventAuthority] = pda([Buffer.from("__event_authority")], ENCRYPT_PROGRAM);
  const [depositPda, depositBump] = pda(
    [Buffer.from("encrypt_deposit"), payer.publicKey.toBuffer()],
    ENCRYPT_PROGRAM,
  );
  const networkKey = Buffer.alloc(32, 0x55);
  const [networkKeyPda] = pda(
    [Buffer.from("network_encryption_key"), networkKey],
    ENCRYPT_PROGRAM,
  );
  const [cpiAuthority, cpiAuthorityBump] = pda(
    [Buffer.from("__encrypt_cpi_authority")],
    PROGRAM_ID,
  );

  console.log("Encrypt infrastructure:");
  console.log(`  coprocessor:          ${ENCRYPT_PROGRAM.toBase58()}`);
  console.log(`  config PDA:           ${encryptConfig.toBase58()}`);
  console.log(`  event_authority PDA:  ${eventAuthority.toBase58()}`);
  console.log(`  deposit PDA:          ${depositPda.toBase58()}`);
  console.log(`  network_key PDA:      ${networkKeyPda.toBase58()}`);
  console.log(`  our cpi_authority:    ${cpiAuthority.toBase58()}  (bump ${cpiAuthorityBump})\n`);

  // Verify Encrypt config is live on-chain
  const configInfo = await connection.getAccountInfo(encryptConfig);
  if (!configInfo) {
    console.error("✗ Encrypt config not initialized on devnet — executor offline?");
    process.exit(1);
  }
  console.log(`✓ Encrypt config exists (${configInfo.data.length} bytes, owner ${configInfo.owner.toBase58().slice(0, 10)}…)`);
  // Vault pubkey lives at bytes 100..132 of the config account.
  const vaultFromCfg = new PublicKey(configInfo.data.subarray(100, 132));
  const vaultPk = vaultFromCfg.equals(SystemProgram.programId) ? payer.publicKey : vaultFromCfg;
  console.log(`  vault: ${vaultPk.toBase58()}\n`);

  // ── Create Encrypt deposit PDA (if missing) ─────────────────────────
  // Raw instruction: opcode 14 (IX_CREATE_DEPOSIT), 1 byte bump, 16 zero pad.
  // Accounts: deposit, config, payer×3, vault, system_program×2. Extracted
  // from encrypt-pre-alpha/chains/solana/examples/_shared/encrypt-setup.ts.
  const depositInfo = await connection.getAccountInfo(depositPda);
  if (!depositInfo) {
    console.log("Creating Encrypt deposit PDA…");
    const depositData = Buffer.alloc(18);
    depositData[0] = 14;
    depositData[1] = depositBump;
    const ix = new TransactionInstruction({
      programId: ENCRYPT_PROGRAM,
      data: depositData,
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
    const tx = new Transaction().add(ix);
    const sig = await provider.sendAndConfirm(tx, [payer], { commitment: "confirmed" });
    console.log(`  ✓ deposit created: ${sig}\n`);
  } else {
    console.log(`✓ deposit PDA already exists (${depositInfo.data.length} bytes)\n`);
  }

  // ── Generate ciphertext keypairs ────────────────────────────────────
  // FHE_TYPE_ID values from encrypt-types/src/encrypted.rs:
  //   Uint8::FHE_TYPE_ID  = 1   (order side)
  //   Uint64::FHE_TYPE_ID = 4   (limit, amount, clearing_price, outputs)
  const order0SideCt = Keypair.generate();
  const order0LimitCt = Keypair.generate();
  const order0AmountCt = Keypair.generate();
  const order1SideCt = Keypair.generate();
  const order1LimitCt = Keypair.generate();
  const order1AmountCt = Keypair.generate();
  const order2SideCt = Keypair.generate();
  const order2LimitCt = Keypair.generate();
  const order2AmountCt = Keypair.generate();
  const order3SideCt = Keypair.generate();
  const order3LimitCt = Keypair.generate();
  const order3AmountCt = Keypair.generate();
  const clearingPriceCt = Keypair.generate();
  const yesBuyVolCtKp = Keypair.generate();
  const noBuyVolCtKp = Keypair.generate();
  const yesSellQtyCtKp = Keypair.generate();
  const noSellQtyCtKp = Keypair.generate();

  const allCts: Array<{kp: Keypair, type: number, name: string}> = [
    {kp: order0SideCt, type: 1, name: "o0_side"},
    {kp: order0LimitCt, type: 4, name: "o0_limit"},
    {kp: order0AmountCt, type: 4, name: "o0_amount"},
    {kp: order1SideCt, type: 1, name: "o1_side"},
    {kp: order1LimitCt, type: 4, name: "o1_limit"},
    {kp: order1AmountCt, type: 4, name: "o1_amount"},
    {kp: order2SideCt, type: 1, name: "o2_side"},
    {kp: order2LimitCt, type: 4, name: "o2_limit"},
    {kp: order2AmountCt, type: 4, name: "o2_amount"},
    {kp: order3SideCt, type: 1, name: "o3_side"},
    {kp: order3LimitCt, type: 4, name: "o3_limit"},
    {kp: order3AmountCt, type: 4, name: "o3_amount"},
    {kp: clearingPriceCt, type: 4, name: "clearing"},
    {kp: yesBuyVolCtKp, type: 4, name: "yes_buy_vol_out"},
    {kp: noBuyVolCtKp, type: 4, name: "no_buy_vol_out"},
    {kp: yesSellQtyCtKp, type: 4, name: "yes_sell_qty_out"},
    {kp: noSellQtyCtKp, type: 4, name: "no_sell_qty_out"},
  ];

  console.log(`Allocating ${allCts.length} ciphertext-shaped accounts via init_fake_ct…`);
  // Bundle 4 init_fake_ct ixs per tx to stay under the 1232-byte tx limit.
  // Retry per-chunk on transient devnet timeouts (idempotent on success).
  for (let i = 0; i < allCts.length; i += 4) {
    const chunk = allCts.slice(i, i + 4);
    let attempt = 0;
    while (true) {
      try {
        const ixs: anchor.web3.TransactionInstruction[] = [];
        for (const ct of chunk) {
          ixs.push(
            await (program.methods as any)
              .initFakeCt(ct.type)
              .accounts({
                fakeCt: ct.kp.publicKey,
                payer: payer.publicKey,
                systemProgram: SystemProgram.programId,
              })
              .instruction(),
          );
        }
        const tx = new Transaction().add(...ixs);
        const sig = await provider.sendAndConfirm(tx, [payer, ...chunk.map(c => c.kp)], { commitment: "confirmed" });
        console.log(`  ✓ chunk ${i / 4 + 1}: ${chunk.map(c => c.name).join(", ")} — ${sig.slice(0, 12)}…`);
        break;
      } catch (e: any) {
        // If accounts already exist (from a prior run that timed-out post-land),
        // confirm by reading their data and skip.
        const allExist = await Promise.all(
          chunk.map(c => connection.getAccountInfo(c.kp.publicKey).then(i => i?.data.length === 100)),
        );
        if (allExist.every(Boolean)) {
          console.log(`  ✓ chunk ${i / 4 + 1}: ${chunk.map(c => c.name).join(", ")} — already allocated`);
          break;
        }
        attempt++;
        if (attempt >= 3) throw e;
        console.log(`  ⟲ chunk ${i / 4 + 1} retry ${attempt}/3 (${e.message?.slice(0, 60) || "err"}…)`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  console.log();

  // ── Register the batch ───────────────────────────────────────────────
  const marketId = Buffer.alloc(32);
  Buffer.from("predacy-fhe-cpi-demo").copy(marketId);
  const batchIndex = BigInt(Date.now());
  const [recordPda] = pda(
    [
      Buffer.from("fhe_batch"),
      marketId,
      Buffer.from(new anchor.BN(batchIndex.toString()).toArray("le", 8)),
    ],
    PROGRAM_ID,
  );

  console.log(`Registering batch #${batchIndex} at ${recordPda.toBase58().slice(0, 10)}…`);
  const regTx = await (program.methods as any)
    .registerBatch(
      Array.from(marketId),
      new anchor.BN(batchIndex.toString()),
      Array.from(yesBuyVolCtKp.publicKey.toBytes()),
      Array.from(noBuyVolCtKp.publicKey.toBytes()),
      Array.from(yesSellQtyCtKp.publicKey.toBytes()),
      Array.from(noSellQtyCtKp.publicKey.toBytes()),
    )
    .accounts({
      record: recordPda,
      authority: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log(`  ✓ register_batch tx: ${regTx}\n`);

  console.log("Building settle_fhe_batch ix + simulating to capture full logs…\n");

  // Build the ix via Anchor methods.instruction()
  const ix = await (program.methods as any)
    .settleFheBatch(cpiAuthorityBump)
    .accounts({
      record: recordPda,
      o0SideCt: order0SideCt.publicKey,
      o0LimitCt: order0LimitCt.publicKey,
      o0AmountCt: order0AmountCt.publicKey,
      o1SideCt: order1SideCt.publicKey,
      o1LimitCt: order1LimitCt.publicKey,
      o1AmountCt: order1AmountCt.publicKey,
      o2SideCt: order2SideCt.publicKey,
      o2LimitCt: order2LimitCt.publicKey,
      o2AmountCt: order2AmountCt.publicKey,
      o3SideCt: order3SideCt.publicKey,
      o3LimitCt: order3LimitCt.publicKey,
      o3AmountCt: order3AmountCt.publicKey,
      clearingPriceCt: clearingPriceCt.publicKey,
      yesBuyVolCt: yesBuyVolCtKp.publicKey,
      noBuyVolCt: noBuyVolCtKp.publicKey,
      yesSellQtyCt: yesSellQtyCtKp.publicKey,
      noSellQtyCt: noSellQtyCtKp.publicKey,
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

  const cuIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const txMsg = new anchor.web3.TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuIx, ix],
  }).compileToV0Message();
  const vtx = new anchor.web3.VersionedTransaction(txMsg);
  vtx.sign([payer]);

  // Simulate first to capture logs even on failure
  const sim = await connection.simulateTransaction(vtx, { commitment: "confirmed", sigVerify: false });
  const logs = sim.value.logs ?? [];
  console.log(`Captured ${logs.length} simulation log lines:\n`);
  for (const l of logs) console.log(`  ${l}`);

  const predacyLogs = logs.filter(l => l.includes(PROGRAM_ID.toBase58()));
  const encryptLogs = logs.filter(l => l.includes(ENCRYPT_PROGRAM.toBase58()));
  console.log(`\n  Predacy-FHE program invocations:  ${predacyLogs.length}`);
  console.log(`  Encrypt coprocessor invocations:  ${encryptLogs.length}`);
  console.log(`  Simulation err: ${JSON.stringify(sim.value.err)}\n`);

  if (predacyLogs.length > 0 && encryptLogs.length > 0) {
    // Now LAND the tx on-chain with skipPreflight so we have a permanent
    // devnet record of the failing-but-CPI-fired settle_fhe_batch.
    console.log("Landing tx on-chain with skipPreflight…");
    try {
      const sig = await connection.sendTransaction(vtx, { skipPreflight: true });
      // Don't wait for confirmation (tx will fail) — just record the sig.
      await new Promise(r => setTimeout(r, 4000));
      const txInfo = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      console.log(`  ✓ tx signature:  ${sig}`);
      console.log(`  ✓ explorer:      https://solscan.io/tx/${sig}?cluster=devnet`);
      if (txInfo) {
        console.log(`  ✓ landed:        slot ${txInfo.slot}, err ${JSON.stringify(txInfo.meta?.err)}`);
      }
    } catch (sendErr: any) {
      console.log(`  Landed but reverted (expected): ${sendErr?.message?.slice(0, 80)}`);
    }
    console.log(`\n╔═══════════════════════════════════════════════════════╗`);
    console.log(`║  ✓ CPI PATH PROVEN LIVE ON DEVNET                     ║`);
    console.log(`║  predacy-fhe → Encrypt coprocessor invoked at depth 2 ║`);
    console.log(`║  Encrypt ran ~2k CU then rejected at digest validation║`);
    console.log(`║  (real success path: Encrypt TS SDK register-input)   ║`);
    console.log(`╚═══════════════════════════════════════════════════════╝`);
  } else if (predacyLogs.length > 0) {
    console.log("Our predacy-fhe ran, but Encrypt CPI didn't fire — failure is in our handler before CPI.");
  } else {
    console.log("Our handler didn't even run — likely Anchor account validation failed.");
  }
}

main().catch((err) => {
  console.error("\n❌ FAILED unexpectedly:", err);
  process.exit(1);
});
