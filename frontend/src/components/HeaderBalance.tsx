"use client";

import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { getRelayerUrl } from "@/lib/relayerUrl";

export default function HeaderBalance() {
  const { authenticated, user } = usePrivy();
  const solanaWallet = user?.linkedAccounts?.find(
    (a: any) => a.type === "wallet" && a.chainType === "solana"
  ) as any;
  const walletAddress = solanaWallet?.address ?? user?.wallet?.address;
  const [usdc, setUsdc] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated || !walletAddress) {
      setUsdc(null);
      return;
    }
    const fetchUsdc = async () => {
      try {
        // Use the demo market ID to get the user's USDC balance — the endpoint
        // returns USDC for any market since all markets share the same USDC mint.
        const demoMarketId = "predacy-demo-v1";
        const res = await fetch(
          `${getRelayerUrl()}/balances?wallet=${walletAddress}&marketId=${Buffer.from(demoMarketId).toString("hex").padEnd(64, "0")}`
        );
        if (res.ok) {
          const data = await res.json();
          setUsdc(data.usdc);
        }
      } catch {}
    };
    fetchUsdc();
    const iv = setInterval(fetchUsdc, 15_000);
    return () => clearInterval(iv);
  }, [authenticated, walletAddress]);

  if (!authenticated || usdc === null) return null;

  const amount = Number(BigInt(usdc)) / 1_000_000;
  return (
    <div className="flex items-center gap-1.5 border border-border bg-surface/60 px-3 py-1.5">
      <div className="w-1.5 h-1.5 rounded-full bg-accent/60" />
      <span className="text-[11px] text-text tabular-nums">${amount.toFixed(2)}</span>
      <span className="text-[9px] text-muted-dim tracking-widest uppercase">USDC</span>
    </div>
  );
}
