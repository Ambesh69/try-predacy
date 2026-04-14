"use client";

import dynamic from "next/dynamic";
import { clsx } from "clsx";

interface WalletButtonProps {
  compact?: boolean;
}

const WalletButtonInner = dynamic(() => import("./WalletButtonInner"), {
  ssr: false,
  loading: () => (
    <button disabled className="border border-border tracking-widest uppercase text-muted opacity-60 px-4 py-1.5 text-xs">
      Connect
    </button>
  ),
});

export function WalletButton({ compact = false }: WalletButtonProps) {
  return (
    <>
      <noscript>
        <div className={clsx("bg-border", compact ? "w-28 h-6" : "w-24 h-7")} />
      </noscript>
      <WalletButtonInner compact={compact} />
    </>
  );
}

export default WalletButton;
