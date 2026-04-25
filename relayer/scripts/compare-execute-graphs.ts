/**
 * Compare a SUCCESSFUL execute_graph (opcode 4) from someone else's
 * tx vs OUR settle_fhe_batch tx, to spot what's different in the
 * structure that the executor uses to decide whether to process.
 */

import { Connection, PublicKey } from "@solana/web3.js";
// @ts-ignore
import bs58 from "bs58";
import { RPC_FAST_URL } from "../src/rpcConfig";

const ENCRYPT = new PublicKey("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");
const PREDACY_FHE = new PublicKey("59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn");
  if (!tx) { console.log(`${label}: tx not found`); return; }
  const keys = tx.transaction.message.staticAccountKeys;
  const encryptIdx = keys.findIndex(k => k.equals(ENCRYPT));

  console.log(`\n=== ${label} (${sig.slice(0, 16)}…) ===`);
  console.log(`fee payer: ${keys[0].toBase58()}`);
  console.log(`tx err: ${JSON.stringify(tx.meta?.err)}`);

  for (const inner of (tx.meta?.innerInstructions ?? [])) {
    for (const ii of inner.instructions) {
      if (ii.programIdIndex !== encryptIdx) continue;
      const data = typeof ii.data === "string" ? bs58.decode(ii.data) : Buffer.from(ii.data);
      if (data[0] !== 4) continue; // only execute_graph
      console.log(`\n  execute_graph (${data.length} bytes):`);
      console.log(`    accounts (${ii.accounts.length}):`);
      const accountNames = ["config", "deposit", "caller_program", "cpi_authority", "network_key", "payer", "event_authority", "encrypt_program"];
      for (let i = 0; i < ii.accounts.length; i++) {
        const name = i < 8 ? accountNames[i] : `ct[${i - 8}]`;
        console.log(`      [${i.toString().padStart(2)}] ${name.padEnd(16)} ${keys[ii.accounts[i]].toBase58()}`);
      }
      // ix_data structure varies — first byte=4, then graph-specific
      console.log(`    ix data (full hex): ${Buffer.from(data).toString("hex")}`);
    }
  }
}

async function main() {
  const conn = new Connection(RPC_FAST_URL);
  const OUR_PAYER = new PublicKey("6u8hBsX94rFjg7iyrTGF2jyY4pqK4aLVVJRQMp77Ygch");

  // Scan recent txs to Encrypt program for execute_graph submissions
  // NOT from our payer.
  const sigs = await conn.getSignaturesForAddress(ENCRYPT, { limit: 200 });
  console.log(`Scanning ${sigs.length} recent Encrypt program txs…`);

  let theirSig: string | null = null;
  for (const s of sigs) {
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) continue;
    const keys = tx.transaction.message.staticAccountKeys;
    if (keys[0].equals(OUR_PAYER)) continue; // skip our own
    const encryptIdx = keys.findIndex(k => k.equals(ENCRYPT));
    if (encryptIdx === -1) continue;
    // Look for execute_graph in inner ix
    for (const inner of (tx.meta?.innerInstructions ?? [])) {
      for (const ii of inner.instructions) {
        if (ii.programIdIndex !== encryptIdx) continue;
        const d = typeof ii.data === "string" ? bs58.decode(ii.data) : Buffer.from(ii.data);
        if (d[0] === 4) { theirSig = s.signature; break; }
      }
      if (theirSig) break;
    }
    if (theirSig) break;
  }

  if (theirSig) await dumpExecuteGraph(conn, theirSig, "THEIRS (non-predacy, executor processed)");
  // Our latest
  const ourSig = "sTQcu9bNXEHZJmGobZjSeSfQrcSnqQD7fXKw4QnGNijdbi7jWoSHxsLuEJX3o8rTAsctavApFo3XkzxrVdu2Pj8";
  await dumpExecuteGraph(conn, ourSig, "OURS (executor skipped)");
  return;

}

main().catch(err => { console.error(err); process.exit(1); });
