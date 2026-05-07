"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { clsx } from "clsx";
import {
  type PredacyMarketMeta,
  getPredacyMarket,
  relativeTime,
} from "@/lib/lpApi";
import { getRelayerUrl } from "@/lib/relayerUrl";
import { OrderForm } from "@/components/OrderForm";
import BatchTimer from "@/components/BatchTimer";

const WalletButton = dynamic(() => import("@/components/WalletButton"), { ssr: false });
const HeaderBalance = dynamic(() => import("@/components/HeaderBalance"), { ssr: false });
const ClaimsWidget = dynamic(() => import("@/components/ClaimsWidget"), { ssr: false });

interface Props {
  params: Promise<{ marketId: string }>;
}

interface BatchSnapshot {
  batchId: bigint;
  openedAt: number;
  status: number;
  commitmentCount: number;
  totalDeposited: bigint;
  settlingStartedAt: number;
  active: boolean;
}

const BATCH_WINDOW_SEC = 30;

function emptyBatch(): BatchSnapshot {
  return {
    batchId: 0n,
    openedAt: Math.floor(Date.now() / 1000),
    status: 0,
    commitmentCount: 0,
    totalDeposited: 0n,
    settlingStartedAt: 0,
    active: false,
  };
}

export default function PredacyMarketDetail({ params }: Props) {
  const { marketId } = use(params);
  const [meta, setMeta] = useState<PredacyMarketMeta | null | undefined>(undefined);
  const [batch, setBatch] = useState<BatchSnapshot>(emptyBatch);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const m = await getPredacyMarket(marketId);
      if (!cancelled) setMeta(m);
    }
    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [marketId]);

  // Poll the relayer for batch state every 2s — same cadence the existing
  // MarketPageClient uses. The endpoint is the relayer's authoritative
  // view of the current sealed-bid batch (open vs settling vs idle).
  useEffect(() => {
    let cancelled = false;
    async function pollBatch() {
      try {
        const res = await fetch(`${getRelayerUrl()}/batch-status?marketId=${marketId}`);
        if (!res.ok) {
          if (!cancelled) setBatch((prev) => ({ ...prev, active: false }));
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (!data.currentBatchId && !data.settlingBatchId) {
          setBatch((prev) => ({ ...prev, active: false }));
          return;
        }
        const activeBatchId = data.currentBatchId ?? data.settlingBatchId;
        const isSettling = !data.currentBatchId && !!data.settlingBatchId;
        setBatch({
          batchId: BigInt(activeBatchId),
          openedAt: data.openedAt ?? Math.floor(Date.now() / 1000),
          status: isSettling || data.processingBatch ? 1 : 0,
          commitmentCount: data.orderCount ?? 0,
          totalDeposited: data.batchRunningUsd ? BigInt(data.batchRunningUsd) : 0n,
          settlingStartedAt: data.settlingStartedAt ?? 0,
          active: true,
        });
      } catch { /* silent — surfaces as "no active batch" */ }
    }
    pollBatch();
    const id = setInterval(pollBatch, 2_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [marketId]);

  if (meta === undefined) {
    return <PageShell><CenteredNotice>Loading market…</CenteredNotice></PageShell>;
  }
  if (meta === null) {
    return (
      <PageShell>
        <CenteredNotice>
          Market <code className="text-accent font-mono">{marketId.slice(0, 12)}…</code> not registered under any event.{" "}
          <Link href="/" className="text-accent hover:underline">Back to markets</Link>
        </CenteredNotice>
      </PageShell>
    );
  }

  const closesIn = meta.eventClosesAt - Math.floor(Date.now() / 1000);
  const isExpired = closesIn <= 0;
  const display = meta.label ?? `Market ${marketId.slice(0, 8)}…`;

  return (
    <PageShell>
      <section className="border-b border-card-border bg-bg-elevated">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex items-center gap-2 mb-3 text-[11px] tracking-widest uppercase">
            <Link href="/" className="text-muted hover:text-text">← Markets</Link>
            <span className="text-muted-dim">·</span>
            <Link href={`/event/predacy/${meta.eventHandleId}`} className="text-accent hover:underline">
              {meta.eventLabel ?? "Predacy event"}
            </Link>
            <span className="text-muted-dim">·</span>
            <span className="text-muted">{meta.eventCategory}</span>
          </div>
          <h1 className="text-[24px] md:text-[32px] font-bold text-text leading-tight">
            {display}
          </h1>
          <p className={clsx(
            "text-[11px] mt-2",
            isExpired ? "text-danger" : "text-muted",
          )}>
            {isExpired ? "Event closed" : `Event closes ${relativeTime(meta.eventClosesAt)}`}
            <span className="text-muted-dim ml-3">· {meta.feeBpsTaker / 100}% taker fee · {meta.feeBpsRebates / 100}% to LP rebates</span>
          </p>
        </div>
      </section>

      <main className="max-w-7xl mx-auto px-4 py-8 grid lg:grid-cols-[1fr_380px] gap-6">
        <div className="space-y-4">
          <SectionHeader>Batch status</SectionHeader>
          <div className="border border-card-border bg-card p-4 flex justify-center">
            {batch.active ? (
              <BatchTimer
                openedAt={batch.openedAt}
                batchWindow={BATCH_WINDOW_SEC}
                commitmentCount={batch.commitmentCount}
                totalDeposited={batch.totalDeposited}
                batchId={batch.batchId}
                status={batch.status}
                settlingStartedAt={batch.settlingStartedAt}
              />
            ) : (
              <div className="py-6 text-center">
                <p className="text-[12px] text-muted">No active batch — first sealed bid opens one.</p>
                <p className="text-[10px] text-muted-dim mt-1">Batches clear every {BATCH_WINDOW_SEC} seconds once active.</p>
              </div>
            )}
          </div>

          <SectionHeader>Recent batches</SectionHeader>
          <div className="border border-card-border bg-card p-6 text-center">
            <p className="text-[12px] text-muted">
              No batches settled yet — be the first to commit a sealed bid.
            </p>
            <p className="text-[10px] text-muted-dim mt-2 max-w-md mx-auto">
              Predacy clears every 30 seconds. Your order is encrypted on submit and stays opaque to everyone (including the relayer in strict-FHE mode) until the batch closes.
            </p>
          </div>

          <SectionHeader>Why a sealed-bid market?</SectionHeader>
          <div className="border border-card-border bg-card-elevated p-4 text-[10px] text-muted leading-snug space-y-1.5">
            <p><span className="text-accent">·</span> No-one — including the relayer, in strict-FHE mode — sees your direction or size during the 30-second batch window.</p>
            <p><span className="text-accent">·</span> All orders in the batch clear at a single uniform price computed by ZK proof. No frontrunning, no MEV.</p>
            <p><span className="text-accent">·</span> Net imbalance after pair-matching is absorbed by the parent event&apos;s LP vault (residual hedged on Polymarket mainnet).</p>
            <p><span className="text-accent">·</span> Settlement is sub-second on Solana once the proof verifies.</p>
          </div>
        </div>

        <aside className="space-y-4">
          <SectionHeader>Place a sealed bid</SectionHeader>
          {/* Predacy-native markets default to a 50/50 prior — the actual
              clearing price comes from the first batch, not from a spot
              price feed. OrderForm renders fine with this since it just
              treats yes/no prices as defaults for the limit-order picker. */}
          <OrderForm
            marketId={marketId}
            marketQuestion={display}
            yesPrice={0.5}
            noPrice={0.5}
          />
        </aside>
      </main>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-text font-mono">
      <header className="border-b border-card-border">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-[14px] tracking-widest uppercase font-bold text-accent">
              Predacy
            </Link>
            <nav className="flex items-center gap-4 text-[11px] tracking-widest uppercase">
              <Link href="/" className="text-muted hover:text-text transition-colors">
                Markets
              </Link>
              <Link href="/lp" className="text-muted hover:text-text transition-colors">
                Liquidity
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <ClaimsWidget />
            <HeaderBalance />
            <WalletButton />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-16 text-center text-[13px] text-muted">
      {children}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] tracking-widest uppercase text-accent">
      {children}
    </p>
  );
}
