/**
 * Scan ALL of BuTf7gVr's successful execute_graph submissions to see
 * the maximum graph size their executor has processed. Gives us a real
 * upper bound on the executor's processing envelope.
 */

import { Connection, PublicKey } from "@solana/web3.js";
// @ts-ignore
import bs58 from "bs58";
import { RPC_FAST_URL } from "../src/rpcConfig";

const ENCRYPT = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const OTHER = new PublicKey("BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj");
async function main() {
  const conn = new Connection(RPC_FAST_URL);
  let before: string | undefined;
  const allRuns: any[] = [];
  let scanned = 0;

  console.log("Scanning ALL recent Encrypt program txs for BuTf7gVr execute_graph submissions…");

  // Page through more aggressively
  for (let page = 0; page < 10; page++) {
    const sigs: any = await conn.getSignaturesForAddress(ENCRYPT, { limit: 1000, before });
    if (sigs.length === 0) break;
    scanned += sigs.length;
    before = sigs[sigs.length - 1].signature;
    process.stdout.write(`\r  page ${page + 1}: ${scanned} txs scanned, ${allRuns.length} graphs collected so far`);

    for (const s of sigs) {
      const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err) continue;
      const keys = tx.transaction.message.staticAccountKeys;
      const eIdx = keys.findIndex(k => k.equals(ENCRYPT));
      if (eIdx === -1) continue;
      for (const inner of (tx.meta?.innerInstructions ?? [])) {
        for (const ii of inner.instructions) {
          if (ii.programIdIndex !== eIdx) continue;
          const d = typeof ii.data === "string" ? bs58.decode(ii.data) : Buffer.from(ii.data);
          if (d[0] !== 4) continue;
          const callerIdx = ii.accounts[2];
          if (!keys[callerIdx].equals(OTHER)) continue;
          // Parse graph header
          const numIn = d[4];
          const numPlain = d[5];
          const numConst = d[6];
          const numOps = d[7];
          const numOut = d[8];
          // Check if processed: look at last output ct's digest
          const numCt = ii.accounts.length - 8;
          // Outputs are at the end; check the last numOut accounts
          const outputCtPubkeys = ii.accounts.slice(-numOut).map((idx: number) => keys[idx]);
          let processedCount = 0;
          for (const pk of outputCtPubkeys) {
            const info = await conn.getAccountInfo(pk);
            if (!info) continue;
            const dig = info.data.subarray(2, 34).toString("hex");
            if (dig !== ZERO_DIGEST && dig !== "0".repeat(64)) processedCount++;
          }
          allRuns.push({
            sig: s.signature.slice(0, 12),
            blockTime: new Date(s.blockTime! * 1000).toISOString(),
            ixLen: d.length,
            accounts: ii.accounts.length,
            numIn, numPlain, numConst, numOps, numOut,
            numCt,
            processedCount,
            processed: processedCount === numOut,
          });
        }
      }
    }
  }

  console.log(`\n\nFound ${allRuns.length} BuTf7gVr execute_graph events:`);
  console.log("");
  console.log("ix_len  accts  in/plain/const/ops/out  processed?  sig");
  console.log("------  -----  ---------------------- -----------  ------------");
  // Sort by size (accounts ascending)
  allRuns.sort((a, b) => a.accounts - b.accounts || a.ixLen - b.ixLen);
  for (const r of allRuns) {
    console.log(
      `${r.ixLen.toString().padStart(5)}B  ${r.accounts.toString().padStart(2)}     ` +
      `${r.numIn}/${r.numPlain}/${r.numConst}/${r.numOps}/${r.numOut}`.padEnd(22) +
      ` ${r.processed ? "✓" : "✗"} (${r.processedCount}/${r.numOut})  ${r.sig}…`
    );
  }

  const processed = allRuns.filter(r => r.processed);
  if (processed.length > 0) {
    const maxIxLen = Math.max(...processed.map(r => r.ixLen));
    const maxAccts = Math.max(...processed.map(r => r.accounts));
    const maxOps = Math.max(...processed.map(r => r.numOps));
    const maxIn = Math.max(...processed.map(r => r.numIn));
    const maxOut = Math.max(...processed.map(r => r.numOut));
    console.log(`\nMaximum sizes seen processed by executor:`);
    console.log(`  ix_len:    ${maxIxLen} bytes`);
    console.log(`  accounts:  ${maxAccts}`);
    console.log(`  num_ops:   ${maxOps}`);
    console.log(`  num_in:    ${maxIn}`);
    console.log(`  num_out:   ${maxOut}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
