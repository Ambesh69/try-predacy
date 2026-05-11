"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { clsx } from "clsx";

interface Props {
  compact?: boolean;
}

export default function WalletButtonInner({ compact = false }: Props) {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();

  // Prefer the address of the actively-connected signing wallet (the one
  // useWallets() exposes for tx signing). user.linkedAccounts can hold a
  // non-signing identifier (e.g. an off-curve wrapper that Privy reports
  // as "the wallet" but can't actually produce ed25519 signatures for)
  // — showing that would mislead the user about which wallet is doing
  // the trades. Fall back to linkedAccounts metadata only when no signing
  // wallet is connected yet (pre-login state).
  const solanaWallet = user?.linkedAccounts?.find(
    (a: any) => a.type === "wallet" && a.chainType === "solana"
  ) as any;
  const address = wallets[0]?.address ?? solanaWallet?.address ?? user?.wallet?.address;
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null;

  if (authenticated && short) {
    return (
      <div className={clsx(
        "flex items-center border divide-x transition-colors",
        compact ? "border-border divide-border" : "border-border-bright divide-border",
      )}>
        <button type="button"
          className={clsx(
            "flex items-center gap-2 tracking-widest uppercase text-text hover:bg-surface/50 transition-colors",
            compact ? "px-2.5 py-1 text-[10px]" : "px-3 py-1.5 text-xs",
          )}>
          <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
          {short}
        </button>
        <button type="button" onClick={(e) => { e.stopPropagation(); logout(); }}
          aria-label="Disconnect wallet" title="Disconnect wallet"
          className={clsx(
            "text-muted hover:text-danger hover:bg-surface/50 transition-colors",
            compact ? "px-2 py-1 text-[10px]" : "px-2.5 py-1.5 text-[11px]",
          )}>×</button>
      </div>
    );
  }

  return (
    <button type="button" onClick={login}
      className={clsx(
        "border transition-colors tracking-widest uppercase",
        compact
          ? "border-border px-2.5 py-1 text-[10px] text-muted hover:text-text hover:border-border-bright"
          : "border-border-bright px-4 py-1.5 text-xs text-text hover:border-text/20",
      )}>
      Connect
    </button>
  );
}
