/**
 * Discriminator: invoke `verify_test_vectors` on devnet.
 *
 *   - tx succeeds → on-chain syscall accepts groth16-solana's canonical
 *     test bytes → our production proofs have an encoding issue we missed
 *   - tx fails w/ ProofVerificationFailed → the syscall rejects even the
 *     crate's own test vectors → devnet issue, not our integration
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = `https://sol-devnet-rpc.rpcfast.com/?api_key=${process.env.RPC_FAST_API_KEY || "Mera4YdtfZgVWW3Nzkizi0LzY6wQb8PJrnUrjSvlNi3zbpdxm8tO7E6PAYSrggUH"}`;

async function main() {
  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))),
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "predacy-idl.json"), "utf-8"));
  const program = new anchor.Program(idl, provider);

  console.log("Invoking verify_test_vectors on devnet...\n");
  try {
    const tx = await (program.methods as any)
      .verifyTestVectors()
      .accounts({})
      .preInstructions([
        anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc();
    console.log(`✓ tx landed: ${tx}`);
    console.log("→ On-chain verifier ACCEPTED groth16-solana's canonical test vectors.");
    console.log("→ Our production proofs therefore have an encoding bug we haven't caught locally.");
    console.log("→ Checking logs for confirmation…");
    await new Promise(r => setTimeout(r, 2000));
    const txInfo = await connection.getTransaction(tx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (txInfo?.meta?.logMessages) {
      for (const l of txInfo.meta.logMessages) {
        if (l.includes("Program log:") || l.includes("Program return:")) {
          console.log("  ", l);
        }
      }
    }
  } catch (err: any) {
    console.log(`✗ tx reverted`);
    const logs = err?.logs ?? err?.transactionLogs ?? [];
    for (const l of logs) {
      if (l.includes("Program log:") || l.includes("Error")) {
        console.log("  ", l);
      }
    }
    const code = err?.error?.errorCode?.code;
    const num = err?.error?.errorCode?.number;
    if (code) console.log(`  → AnchorError: ${code} (${num})`);
    if (code === "ProofVerificationFailed") {
      console.log("\n→ On-chain verifier REJECTED groth16-solana's OWN test vectors.");
      console.log("→ This is a devnet syscall / version-skew issue, not our integration.");
    } else {
      console.log("\n→ Failure mode is not ProofVerificationFailed — some other issue.");
      console.log("   Full error:", err?.message ?? err);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
