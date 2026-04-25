/**
 * For each recent COMMIT_CIPHERTEXT (opcode 3) tx, find the output
 * ciphertext it committed to, then look back through the ct's history
 * to find the original execute_graph that triggered it. Compare the
 * caller_program of those graphs vs ours (predacy-fhe).
 */

import { Connection, PublicKey } from "@solana/web3.js";
// @ts-ignore
import bs58 from "bs58";
import { RPC_FAST_URL } from "../src/rpcConfig";

const ENCRYPT = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const VAULT = new PublicKey("6DQ7zeNXRG3AtwNNPTrg9p44SfeB74hS49xcTZ9xRmhb");
  const sigs = await conn.getSignaturesForAddress(VAULT, { limit: 30 });

  console.log(`Scanning ${sigs.length} recent vault txs for COMMIT_CIPHERTEXT…\n`);

  const callers = new Set<string>();
  let scanned = 0;
  for (const s of sigs) {
    if (scanned >= 5) break;
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) continue;
    const keys = tx.transaction.message.staticAccountKeys;
    const encryptIdx = keys.findIndex(k => k.equals(ENCRYPT));
    if (encryptIdx === -1) continue;

    let outputCt: PublicKey | null = null;
    for (const ix of tx.transaction.message.compiledInstructions) {
      if (ix.programIdIndex !== encryptIdx) continue;
      const data = Buffer.from(ix.data);
      if (data[0] === 3) {
        outputCt = keys[ix.accountKeyIndexes[1]];
        break;
      }
    }
    if (!outputCt) continue;
    scanned++;

    console.log(`commit ${s.signature.slice(0, 12)}… → ct ${outputCt.toBase58().slice(0, 16)}…`);
    // Find the execute_graph that wrote this ct
    const ctSigs = await conn.getSignaturesForAddress(outputCt, { limit: 20 });
    for (const cs of ctSigs) {
      const ctTx = await conn.getTransaction(cs.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!ctTx || ctTx.meta?.err) continue;
      const ctKeys = ctTx.transaction.message.staticAccountKeys;
      const eIdx = ctKeys.findIndex(k => k.equals(ENCRYPT));
      if (eIdx === -1) continue;
      for (const inner of (ctTx.meta?.innerInstructions ?? [])) {
        for (const ii of inner.instructions) {
          if (ii.programIdIndex !== eIdx) continue;
          const d = typeof ii.data === "string" ? bs58.decode(ii.data) : Buffer.from(ii.data);
          if (d[0] !== 4) continue;
          // execute_graph found. caller_program is account[2] of the ix
          const callerIdx = ii.accounts[2];
          const caller = ctKeys[callerIdx];
          callers.add(caller.toBase58());
          console.log(`  → triggered by execute_graph in ${cs.signature.slice(0, 12)}… (caller=${caller.toBase58().slice(0, 16)}…)`);
        }
      }
    }
  }

  console.log(`\nUnique caller_programs that the executor processed:`);
  for (const c of callers) console.log(`  ${c}`);
}

main().catch(err => { console.error(err); process.exit(1); });
