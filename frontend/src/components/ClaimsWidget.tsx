"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { Connection, Transaction } from "@solana/web3.js";
import { pushToast } from "@/components/Toast";
import { getRelayerUrl } from "@/lib/relayerUrl";

// Without NEXT_PUBLIC_PRIVY_APP_ID the PrivyProvider is bypassed and
// useSolanaWallets() returns null — destructuring crashes the entire
// page. Same pattern as the OrderForm / LPDepositForm gates: bail out
// at module level so the widget renders nothing locally without Privy
// in the tree. Production has Privy so the gate no-ops there.
const PRIVY_AVAILABLE = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

export default function ClaimsWidget() {
  if (!PRIVY_AVAILABLE) return null;
  return <ClaimsWidgetInner />;
}

interface Claim {
  marketId: string;
  eventHandleId: string;
  eventLabel: string | null;
  marketLabel: string | null;
  outcome: "YES" | "NO";
  amount: string;
  txBase64: string;
}

const POLL_MS = 30_000;
const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

/** Header widget that mirrors Pumpcade's "auto-claim" UX without
 *  needing a program-level change. On wallet connect, polls
 *  /claims/:user every 30s. When there's anything redeemable, surfaces
 *  a green pill in the header. Clicking redeems everything in a single
 *  sequential signing flow — the user signs N txs but doesn't have to
 *  navigate to each market.
 *
 *  We can't do TRUE auto-claim (relayer-side burn) because the
 *  on-chain redeem_outcome ix requires the user's signature on the
 *  Burn — Anchor's Token::Burn needs `authority: Signer` and the
 *  authority is the user. Workarounds need a program change. This
 *  widget is the closest to auto-claim that's reachable today. */
function ClaimsWidgetInner() {
  const { user, authenticated } = usePrivy();
  const { wallets } = useSolanaWallets();
  const standardWallet = wallets[0];
  const userPubkey = user?.wallet?.address ?? standardWallet?.address ?? null;

  const [claims, setClaims] = useState<Claim[]>([]);
  const [redeeming, setRedeeming] = useState(false);

  const refresh = useCallback(async () => {
    if (!userPubkey) return;
    try {
      const res = await fetch(`${getRelayerUrl()}/claims/${userPubkey}`);
      if (!res.ok) return;
      const data = (await res.json()) as { claims: Claim[] };
      setClaims(data.claims ?? []);
    } catch { /* keep prior list */ }
  }, [userPubkey]);

  useEffect(() => {
    if (!authenticated || !userPubkey) {
      setClaims([]);
      return;
    }
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [authenticated, userPubkey, refresh]);

  const onRedeemAll = useCallback(async () => {
    if (claims.length === 0 || !standardWallet || redeeming) return;
    setRedeeming(true);
    let succeeded = 0;
    let failed = 0;
    const conn = new Connection(RPC_URL, "confirmed");

    for (const c of claims) {
      try {
        const tx = Transaction.from(Buffer.from(c.txBase64, "base64"));
        const signed = await (standardWallet as any).signTransaction(tx);
        const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        // Same HTTP-poll confirmation pattern as the rest of the codebase.
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const r = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
          const s = r.value?.[0];
          if (s) {
            if (s.err) throw new Error(`Redeem reverted: ${JSON.stringify(s.err)}`);
            if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        succeeded++;
      } catch (err: any) {
        // User cancelled or tx failed — keep iterating, surface aggregate count.
        const msg = String(err?.message ?? err);
        if (!msg.toLowerCase().includes("user rejected")) {
          console.warn(`[ClaimsWidget] redeem ${c.marketId.slice(0, 8)} failed:`, msg);
        }
        failed++;
      }
    }

    if (succeeded > 0) {
      const totalUsd = claims
        .slice(0, succeeded)
        .reduce((acc, c) => acc + Number(c.amount) / 1_000_000, 0);
      pushToast(
        "success",
        "Claims redeemed",
        `Burned ${succeeded} winning position${succeeded === 1 ? "" : "s"} for $${totalUsd.toFixed(2)} USDC`,
      );
    }
    if (failed > 0 && succeeded === 0) {
      pushToast("error", "Redeem failed", `${failed} claim${failed === 1 ? "" : "s"} could not be settled. Try again?`);
    }
    setRedeeming(false);
    setTimeout(refresh, 600);
  }, [claims, standardWallet, redeeming, refresh]);

  if (!authenticated || !userPubkey || claims.length === 0) return null;

  const totalUsd = claims.reduce((acc, c) => acc + Number(c.amount) / 1_000_000, 0);

  return (
    <button
      type="button"
      onClick={onRedeemAll}
      disabled={redeeming}
      className={clsx(
        "flex items-center gap-2 border px-3 py-1.5 text-[10px] tracking-widest uppercase font-bold transition-colors",
        redeeming
          ? "border-muted text-muted-dim cursor-wait"
          : "border-accent text-accent hover:bg-accent/10 cursor-pointer",
      )}
      style={{ fontFamily: "var(--font-display)" }}
      title={`${claims.length} claim${claims.length === 1 ? "" : "s"} ready to redeem 1:1 for USDC`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse inline-block" />
      {redeeming
        ? `Redeeming ${claims.length}…`
        : `Claim $${totalUsd.toFixed(2)}`}
      <span className="text-muted-dim normal-case font-mono tabular-nums">
        {claims.length}
      </span>
    </button>
  );
}
