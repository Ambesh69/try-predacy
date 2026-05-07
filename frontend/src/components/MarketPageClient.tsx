"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { clsx } from "clsx";
import { usePrivy } from "@privy-io/react-auth";
import BatchTimer from "@/components/BatchTimer";
import { useLiveEvents } from "@/lib/useLiveEvents";

const FaucetButton = dynamic(() => import("@/components/FaucetButton"), { ssr: false });
const HeaderBalance = dynamic(() => import("@/components/HeaderBalance"), { ssr: false });
const ClaimsWidget = dynamic(() => import("@/components/ClaimsWidget"), { ssr: false });
import CommitmentFeed from "@/components/CommitmentFeed";
import { OrderForm } from "@/components/OrderForm";
import PriceChart from "@/components/PriceChart";
import PositionsPanel from "@/components/PositionsPanel";
import WalletButton from "@/components/WalletButton";
import { getMarket, MOCK_MARKETS, type Market } from "@/lib/polymarket";
import { getRelayerUrl } from "@/lib/relayerUrl";

const MOCK_BATCH = {
  batchId: 0n,
  openedAt: Math.floor(Date.now() / 1000) - 8,
  batchWindow: 30,
  commitmentCount: 0,
  totalDeposited: 0n,
  status: 0, // 0=OPEN, 1=SETTLING, 2=SETTLED
  clearingPrice: 0n,
  settlingStartedAt: 0,
};

export function MarketPageClient({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = usePrivy();
  const solanaWallet = user?.linkedAccounts?.find((a: any) => a.type === "wallet" && a.chainType === "solana") as any;
  const walletAddress = solanaWallet?.address ?? user?.wallet?.address;
  const [market, setMarket]           = useState<Market | null>(null);
  const [batch, setBatch]             = useState(MOCK_BATCH);
  const [commitments, setCommitments] = useState<any[]>([]);
  const [loading, setLoading]         = useState(true);
  const [batchStatus, setBatchStatus] = useState<any>(null);
  const [batchActive, setBatchActive] = useState(false);
  const [batchTimer, setBatchTimer]   = useState(30);
  const [activeTab, setActiveTab]     = useState<"order" | "positions">("order");

  // Load market data
  useEffect(() => {
    const found = MOCK_MARKETS.find((m) => m.conditionId === id);
    if (found) { setMarket(found); setLoading(false); return; }
    getMarket(id)
      .then((m) => setMarket(m))
      .catch(() => setMarket(null))
      .finally(() => setLoading(false));
  }, [id]);

  // Fetch batch status from the relayer — reusable for both the polling
  // interval and the live gRPC event subscriber below.
  const poll = useCallback(async () => {
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) return;
    try {
      const res = await fetch(`${relayerUrl}/batch-status?marketId=${id}`);
      if (!res.ok) { setBatchActive(false); return; }
      const data = await res.json();
      if (!data.currentBatchId && !data.settlingBatchId) {
        setBatchActive(false);
        return;
      }
      setBatchStatus(data);
      setBatchActive(true);
      const activeBatchId = data.currentBatchId ?? data.settlingBatchId;
      const isSettling = !data.currentBatchId && data.settlingBatchId;
      setBatch((prev) => ({
        ...prev,
        batchId: BigInt(activeBatchId),
        commitmentCount: data.orderCount ?? prev.commitmentCount,
        status: isSettling || data.processingBatch ? 1 : 0,
        totalDeposited: data.batchRunningUsd ? BigInt(data.batchRunningUsd) : prev.totalDeposited,
        openedAt: data.openedAt ?? prev.openedAt,
        settlingStartedAt: data.settlingStartedAt ?? 0,
      }));
      if (data.commitments?.length) {
        setCommitments(data.commitments.map((c: any) => ({
          hash: c.hash as `0x${string}`,
          timestamp: c.timestamp,
        })));
      }
    } catch {}
  }, [id]);

  // Periodic fallback poll — runs every 5s even when gRPC is inactive
  useEffect(() => {
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  // Live SSE subscription — when RPC Fast gRPC is streaming, we get sub-100ms
  // notifications on every commit/settle/claim and trigger an immediate
  // refetch so the UI reflects new commitments without the 5s poll lag.
  const { subscribe, streaming } = useLiveEvents();
  useEffect(() => {
    return subscribe("*", () => { poll(); });
  }, [subscribe, poll]);

  // Batch countdown
  useEffect(() => {
    const interval = setInterval(() => {
      setBatchTimer((t) => (t <= 0 ? 30 : t - 1));
      setBatch((prev) => ({
        ...prev,
        openedAt: prev.status === 0 ? prev.openedAt : Math.floor(Date.now() / 1000),
      }));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-border px-4 md:px-6 py-3 flex items-center gap-3">
          <div className="h-3 w-20 bg-border animate-pulse" />
          <span className="text-border">|</span>
          <div className="h-5 w-24 bg-border/80 animate-pulse" />
        </header>
        <div className="border-b border-border px-6 py-5 space-y-3">
          <div className="h-4 w-24 bg-border/60 animate-pulse" />
          <div className="h-5 w-2/3 bg-border animate-pulse" />
        </div>
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr_320px] divide-x divide-border/90">
          <div className="p-6 space-y-4">
            <div className="w-[140px] h-[140px] mx-auto rounded-full bg-border/40 animate-pulse" />
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-3 bg-border/40 animate-pulse" />)}
            </div>
          </div>
          <div className="p-6 space-y-3">
            <div className="h-40 bg-border/30 border border-border animate-pulse" />
            <div className="h-32 bg-border/20 border border-border animate-pulse" />
          </div>
          <div className="p-4 space-y-3">
            <div className="h-10 bg-border/60 animate-pulse" />
            <div className="h-32 bg-border/40 animate-pulse" />
            <div className="h-10 bg-border animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  const yesPrice = parseFloat(market?.outcomePrices?.[0] ?? "0.5");
  const noPrice  = parseFloat(market?.outcomePrices?.[1] ?? "0.5");
  const yesProb  = Math.round(yesPrice * 100);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-4 md:px-6 py-3 flex items-center gap-2 md:gap-3 flex-wrap bg-surface/25 backdrop-blur-[2px]">
        <Link href="/"
          className="text-muted hover:text-text transition-colors text-[11px] tracking-widest uppercase flex items-center gap-1.5">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
          </svg>
          Markets
        </Link>
        <span className="text-border">|</span>
        <h1 className="text-lg font-black text-text tracking-tight leading-tight"
          style={{ fontFamily: "var(--font-display)" }}>PREDACY</h1>
        <div className="ml-auto flex items-center gap-3">
          <ClaimsWidget />
          <HeaderBalance />
          <FaucetButton />
          <WalletButton compact />
        </div>
      </header>

      {/* Market info bar */}
      <div className="border-b border-border px-4 md:px-6 py-5 bg-surface/20">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {market?.category && (
              <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5 mb-2 inline-block">
                {market.category}
              </span>
            )}
            <h2 className="text-text text-[15px] leading-snug mt-1">{market?.question ?? "Market"}</h2>
          </div>
          <div className="flex-shrink-0 text-right">
            <p className="text-[10px] text-muted tracking-widest uppercase">Polymarket Price</p>
            <p className={clsx(
              "text-3xl font-black leading-none",
              yesProb > 60 ? "text-accent glow-accent" : yesProb < 40 ? "text-danger glow-danger" : "text-blue glow-blue",
            )} style={{ fontFamily: "var(--font-display)" }}>{yesProb}%</p>
            <p className="text-[10px] text-muted mt-0.5">YES probability</p>
          </div>
        </div>
      </div>

      {/* Main 3-column layout */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr_320px] divide-x divide-border/90">
        {/* Column 1: Batch timer + stats */}
        <div className="p-4 md:p-6 flex flex-col gap-6 border-b lg:border-b-0 bg-surface/[0.18]">
          {batchActive ? (
            <BatchTimer
              openedAt={batch.openedAt}
              batchWindow={batch.batchWindow}
              commitmentCount={batch.commitmentCount}
              totalDeposited={batch.totalDeposited}
              batchId={batch.batchId}
              status={batch.status}
              clearingPrice={batch.clearingPrice}
              settlingStartedAt={batch.settlingStartedAt}
            />
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="w-[140px] h-[140px] border border-border rounded-full flex items-center justify-center">
                <span className="text-muted-dim text-lg" style={{ fontFamily: "var(--font-display)" }}>—</span>
              </div>
              <span className="text-[10px] text-muted tracking-widest uppercase">No active batch</span>
              <span className="text-[9px] text-muted-dim">Place an order to start a batch</span>
            </div>
          )}

          <div className="space-y-1">
            <p className="text-[10px] text-muted tracking-widest uppercase">Market ID</p>
            <p className="hash-text text-[11px] break-all">{id}</p>
          </div>

          {/* Privacy explainer */}
          <div className="border border-border p-3 space-y-2">
            <p className="text-[10px] text-muted-dim tracking-widest uppercase">Privacy status</p>
            <div className="space-y-1.5">
              {[
                { item: "Buy / Sell direction",          hidden: true },
                { item: "Your limit price",              hidden: true },
                { item: "Salt (blinding factor)",        hidden: true },
                { item: "Clearing price (until settle)", hidden: true },
                { item: "Commitment hash",               hidden: false, note: "order time" },
                { item: "Amount",                        hidden: false, note: "at settlement" },
              ].map(({ item, hidden, note }) => (
                <div key={item} className="flex items-center gap-2">
                  <span className={clsx("text-[10px]", hidden ? "text-accent/60" : "text-yellow-500/60")}>
                    {hidden ? "✓" : "◆"}
                  </span>
                  <span className={clsx("text-[11px]", hidden ? "text-text/70" : "text-muted-dim")}>{item}</span>
                  <span className={clsx("ml-auto text-[9px] tracking-widest uppercase", hidden ? "text-accent/40" : "text-yellow-500/40")}>
                    {hidden ? "hidden" : note}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[9px] text-muted-dim pt-1 border-t border-border/40">
              Your order is sealed with a commitment hash. The relayer submits it only at settlement.
              ZK proofs verify clearing without revealing individual orders.
            </p>
          </div>
        </div>

        {/* Column 2: Price chart + Commitment feed */}
        <div className="flex flex-col min-h-[400px] lg:min-h-0 border-b lg:border-b-0 bg-surface/[0.1]">
          {market?.clobTokenIds?.[0] && (
            <PriceChart
              tokenId={market.clobTokenIds[0]}
              currentPrice={yesPrice}
            />
          )}
          <div className="flex-1 min-h-0">
            <CommitmentFeed entries={commitments} streaming={streaming} />
          </div>
        </div>

        {/* Column 3: Order form / Positions */}
        <div className="flex flex-col bg-surface/[0.24]">
          <div className="border-b border-border px-4 py-0 flex items-center">
            <div className="flex items-center flex-1">
              <button onClick={() => setActiveTab("order")}
                className={clsx("px-3 py-3 text-[11px] tracking-widest uppercase transition-colors border-b-2",
                  activeTab === "order" ? "border-accent/50 text-text bg-accent/10" : "border-transparent text-muted hover:text-text"
                )}>Order</button>
              <button onClick={() => setActiveTab("positions")}
                className={clsx("px-3 py-3 text-[11px] tracking-widest uppercase transition-colors border-b-2",
                  activeTab === "positions" ? "border-accent/50 text-text bg-accent/10" : "border-transparent text-muted hover:text-text"
                )}>My Positions</button>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <div className={clsx(
                "w-1.5 h-1.5 rounded-full",
                batch.status === 0 ? "bg-accent animate-pulse" : "bg-muted/40"
              )} />
              <span className={clsx(
                "text-[10px] tracking-widest uppercase",
                batch.status === 0 ? "text-accent/70" : "text-muted-dim"
              )}>
                {batch.status === 0 ? "OPEN" : batch.status === 1 ? "SETTLING" : "SETTLED"}
              </span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {activeTab === "positions" ? (
              walletAddress ? (
                <PositionsPanel walletAddress={walletAddress} marketId={id} />
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 p-6">
                  <p className="text-muted text-xs text-center">Connect wallet to view positions</p>
                </div>
              )
            ) : (
              <OrderForm
                marketId={id}
                marketQuestion={market?.question ?? "Market"}
                yesPrice={yesPrice}
                noPrice={noPrice}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
