"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { Connection, Transaction } from "@solana/web3.js";
import { pushToast } from "@/components/Toast";
import { getRelayerUrl } from "@/lib/relayerUrl";

interface Props {
  marketId: string;
  outcome: "YES" | "NO";
}

type Phase = "idle" | "checking" | "ready" | "no-tokens" | "signing" | "submitting" | "success" | "error";

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

/** Click-to-redeem button. On mount, hits the relayer's
 *  /redeem-outcome endpoint to discover the user's winning-token
 *  balance — server returns 404 if the user holds no winning tokens
 *  (lost bet, never bet) and 200 with a base64 unsigned tx if they
 *  do. On click, signs the tx via Privy and submits to Solana RPC. */
export default function RedeemActionButton({ marketId, outcome }: Props) {
  const { user } = usePrivy();
  const { wallets } = useSolanaWallets();
  const standardWallet = wallets[0];
  const userPubkey = user?.wallet?.address ?? standardWallet?.address ?? null;

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ txBase64: string; amount: string } | null>(null);

  // Pre-flight — figure out if there's anything to redeem the moment the
  // wallet is known. Relayer returns 404 for "no winning tokens"; treat
  // that as a clean "no-tokens" state rather than a hard error.
  const refreshPending = useCallback(async () => {
    if (!userPubkey) return;
    setPhase("checking");
    setError(null);
    try {
      const res = await fetch(`${getRelayerUrl()}/redeem-outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketIdHex: marketId, user: userPubkey }),
      });
      if (res.status === 404) {
        const body = await res.json().catch(() => ({}));
        setPending(null);
        setPhase("no-tokens");
        setError(body.error ?? "No winning tokens to redeem");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Relayer ${res.status}`);
      }
      const data = (await res.json()) as { txBase64: string; amount: string };
      setPending(data);
      setPhase("ready");
    } catch (err: any) {
      setError(err.message ?? String(err));
      setPhase("error");
    }
  }, [userPubkey, marketId]);

  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

  const onRedeem = useCallback(async () => {
    if (!pending || !standardWallet) return;
    setPhase("signing");
    setError(null);
    try {
      const tx = Transaction.from(Buffer.from(pending.txBase64, "base64"));
      // Privy SolanaWallet exposes a wallet-standard signTransaction.
      // The cast is the same one OrderForm uses internally.
      const signed = await (standardWallet as any).signTransaction(tx);
      setPhase("submitting");
      const conn = new Connection(RPC_URL, "confirmed");
      const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      // Poll for confirmation via getSignatureStatuses to dodge the
      // same WSS-cap that bites the relayer side.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const r = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
        const s = r.value?.[0];
        if (s) {
          if (s.err) throw new Error(`Redeem tx reverted: ${JSON.stringify(s.err)}`);
          if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      pushToast(
        "success",
        "Redeem confirmed",
        `Burned ${(Number(pending.amount) / 1_000_000).toFixed(2)} ${outcome} tokens for USDC`,
      );
      setPhase("success");
      // After success, refresh — typically pending will become "no-tokens"
      // since we burned the full balance.
      setTimeout(refreshPending, 800);
    } catch (err: any) {
      setError(err.message ?? String(err));
      setPhase("error");
    }
  }, [pending, standardWallet, outcome, refreshPending]);

  if (!userPubkey) {
    return (
      <p className="text-[10px] text-muted-dim italic">Connect a wallet to redeem winning {outcome} tokens.</p>
    );
  }

  if (phase === "checking") {
    return <p className="text-[10px] text-muted-dim italic">Checking your winning-token balance…</p>;
  }

  if (phase === "no-tokens") {
    return (
      <p className="text-[10px] text-muted-dim italic">
        You don&apos;t hold winning {outcome} tokens for this market — nothing to redeem.
      </p>
    );
  }

  if (phase === "success") {
    return (
      <p className="text-[11px]" style={{ color: "#52F0D3" }}>
        ✓ Redeemed for USDC.
      </p>
    );
  }

  const amountUsd = pending ? (Number(pending.amount) / 1_000_000).toFixed(2) : null;
  const isWorking = phase === "signing" || phase === "submitting";

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={!pending || isWorking}
        onClick={onRedeem}
        className={clsx(
          "w-full py-2.5 text-[11px] tracking-widest uppercase font-bold transition-colors border",
          isWorking
            ? "border-muted text-muted-dim cursor-wait"
            : "border-accent text-accent hover:bg-accent/10 cursor-pointer",
        )}
      >
        {phase === "signing" ? "Signing…"
          : phase === "submitting" ? "Submitting…"
          : `Redeem ${amountUsd ?? ""} ${outcome} → $${amountUsd ?? "0"} USDC`}
      </button>
      {error && phase === "error" && (
        <p className="text-[10px]" style={{ color: "#FF7683" }}>{error.slice(0, 200)}</p>
      )}
    </div>
  );
}
