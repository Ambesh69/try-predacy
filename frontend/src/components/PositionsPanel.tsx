"use client";

import { useState, useEffect } from "react";
import { clsx } from "clsx";
import { getRelayerUrl } from "@/lib/relayerUrl";
import { pushToast } from "@/components/Toast";

interface StoredOrder {
  commitment: string;
  salt: string;
  amount: string;
  side: number; // 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL
  limitPrice: string;
  batchId: string;
  marketId: string;
  marketQuestion: string;
  timestamp: number;
  ephemeralPubkey?: string;  // present if this order used Umbra Privacy Mode
  privacyMode?: boolean;
}

interface PositionsPanelProps {
  walletAddress: string;
  marketId?: string;
}

const SIDE_LABELS: Record<number, string> = {
  0: "BUY YES", 1: "SELL YES", 2: "BUY NO", 3: "SELL NO",
};
const SIDE_COLORS: Record<number, string> = {
  0: "#2CE8C6", 1: "#FFB14A", 2: "#FF5F6D", 3: "#FFB14A",
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatUsdc(amount: string | bigint): string {
  const n = Number(BigInt(amount)) / 1_000_000;
  return `$${n.toFixed(2)}`;
}

function cleanError(raw: string): string {
  if (raw.includes("insufficient funds")) return "Vault has insufficient funds — batch may need re-settlement.";
  if (raw.includes("AccountNotInitialized")) return "Token account not found — retrying may fix this.";
  if (raw.includes("NullifierAlreadyUsed")) return "Already claimed — this position was previously collected.";
  if (raw.includes("BatchNotSettled")) return "Batch hasn't settled yet — wait a few seconds.";
  if (raw.includes("Simulation failed")) return "Transaction failed — try again.";
  if (raw.length > 80) return raw.slice(0, 80) + "…";
  return raw;
}

function formatPrice(price: string | bigint): string {
  const c = Number(BigInt(price)) / 10_000;
  return `${c.toFixed(1)}¢`;
}

export default function PositionsPanel({ walletAddress, marketId }: PositionsPanelProps) {
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  const [claimingBatch, setClaimingBatch] = useState<string | null>(null);
  const [claimResult, setClaimResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [tab, setTab] = useState<"positions" | "activity">("positions");

  // Load orders from localStorage
  useEffect(() => {
    if (!walletAddress) return;
    try {
      const key = `predacy:orders:${walletAddress}`;
      const stored: StoredOrder[] = JSON.parse(localStorage.getItem(key) || "[]");
      const filtered = marketId
        ? stored.filter((o) => o.marketId === marketId)
        : stored;
      setOrders(filtered.sort((a, b) => b.timestamp - a.timestamp));
    } catch {
      setOrders([]);
    }
  }, [walletAddress, marketId]);

  const handleClaim = async (order: StoredOrder) => {
    setClaimingBatch(order.batchId);
    setClaimResult((prev) => ({ ...prev, [order.batchId]: undefined as any }));
    try {
      const relayerUrl = getRelayerUrl();

      // Privacy routing (architecture §5.4):
      //   - If the order was placed via Umbra Privacy Mode, the ephemeral
      //     keypair is the on-chain identity that should receive the payout.
      //     Sending to the main wallet here would destroy the wallet-
      //     unlinkability that the ephemeral bought us at commit time.
      //   - The ephemeral's ATA is created on-demand by the relayer when
      //     the claim_with_proof instruction runs, so the recipient just
      //     needs to be the ephemeral pubkey (same format as a wallet addr).
      //   - Non-privacy orders still go to main wallet as before.
      //
      // Follow-up (future): after payout lands in ephemeral ATA, shield it
      // into an Umbra UTXO so amount + identity are BOTH hidden at rest.
      // That requires signing a Solana tx from the ephemeral keypair —
      // separate integration tracked alongside "Move to address".
      const recipient = order.privacyMode && order.ephemeralPubkey
        ? order.ephemeralPubkey
        : walletAddress;

      const res = await fetch(`${relayerUrl}/claim-proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId: order.marketId,
          batchId: order.batchId,
          side: order.side,
          amount: order.amount,
          limitPrice: order.limitPrice,
          salt: order.salt,
          recipient,
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        // Poll for completion
        setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: true, msg: "Generating proof..." } }));
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          try {
            const statusRes = await fetch(`${relayerUrl}/claim-proof/status?jobId=${data.jobId}`);
            const status = await statusRes.json();
            if (status.status === "done") {
              clearInterval(poll);
              setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: true, msg: "Claimed!" } }));
              setClaimingBatch(null);
              markClaimed(order);
              const isBuy = order.side === 0 || order.side === 2;
              const toEphemeral = !!(order.privacyMode && order.ephemeralPubkey);
              const destNote = toEphemeral
                ? ` · held in ephemeral ${order.ephemeralPubkey!.slice(0, 6)}…${order.ephemeralPubkey!.slice(-4)}`
                : "";
              pushToast(
                "success",
                toEphemeral
                  ? (isBuy ? "Position claimed privately" : "USDC claimed privately")
                  : (isBuy ? "Position claimed" : "USDC claimed"),
                isBuy
                  ? `Tokens transferred for batch #${order.batchId}${destNote}`
                  : `${(Number(BigInt(order.amount)) / 1e6).toFixed(2)} USDC received${destNote}`,
              );
            } else if (status.status === "error") {
              clearInterval(poll);
              const errMsg = cleanError(status.error || "Claim failed");
              setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: false, msg: errMsg } }));
              setClaimingBatch(null);
              pushToast("error", "Claim failed", errMsg);
            }
          } catch {}
          if (attempts > 30) {
            clearInterval(poll);
            setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: false, msg: "Timeout" } }));
            setClaimingBatch(null);
          }
        }, 3000);
      } else {
        setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: false, msg: cleanError(data.error || "Failed") } }));
        setClaimingBatch(null);
      }
    } catch (err: any) {
      setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: false, msg: cleanError(err.message || "Network error") } }));
      setClaimingBatch(null);
    }
  };

  const markClaimed = (order: StoredOrder) => {
    try {
      const key = `predacy:orders:${walletAddress}`;
      const stored: any[] = JSON.parse(localStorage.getItem(key) || "[]");
      const updated = stored.map((o) =>
        o.batchId === order.batchId && o.commitment === order.commitment
          ? { ...o, claimed: true }
          : o
      );
      localStorage.setItem(key, JSON.stringify(updated));
      setOrders((prev) =>
        prev.map((o) =>
          o.batchId === order.batchId && o.commitment === order.commitment
            ? { ...o, claimed: true } as any
            : o
        )
      );
    } catch {}
  };

  const removeOrder = (order: StoredOrder) => {
    try {
      const key = `predacy:orders:${walletAddress}`;
      const stored: any[] = JSON.parse(localStorage.getItem(key) || "[]");
      const updated = stored.filter((o) =>
        !(o.batchId === order.batchId && o.commitment === order.commitment)
      );
      localStorage.setItem(key, JSON.stringify(updated));
      setOrders((prev) => prev.filter((o) =>
        !(o.batchId === order.batchId && o.commitment === order.commitment)
      ));
    } catch {}
  };

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
        {/* Icon */}
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 border border-border rounded-full" />
          <div className="absolute inset-2 border border-border/50 rounded-full" />
          <div className="absolute inset-0 flex items-center justify-center">
            <svg className="w-5 h-5 text-muted-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-text text-[12px] tracking-widest uppercase font-bold">No positions yet</p>
          <p className="text-muted-dim text-[10px] max-w-[220px] leading-relaxed">
            Sealed orders appear here after you place them. Each position can be claimed once the batch settles.
          </p>
        </div>

        <div className="flex flex-col gap-2 w-full max-w-[200px] pt-2">
          <div className="flex items-center gap-2 text-[10px] text-muted-dim">
            <span className="w-1 h-1 rounded-full bg-accent/50 flex-shrink-0" />
            <span>Submit a buy or sell order</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-dim">
            <span className="w-1 h-1 rounded-full bg-accent/50 flex-shrink-0" />
            <span>Wait ~30s for batch to settle</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-dim">
            <span className="w-1 h-1 rounded-full bg-accent/50 flex-shrink-0" />
            <span>Claim tokens or USDC payout</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex border-b border-border px-4">
        <button onClick={() => setTab("positions")}
          className={clsx("px-3 py-2.5 text-[11px] tracking-widest uppercase transition-colors border-b-2",
            tab === "positions" ? "border-accent/50 text-text" : "border-transparent text-muted hover:text-text"
          )}>Positions</button>
        <button onClick={() => setTab("activity")}
          className={clsx("px-3 py-2.5 text-[11px] tracking-widest uppercase transition-colors border-b-2",
            tab === "activity" ? "border-accent/50 text-text" : "border-transparent text-muted hover:text-text"
          )}>Activity</button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab === "activity" ? (
          /* Activity log */
          <div className="divide-y divide-border/40">
            {orders.map((order, i) => (
              <div key={`${order.batchId}-${i}`} className="px-4 py-3 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 border font-mono tracking-widest uppercase"
                    style={{ color: SIDE_COLORS[order.side], borderColor: `${SIDE_COLORS[order.side]}40` }}>
                    {SIDE_LABELS[order.side]}
                  </span>
                  <span className="text-[10px] text-muted-dim ml-auto">{timeAgo(order.timestamp)}</span>
                </div>
                <p className="text-[11px] text-text/70 truncate">{order.marketQuestion}</p>
                <div className="flex items-center gap-3 text-[10px] text-muted tabular-nums">
                  <span>{formatUsdc(order.amount)}</span>
                  <span>@ {formatPrice(order.limitPrice)}</span>
                  <span className="text-muted-dim">Batch #{order.batchId}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Positions */
          <div className="divide-y divide-border/40">
            {orders.map((order, i) => {
              const isClaimed = (order as any).claimed;
              const claiming = claimingBatch === order.batchId;
              const result = claimResult[order.batchId];
              const isBuy = order.side === 0 || order.side === 2;
              const clearingPriceNum = Number(BigInt(order.limitPrice)) / 1_000_000;
              const amountNum = Number(BigInt(order.amount)) / 1_000_000;
              const shares = isBuy && clearingPriceNum > 0 ? amountNum / clearingPriceNum : amountNum;

              return (
                <div key={`${order.batchId}-${i}`} className="px-4 py-3 space-y-2">
                  {/* Header */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono tracking-widest uppercase"
                      style={{ color: SIDE_COLORS[order.side], borderColor: `${SIDE_COLORS[order.side]}40`, background: `${SIDE_COLORS[order.side]}08` }}>
                      {SIDE_LABELS[order.side]}
                    </span>
                    <span className="text-[10px] text-muted-dim">Batch #{order.batchId}</span>
                    {order.privacyMode && (
                      <span title={`Funded via Umbra mixer · ephemeral key ${order.ephemeralPubkey?.slice(0, 6)}…${order.ephemeralPubkey?.slice(-4)}`}
                        className="text-[9px] px-1.5 py-0.5 border border-blue/40 text-blue bg-blue/5 tracking-widest uppercase font-bold">
                        🛡 Private
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-2">
                      {isClaimed && (
                        <span className="text-[10px] text-accent tracking-widest uppercase">CLAIMED ✓</span>
                      )}
                      <button onClick={() => removeOrder(order)} title="Remove"
                        className="text-muted-dim hover:text-danger text-[11px] transition-colors">×</button>
                    </span>
                  </div>

                  {/* Market */}
                  <p className="text-[11px] text-text/80 truncate">{order.marketQuestion}</p>

                  {/* Ephemeral key reveal (privacy mode) */}
                  {order.privacyMode && order.ephemeralPubkey && (
                    <p className="text-[9px] text-muted-dim hash-text break-all">
                      via {order.ephemeralPubkey.slice(0, 8)}…{order.ephemeralPubkey.slice(-8)}
                    </p>
                  )}

                  {/* Metrics */}
                  <div className="flex items-center gap-3 text-[10px] tabular-nums">
                    <span className="text-muted">
                      avg <span className="text-text">{formatPrice(order.limitPrice)}</span>
                    </span>
                    {isBuy && (
                      <span className="text-muted">
                        ~<span className="text-text">{shares.toFixed(1)}</span> shares
                      </span>
                    )}
                    <span className="text-muted">
                      {isBuy ? "cost" : "rcvd"} <span className="text-text">{formatUsdc(order.amount)}</span>
                    </span>
                  </div>

                  {/* Claim button */}
                  {!isClaimed && (
                    <button
                      onClick={() => handleClaim(order)}
                      disabled={claiming}
                      className={clsx(
                        "w-full py-2 text-[10px] tracking-widest uppercase border transition-colors",
                        claiming
                          ? "border-muted/30 text-muted"
                          : isBuy
                          ? "border-accent text-accent hover:bg-accent/5"
                          : "border-warning text-warning hover:bg-warning/5",
                      )}
                    >
                      {claiming ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-2 h-2 border border-current border-t-transparent rounded-full animate-spin" />
                          {result?.msg || "Generating ZK proof..."}
                        </span>
                      ) : isBuy ? "CLAIM POSITION" : "CLAIM USDC"}
                    </button>
                  )}

                  {/* Claim result */}
                  {result && !claiming && (
                    <div className={clsx(
                      "text-[10px] text-center py-1",
                      result.ok ? "text-accent" : "text-danger",
                    )}>
                      {result.msg}
                    </div>
                  )}

                  {/* Private-claim destination note: privacy-mode payouts go to
                      the ephemeral pubkey, not the main wallet. Users who don't
                      see the funds in their main wallet need this context. */}
                  {isClaimed && order.privacyMode && order.ephemeralPubkey && (
                    <div className="border border-blue/20 bg-blue/5 px-2 py-1.5 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-blue text-[10px]">🛡</span>
                        <span className="text-[9px] tracking-widest uppercase text-blue/80 font-bold">
                          held privately
                        </span>
                      </div>
                      <p className="text-[9px] text-muted-dim leading-snug">
                        Payout landed in ephemeral <span className="hash-text">
                          {order.ephemeralPubkey.slice(0, 6)}…{order.ephemeralPubkey.slice(-4)}
                        </span>, not your main wallet. "Move to address" coming soon.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
