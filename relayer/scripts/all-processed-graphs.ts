/**
 * Find ALL successfully-processed execute_graph events on devnet across
 * any caller_program. Determines the maximum graph size the executor
 * has ever successfully processed.
 */

import { Connection, PublicKey } from "@solana/web3.js";
// @ts-ignore
import bs58 from "bs58";

const ENCRYPT = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const RPC = `https://sol-devnet-rpc.rpcfast.com/?api_key=${process.env.RPC_FAST_API_KEY || "Mera4YdtfZgVWW3Nzkizi0LzY6wQb8PJrnUrjSvlNi3zbpdxm8tO7E6PAYSrggUH"}`;
const ZERO_DIGEST = "628bf3596747d233f1e6533345700066bf458fa48daedaf04a7be6c392902476";

async function main() {
  const conn = new Connection(RPC);
  let before: string | undefined;
  const allRuns: any[] = [];
  let scanned = 0;

  console.log("Scanning recent Encrypt program txs for ALL execute_graph submissions…\n");

  for (let page = 0; page < 5; page++) {
    const sigs: any = await conn.getSignaturesForAddress(ENCRYPT, { limit: 1000, before });
    if (sigs.length === 0) break;
    scanned += sigs.length;
    before = sigs[sigs.length - 1].signature;

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
          const numIn = d[4];
          const numPlain = d[5];
          const numConst = d[6];
          const numOps = d[7];
          const numOut = d[8];

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
            caller: keys[callerIdx].toBase58(),
            ixLen: d.length,
            accounts: ii.accounts.length,
            numIn, numPlain, numConst, numOps, numOut,
            processedCount,
            processed: processedCount === numOut,
          });
        }
      }
    }
    process.stdout.write(`\r  page ${page + 1}: ${scanned} txs scanned, ${allRuns.length} graphs collected`);
  }

  console.log(`\n\nFound ${allRuns.length} execute_graph events total\n`);

  // Group by caller program
  const byCaller: Record<string, any[]> = {};
  for (const r of allRuns) {
    byCaller[r.caller] = byCaller[r.caller] || [];
    byCaller[r.caller].push(r);
  }

  console.log("Per-caller summary:");
  for (const [caller, runs] of Object.entries(byCaller)) {
    const processed = runs.filter(r => r.processed);
    const failed = runs.filter(r => !r.processed);
    console.log(`\n${caller}: ${runs.length} total (${processed.length} ✓, ${failed.length} ✗)`);

    // Unique shapes
    const shapes = new Map<string, { count: number; processed: number }>();
    for (const r of runs) {
      const key = `${r.numIn}in/${r.numOut}out/${r.numOps}ops/${r.accounts}acct`;
      const v = shapes.get(key) || { count: 0, processed: 0 };
      v.count++;
      if (r.processed) v.processed++;
      shapes.set(key, v);
    }
    for (const [shape, { count, processed }] of shapes) {
      console.log(`  ${shape}: ${count} runs (${processed} ✓ / ${count - processed} ✗)`);
    }
  }

  const everProcessed = allRuns.filter(r => r.processed);
  if (everProcessed.length > 0) {
    const maxIxLen = Math.max(...everProcessed.map(r => r.ixLen));
    const maxAccts = Math.max(...everProcessed.map(r => r.accounts));
    const maxOps = Math.max(...everProcessed.map(r => r.numOps));
    const maxIn = Math.max(...everProcessed.map(r => r.numIn));
    const maxOut = Math.max(...everProcessed.map(r => r.numOut));
    console.log(`\n══ Maximum sizes EVER processed across all callers: ══`);
    console.log(`   ix_len:    ${maxIxLen} bytes`);
    console.log(`   accounts:  ${maxAccts}`);
    console.log(`   num_ops:   ${maxOps}`);
    console.log(`   num_in:    ${maxIn}`);
    console.log(`   num_out:   ${maxOut}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
