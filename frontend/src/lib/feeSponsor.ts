/**
 * Fee sponsorship helper — builds an ephemeral-signed transaction with the
 * relayer as fee payer, then sends it to `/sponsor-fee` for co-signing +
 * submission.
 *
 * Architecture §7 — keeps Alice's main wallet completely absent from Tx B
 * (the commit_order transaction). The ephemeral key signs as the order's
 * on-chain author; the relayer pays the ~5000 lamport fee.
 *
 * Usage pattern (once Ika lands — Todo #8):
 *
 *   const tx = await buildCommitOrderTx(ephemeralPubkey, relayerPubkey, ix);
 *   tx.partialSign(ephemeralKeypair);      // ephemeral signs its parts
 *   const { ok, signature } = await sponsorAndSubmit(tx, ephemeralPubkey);
 *
 * Until Ika is wired, this helper sits waiting. The backend endpoint is
 * already live on the relayer (`POST /sponsor-fee`).
 */

import { Transaction, VersionedTransaction, PublicKey } from "@solana/web3.js";

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3001";

export interface SponsorResult {
  ok: boolean;
  signature?: string;
  error?: string;
}

/**
 * Send a partially-signed tx (signed by the ephemeral) to the relayer for
 * fee-payer co-signing and network submission. Returns the on-chain signature
 * on success.
 */
export async function sponsorAndSubmit(
  tx: Transaction | VersionedTransaction,
  ephemeralPubkey: string | PublicKey,
): Promise<SponsorResult> {
  try {
    const serialized = tx instanceof VersionedTransaction
      ? tx.serialize()
      : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const base64 = Buffer.from(serialized).toString("base64");
    const pubkeyStr = typeof ephemeralPubkey === "string" ? ephemeralPubkey : ephemeralPubkey.toBase58();

    const res = await fetch(`${RELAYER_URL}/sponsor-fee`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: base64, ephemeralPubkey: pubkeyStr }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, signature: data.signature };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Fee sponsorship request failed" };
  }
}

/**
 * Check whether fee sponsorship is available on the configured relayer.
 * Returns the rate limit so callers can display it to users.
 */
export async function getFeeSponsorshipStatus(): Promise<{
  available: boolean;
  ratePerMinute?: number;
}> {
  try {
    const res = await fetch(`${RELAYER_URL}/health`);
    if (!res.ok) return { available: false };
    const data = await res.json();
    return data.feeSponsorship ?? { available: false };
  } catch {
    return { available: false };
  }
}
