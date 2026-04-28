"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { EventDescriptor, formatUsdc6, listEvents } from "@/lib/lpApi";
import EventPicker from "@/components/EventPicker";
import LPDepositForm from "@/components/LPDepositForm";
import LPPositionsList from "@/components/LPPositionsList";

const WalletButton = dynamic(() => import("@/components/WalletButton"), { ssr: false });
const HeaderBalance = dynamic(() => import("@/components/HeaderBalance"), { ssr: false });

export default function LPPage() {
  const [selected, setSelected] = useState<EventDescriptor | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [stackStats, setStackStats] = useState<{
    activeEvents: number;
    totalCapital: string;
    graduated: number;
  } | null>(null);

  // Pull aggregate Liquidity Stack stats for the header strip — gives the
  // page a "you're walking into a real market" vibe vs an empty form.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const events = await listEvents();
        if (cancelled) return;
        const active = events.filter((e) => !e.closed);
        setStackStats({
          activeEvents: active.length,
          totalCapital: active
            .reduce((acc, e) => acc + BigInt(e.cumulativeVolumeUsdc), 0n)
            .toString(),
          graduated: active.filter((e) => e.graduated).length,
        });
      } catch { /* keep null */ }
    }
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="min-h-screen bg-bg text-text font-mono">
      {/* Header */}
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
              <Link href="/lp" className="text-accent">
                Liquidity
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <HeaderBalance />
            <WalletButton />
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-card-border bg-bg-elevated">
        <div className="max-w-7xl mx-auto px-4 py-10 grid md:grid-cols-2 gap-8 items-end">
          <div>
            <p className="text-[11px] tracking-widest uppercase text-accent mb-2">
              The Stack
            </p>
            <h1 className="text-[32px] md:text-[40px] leading-tight font-bold text-text">
              Provide liquidity for sealed-bid prediction markets.
            </h1>
            <p className="text-[12px] text-muted mt-3 max-w-xl">
              Deposit USDC under an event, earn a pro-rata share of taker fees +
              spread for every batch in that event. Capital auto-refunds at
              event close.
            </p>
            <p className="text-[11px] text-accent mt-4">
              Blind LP enabled by default — your individual allocation is
              FHE-encrypted on-chain. Aggregate vault balance stays public.
            </p>
          </div>
          {stackStats && (
            <div className="grid grid-cols-3 gap-3 text-[10px]">
              <StackStat
                label="Active events"
                value={String(stackStats.activeEvents)}
              />
              <StackStat
                label="Cumulative volume"
                value={`$${formatUsdc6(stackStats.totalCapital)}`}
              />
              <StackStat
                label="Graduated"
                value={`${stackStats.graduated} / ${stackStats.activeEvents}`}
                hint="Tier 1 backstop active"
              />
            </div>
          )}
        </div>
      </section>

      {/* Main panel — deposit on the left, positions on the right */}
      <main className="max-w-7xl mx-auto px-4 py-8 grid md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <EventPicker selected={selected} onSelect={setSelected} />
          <LPDepositForm
            event={selected}
            onDeposited={() => setRefreshKey((k) => k + 1)}
          />
          <LiquidityStackBreakdown event={selected} />
        </div>
        <div className="space-y-4">
          <LPPositionsList refreshKey={refreshKey} />
          <RebatesExplainer />
        </div>
      </main>

      <footer className="border-t border-card-border mt-12">
        <div className="max-w-7xl mx-auto px-4 py-4 text-[10px] text-muted">
          Predacy Liquidity Stack · Tier 0 LMSR · Tier 1 Blind LP · Tier 2
          Maker Rebates · See <Link href="/docs/LIQUIDITY.md" className="text-accent hover:underline">design doc</Link>
        </div>
      </footer>
    </div>
  );
}

function StackStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="border border-card-border bg-card p-3">
      <p className="text-[9px] tracking-widest uppercase text-muted">{label}</p>
      <p className="text-text font-mono text-[16px] mt-1 truncate">{value}</p>
      {hint && <p className="text-[9px] text-muted-dim mt-1">{hint}</p>}
    </div>
  );
}

function LiquidityStackBreakdown({ event }: { event: EventDescriptor | null }) {
  if (!event) return null;
  return (
    <div className="border border-card-border bg-card p-4 space-y-3">
      <p className="text-[11px] tracking-widest uppercase text-accent">
        Event parameters
      </p>
      <div className="grid grid-cols-2 gap-3 text-[10px]">
        <ParamRow label="Graduation threshold" value={`$${formatUsdc6(event.graduationThresholdUsdc)} × ${event.graduationBatches} batches`} />
        <ParamRow label="Bootstrap seed" value={`$${formatUsdc6(event.bootstrapSeedUsdc)}`} />
        <ParamRow label="Taker fee" value={`${event.feeBpsTaker / 100}%`} />
        <ParamRow
          label="Fee split"
          value={`${event.feeBpsTreasury / 100}% treasury · ${event.feeBpsRebates / 100}% LP rebates`}
        />
      </div>
      <p className="text-[10px] text-muted-dim leading-snug">
        {event.graduated
          ? "Tier 1 backstop active — your deposit absorbs residual imbalance from each settled batch."
          : "Pre-graduation — Tier 0 LMSR curve fills cold-start residuals. Your deposit will activate once the event hits its graduation gate."}
      </p>
    </div>
  );
}

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] tracking-widest uppercase text-muted">{label}</p>
      <p className="font-mono text-text mt-0.5">{value}</p>
    </div>
  );
}

function RebatesExplainer() {
  return (
    <div className="border border-card-border bg-card-elevated p-4 space-y-2">
      <p className="text-[11px] tracking-widest uppercase text-accent">
        How earnings work
      </p>
      <ul className="text-[10px] text-muted space-y-1.5 leading-snug list-none">
        <li>
          <span className="text-accent">·</span> Every batch under your event
          pays takers a fee. Of that, the rebate slice goes into the per-event
          rebate pool.
        </li>
        <li>
          <span className="text-accent">·</span> If the batch has residual
          imbalance after pair-matching, your vault absorbs it at the
          clearing price — directional exposure, hedged via Polymarket on
          mainnet.
        </li>
        <li>
          <span className="text-accent">·</span> At commitment expiry, your
          payout is your share-pro-rata of the vault's NAV (deposit ± P&L
          ± accrued rebates).
        </li>
        <li>
          <span className="text-accent">·</span> Blind mode keeps your
          individual share count FHE-encrypted on-chain. Aggregate stays
          public for transparency.
        </li>
      </ul>
    </div>
  );
}
