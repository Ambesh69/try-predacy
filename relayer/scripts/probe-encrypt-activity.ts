/**
 * Probe Encrypt's coprocessor program for recent activity.
 * Looks for COMMIT_CIPHERTEXT (opcode 3) calls — those are the executor
 * writing back computed graph results. If we see opcode 3 calls, the
 * executor is alive. If only opcodes 1/2/4/14 (user submits), the
 * executor isn't processing.
 */

import { Connection, PublicKey } from "@solana/web3.js";
// @ts-ignore
import bs58 from "bs58";
import { RPC_FAST_URL } from "../src/rpcConfig";

const ENCRYPT = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
async function main() {
  const conn = new Connection(RPC_FAST_URL);
  console.log(`Probing ${ENCRYPT.toBase58()}…\n`);

  const sigs = await conn.getSignaturesForAddress(ENCRYPT, { limit: 100 });
  console.log(`Recent ${sigs.length} txs to Encrypt program`);
  console.log(`  newest: ${new Date(sigs[0].blockTime! * 1000).toISOString()} (${sigs[0].signature.slice(0, 12)}…)`);
  console.log(`  oldest: ${new Date(sigs[sigs.length - 1].blockTime! * 1000).toISOString()}\n`);

  const opcodeCounts: Record<number, number> = {};
  const opcodeRecentSigs: Record<number, string> = {};

  for (let i = 0; i < Math.min(50, sigs.length); i++) {
    const tx = await conn.getTransaction(sigs[i].signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const keys = tx.transaction.message.staticAccountKeys;
    const encryptIdx = keys.findIndex(k => k.equals(ENCRYPT));
    if (encryptIdx === -1) continue;

    const allIx: { data: any }[] = [];
    for (const ix of tx.transaction.message.compiledInstructions) {
      if (ix.programIdIndex === encryptIdx) allIx.push({ data: ix.data });
    }
    for (const inner of (tx.meta?.innerInstructions ?? [])) {
      for (const ii of inner.instructions) {
        if (ii.programIdIndex === encryptIdx) allIx.push({ data: ii.data });
      }
    }
    for (const ix of allIx) {
      const data = typeof ix.data === "string" ? bs58.decode(ix.data) : Buffer.from(ix.data);
      const op = data[0];
      opcodeCounts[op] = (opcodeCounts[op] || 0) + 1;
      if (!opcodeRecentSigs[op]) {
        opcodeRecentSigs[op] = sigs[i].signature;
      }
    }
  }

  console.log("Opcode counts in last 50 txs (with most-recent sig sample):");
  const sorted = Object.entries(opcodeCounts).sort((a, b) => b[1] - a[1]);
  for (const [op, count] of sorted) {
    const name = opNames[+op] ?? "?";
    const sig = opcodeRecentSigs[+op];
    console.log(`  op=${op.padStart(3)} ${name.padEnd(20)} ${count.toString().padStart(3)}  most-recent: ${sig.slice(0, 16)}…`);
  }

  console.log("\nVerdict:");
  if (opcodeCounts[3]) {
    console.log(`  ✓ Executor IS active — saw ${opcodeCounts[3]} COMMIT_CIPHERTEXT calls (opcode 3)`);
    console.log(`    Most recent commit: ${opcodeRecentSigs[3]}`);
  } else {
    console.log(`  ✗ NO COMMIT_CIPHERTEXT (opcode 3) calls in recent txs`);
    console.log(`    The executor is NOT writing back results.`);
  }
  if (opcodeCounts[12]) {
    console.log(`  ✓ Decryptor IS active — saw ${opcodeCounts[12]} RESPOND_DECRYPTION calls (opcode 12)`);
  } else {
    console.log(`  ✗ NO RESPOND_DECRYPTION (opcode 12) calls — decryptor also offline`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
