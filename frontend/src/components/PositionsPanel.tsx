"use client";

import { useState, useEffect } from "react";
import { clsx } from "clsx";
import { getRelayerUrl } from "@/lib/relayerUrl";

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
          recipient: walletAddress,
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
              // Mark as claimed in localStorage
              markClaimed(order);
            } else if (status.status === "error") {
              clearInterval(poll);
              setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: false, msg: status.error || "Claim failed" } }));
              setClaimingBatch(null);
            }
          } catch {}
          if (attempts > 30) {
            clearInterval(poll);
            setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: false, msg: "Timeout" } }));
            setClaimingBatch(null);
          }
        }, 3000);
      } else {
        setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: false, msg: data.error || "Failed" } }));
        setClaimingBatch(null);
      }
    } catch (err: any) {
      setClaimResult((prev) => ({ ...prev, [order.batchId]: { ok: false, msg: err.message || "Network error" } }));
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

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8">
        <div className="w-8 h-8 border border-border flex items-center justify-center">
          <div className="w-2 h-2 bg-muted/30" />
        </div>
        <span className="text-muted text-xs tracking-widest uppercase">No orders yet</span>
        <span className="text-muted-dim text-[10px]">Place an order to see it here</span>
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
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] px-1.5 py-0.5 border font-mono tracking-widest uppercase"
                      style={{ color: SIDE_COLORS[order.side], borderColor: `${SIDE_COLORS[order.side]}40`, background: `${SIDE_COLORS[order.side]}08` }}>
                      {SIDE_LABELS[order.side]}
                    </span>
                    <span className="text-[10px] text-muted-dim">Batch #{order.batchId}</span>
                    {isClaimed && (
                      <span className="text-[10px] text-accent tracking-widest uppercase ml-auto">CLAIMED ✓</span>
                    )}
                  </div>

                  {/* Market */}
                  <p className="text-[11px] text-text/80 truncate">{order.marketQuestion}</p>

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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
