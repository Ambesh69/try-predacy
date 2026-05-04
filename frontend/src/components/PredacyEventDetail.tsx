"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { clsx } from "clsx";
import {
  type EventDescriptor,
  formatUsdc6,
  getEvent,
  relativeTime,
} from "@/lib/lpApi";

const WalletButton = dynamic(() => import("@/components/WalletButton"), { ssr: false });
const HeaderBalance = dynamic(() => import("@/components/HeaderBalance"), { ssr: false });

interface Props {
  params: Promise<{ handleId: string }>;
}

export default function PredacyEventDetail({ params }: Props) {
  const { handleId } = use(params);
  const [event, setEvent] = useState<EventDescriptor | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const ev = await getEvent(handleId).catch(() => null);
      if (!cancelled) setEvent(ev);
    }
    load();
    return () => { cancelled = true; };
  }, [handleId]);

  if (event === undefined) {
    return <PageShell><CenteredNotice>Loading event…</CenteredNotice></PageShell>;
  }
  if (event === null) {
    return (
      <PageShell>
        <CenteredNotice>
          Event handle <code className="text-accent font-mono">{handleId.slice(0, 12)}…</code> not registered.{" "}
          <Link href="/" className="text-accent hover:underline">Back to markets</Link>
        </CenteredNotice>
      </PageShell>
    );
  }

  const closesIn = event.closesAt - Math.floor(Date.now() / 1000);
  const isExpired = closesIn <= 0;
  const display = event.label ?? `Event ${event.handleId.slice(0, 8)}…`;

  return (
    <PageShell>
      <section className="border-b border-card-border bg-bg-elevated">
        <div className="max-w-7xl mx-auto px-4 py-8 flex flex-col md:flex-row md:items-end md:justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Link href="/" className="text-[11px] text-muted hover:text-text tracking-widest uppercase">
                ← Markets
              </Link>
              <span className="text-muted-dim">·</span>
              <span className="text-[11px] tracking-widest uppercase text-accent">Predacy event</span>
            </div>
            <h1 className="text-[28px] md:text-[36px] font-bold text-text font-mono">
              {display}
            </h1>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <Tag>{event.category}</Tag>
              {event.graduated ? (
                <Tag variant="accent">TIER 1 ACTIVE</Tag>
              ) : (
                <Tag variant="muted">PRE-GRAD</Tag>
              )}
              <span className={clsx(
                "text-[11px]",
                isExpired ? "text-danger" : "text-muted",
              )}>
                {isExpired ? "Closed" : `Closes ${relativeTime(event.closesAt)}`}
              </span>
            </div>
          </div>
          <Link
            href="/lp"
            className="border border-accent text-accent px-4 py-2.5 text-[11px] tracking-widest uppercase font-bold hover:bg-accent/5 transition-colors self-start md:self-end"
          >
            Provide Liquidity →
          </Link>
        </div>
      </section>

      <main className="max-w-7xl mx-auto px-4 py-8 grid lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-4">
          <SectionHeader>
            Markets <span className="text-muted-dim ml-1">({event.marketIds?.length ?? 0})</span>
          </SectionHeader>
          {(!event.marketIds || event.marketIds.length === 0) ? (
            <div className="border border-card-border bg-card p-6 text-center">
              <p className="text-[13px] text-text">No markets attached to this event yet.</p>
              <p className="text-[11px] text-muted-dim mt-2 max-w-md mx-auto">
                An operator can attach Polymarket-mirrored markets via the relayer&apos;s{" "}
                <code className="text-accent">POST /events/{event.handleId.slice(0, 8)}…/markets</code>{" "}
                endpoint. Once attached, takers can trade under this event&apos;s sealed-bid batch auction.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {event.marketIds.map((id) => (
                <MarketCard
                  key={id}
                  marketId={id}
                  label={event.marketLabels?.[id]}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <SectionHeader>Event parameters</SectionHeader>
          <div className="border border-card-border bg-card p-4 space-y-3 text-[11px]">
            <ParamRow
              label="Cumulative volume"
              value={`$${formatUsdc6(event.cumulativeVolumeUsdc, 2)}`}
            />
            <ParamRow label="Taker fee" value={`${event.feeBpsTaker / 100}%`} />
            <ParamRow
              label="Fee split"
              value={`${event.feeBpsTreasury / 100}% treasury · ${event.feeBpsRebates / 100}% rebates`}
            />
            <ParamRow
              label="Graduation gate"
              value={`$${formatUsdc6(event.graduationThresholdUsdc, 0)} × ${event.graduationBatches}`}
              hint={event.graduated
                ? "Tier 1 backstop active — LP vault absorbs residual"
                : "Pre-grad — Tier 0 LMSR fills cold-start"}
            />
            <ParamRow
              label="Bootstrap seed"
              value={`$${formatUsdc6(event.bootstrapSeedUsdc, 0)}`}
            />
            <ParamRow
              label="Handle id"
              value={event.handleId.slice(0, 16) + "…"}
              monospace
            />
          </div>

          <SectionHeader>How it works</SectionHeader>
          <div className="border border-card-border bg-card-elevated p-4 text-[10px] text-muted leading-snug space-y-1.5">
            <p><span className="text-accent">·</span> Each market under this event clears in 30s sealed-bid batches.</p>
            <p><span className="text-accent">·</span> Taker fees feed the per-event rebate pool ({event.feeBpsRebates / 100}% slice).</p>
            <p><span className="text-accent">·</span> LP capital absorbs residual imbalance after pair-matching.</p>
            <p><span className="text-accent">·</span> Blind LP keeps individual deposits FHE-encrypted on-chain.</p>
          </div>
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

function Tag({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "accent" | "muted";
}) {
  return (
    <span className={clsx(
      "text-[10px] tracking-widest uppercase border px-2 py-0.5",
      variant === "accent" && "border-accent/30 text-accent bg-accent/5",
      variant === "muted" && "border-border-bright text-muted-dim",
      variant === "default" && "border-border-bright text-muted bg-surface/70",
    )}>
      {children}
    </span>
  );
}

function ParamRow({
  label,
  value,
  hint,
  monospace,
}: {
  label: string;
  value: string;
  hint?: string;
  monospace?: boolean;
}) {
  return (
    <div>
      <p className="text-[9px] tracking-widest uppercase text-muted">{label}</p>
      <p className={clsx("text-text mt-0.5", monospace && "font-mono")}>{value}</p>
      {hint && <p className="text-[9px] text-muted-dim mt-0.5 leading-snug">{hint}</p>}
    </div>
  );
}

function MarketCard({ marketId, label }: { marketId: string; label?: string }) {
  // Predacy-native markets default to a 50/50 prior — the actual price
  // emerges from the first sealed-bid batch, not from a Polymarket lookup.
  const display = label ?? `Market ${marketId.slice(0, 8)}…`;

  return (
    <Link href={`/market/predacy/${marketId}`} className="block">
      <div className="border border-card-border bg-card p-4 hover:border-border-bright transition-colors flex flex-col gap-3 cursor-crosshair h-full">
        <h3 className="text-[13px] text-text leading-snug line-clamp-3">
          {display}
        </h3>
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-1">
            <span
              className="text-2xl font-black tabular-nums leading-none"
              style={{ fontFamily: "var(--font-display)", color: "#4EA3FF" }}
            >
              50%
            </span>
            <span className="text-[9px] text-muted tracking-widest uppercase">implied</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums" style={{ borderColor: "#2CE8C655", color: "#52F0D3", background: "#2CE8C612" }}>YES 50¢</span>
            <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums" style={{ borderColor: "#FF5F6D55", color: "#FF7683", background: "#FF5F6D12" }}>NO 50¢</span>
          </div>
        </div>
        <div className="h-[2px] bg-border rounded-full overflow-hidden">
          <div className="h-full transition-all duration-500" style={{ width: "50%", background: "#4EA3FF" }} />
        </div>
        <div className="text-[10px] text-muted-dim tracking-widest uppercase">
          Place sealed bid →
        </div>
      </div>
    </Link>
  );
}
