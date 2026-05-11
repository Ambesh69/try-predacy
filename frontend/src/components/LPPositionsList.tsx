"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { usePrivy } from "@privy-io/react-auth";
import {
  useSignAndSendTransaction,
  useWallets as useSolanaWallets,
} from "@privy-io/react-auth/solana";
import {
  LPPosition,
  buildWithdrawTx,
  decodeTxBase64,
  formatUsdc6,
  listLpPositions,
  relativeTime,
} from "@/lib/lpApi";
import { pushToast } from "@/components/Toast";

interface LPPositionsListProps {
  /** Bumped by the parent to trigger a refresh after a deposit lands. */
  refreshKey?: number;
}

export default function LPPositionsList({ refreshKey = 0 }: LPPositionsListProps) {
  const { authenticated, user } = usePrivy();
  const solanaWalletMeta = user?.linkedAccounts?.find(
    (a: any) => a.type === "wallet" && a.chainType === "solana",
  ) as any;
  const walletAddress: string | undefined =
    solanaWalletMeta?.address ?? user?.wallet?.address;
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { wallets: solanaWallets } = useSolanaWallets();
  // Match against the linked external wallet — Privy also returns an
  // auto-provisioned embedded wallet in this list, and we don't want
  // withdrawals routed through that.
  const wallet =
    solanaWallets.find((w) => w.address === walletAddress) ?? solanaWallets[0];

  const [positions, setPositions] = useState<LPPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated || !walletAddress) {
      setPositions([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function refresh() {
      try {
        const next = await listLpPositions(walletAddress!);
        if (!cancelled) {
          setPositions(next);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? "Failed to load positions");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [authenticated, walletAddress, refreshKey]);

  async function handleWithdraw(pos: LPPosition) {
    if (!walletAddress) return;
    setWithdrawing(pos.handleId);
    try {
      const built = await buildWithdrawTx({
        handleIdHex: pos.handleId,
        depositor: walletAddress,
        // We crank the tx ourselves (cranker = depositor). The vault PDA
        // signs the USDC payout via PDA seeds; the LP just provides the
        // signature on the outer tx.
        cranker: walletAddress,
      });
      const result = await signAndSendTransaction({
        transaction: decodeTxBase64(built.txBase64),
        wallet: wallet as any,
        chain: "solana:devnet" as any,
      });
      pushToast(
        "success",
        "Withdrew LP capital",
        `Position in ${pos.handleId.slice(0, 8)}… settled`,
      );
      // Refresh by mutating the local state — withdraw flips `withdrawn=true`
      setPositions((prev) =>
        prev.map((p) =>
          p.handleId === pos.handleId ? { ...p, withdrawn: true } : p,
        ),
      );
    } catch (err: any) {
      const msg = cleanError(err.message ?? "Withdraw failed");
      pushToast("error", "Withdraw failed", msg);
    } finally {
      setWithdrawing(null);
    }
  }

  if (!authenticated) {
    return (
      <div className="p-4 border border-card-border bg-card text-center">
        <p className="text-[11px] tracking-widest uppercase text-muted">
          Connect wallet to see your LP positions
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 border border-card-border bg-card text-center">
        <p className="text-[10px] text-muted animate-pulse">Loading positions…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 border border-danger/30 bg-danger/5">
        <p className="text-[10px] text-danger">⚠ {error}</p>
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="p-4 border border-card-border bg-card text-center">
        <p className="text-[11px] tracking-widest uppercase text-muted">
          No active LP positions
        </p>
        <p className="text-[10px] text-muted-dim mt-1">
          Deposit USDC under an event to start earning.
        </p>
      </div>
    );
  }

  const totalDeposited = positions.reduce(
    (acc, p) => acc + BigInt(p.depositedUsdc),
    0n,
  );
  const totalShares = positions.reduce(
    (acc, p) => acc + BigInt(p.shares),
    0n,
  );

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] tracking-widest uppercase text-accent">
          My LP Positions
        </p>
        <p className="text-[10px] text-muted">
          ${formatUsdc6(totalDeposited)} deposited · {String(totalShares)} shares
        </p>
      </div>
      <div className="divide-y divide-card-border/40 border border-card-border bg-card">
        {positions.map((pos) => (
          <PositionRow
            key={pos.handleId}
            pos={pos}
            withdrawing={withdrawing === pos.handleId}
            onWithdraw={() => handleWithdraw(pos)}
          />
        ))}
      </div>
    </div>
  );
}

function PositionRow({
  pos,
  withdrawing,
  onWithdraw,
}: {
  pos: LPPosition;
  withdrawing: boolean;
  onWithdraw: () => void;
}) {
  const now = Math.floor(Date.now() / 1000);
  const expired = now >= pos.commitmentExpiresAt;
  const canWithdraw = expired && !pos.withdrawn;

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-text truncate max-w-[60%]">
          {pos.handleId}
        </span>
        <span
          className={clsx(
            "text-[9px] px-1.5 py-0.5 border rounded-sm tracking-widest uppercase",
            pos.withdrawn
              ? "border-muted/40 text-muted"
              : expired
                ? "border-accent/40 text-accent"
                : "border-warning/40 text-warning",
          )}
        >
          {pos.withdrawn ? "WITHDRAWN" : expired ? "REDEEMABLE" : "LOCKED"}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <Stat label="Deposit" value={`$${formatUsdc6(pos.depositedUsdc)}`} />
        <Stat label="Shares"  value={String(BigInt(pos.shares))} />
        <Stat
          label={expired ? "Expired" : "Locked until"}
          value={relativeTime(pos.commitmentExpiresAt)}
        />
      </div>
      {!pos.withdrawn && (
        <button
          type="button"
          onClick={onWithdraw}
          disabled={!canWithdraw || withdrawing}
          className={clsx(
            "w-full py-1.5 text-[10px] tracking-widest uppercase border transition-colors",
            canWithdraw && !withdrawing
              ? "border-accent text-accent hover:bg-accent/5"
              : "border-card-border text-muted opacity-40 cursor-not-allowed",
          )}
        >
          {withdrawing
            ? "WITHDRAWING…"
            : canWithdraw
              ? "WITHDRAW"
              : `LOCKED · ${relativeTime(pos.commitmentExpiresAt)}`}
        </button>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] tracking-widest uppercase text-muted">{label}</p>
      <p className="font-mono text-text mt-0.5 truncate">{value}</p>
    </div>
  );
}

function cleanError(raw: string): string {
  if (raw.includes("RescueDelayNotElapsed")) return "Lockup hasn't expired yet.";
  if (raw.includes("AlreadyClaimed")) return "Position already withdrawn.";
  if (raw.includes("rejected")) return "Transaction rejected in wallet.";
  if (raw.length > 100) return raw.slice(0, 100) + "…";
  return raw;
}
