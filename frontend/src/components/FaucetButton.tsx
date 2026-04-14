"use client";

import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { getRelayerUrl } from "@/lib/relayerUrl";

export default function FaucetButton() {
  const { authenticated, user } = usePrivy();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Get Solana address from Privy user — check linked accounts for solana wallet
  const solanaWallet = user?.linkedAccounts?.find(
    (a: any) => a.type === "wallet" && a.chainType === "solana"
  ) as any;
  const solanaAddress = solanaWallet?.address;

  // Fallback: try the main wallet address (might be Solana if connected via Phantom)
  const walletAddress = solanaAddress || user?.wallet?.address;

  if (!authenticated || !walletAddress) return null;

  const handleFaucet = async () => {
    setLoading(true);
    setResult(null);
    try {
      const relayerUrl = getRelayerUrl();
      const res = await fetch(`${relayerUrl}/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: walletAddress }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult("1000 USDC minted");
        setTimeout(() => setResult(null), 3000);
      } else {
        setResult(data.error || "Failed");
        setTimeout(() => setResult(null), 5000);
      }
    } catch (err: any) {
      setResult("Relayer offline");
      setTimeout(() => setResult(null), 5000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleFaucet}
      disabled={loading}
      className="text-[10px] tracking-widest uppercase border border-border text-muted px-3 py-1.5 hover:border-border-bright hover:text-text transition-colors disabled:opacity-40"
    >
      {loading ? "MINTING…" : result || "GET TEST USDC"}
    </button>
  );
}
