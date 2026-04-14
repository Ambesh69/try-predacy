"use client";

import { useState, useEffect, useMemo, use } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import dynamic from "next/dynamic";
import { usePrivy } from "@privy-io/react-auth";
import { Liveline } from "liveline";
import WalletButton from "@/components/WalletButton";

const FaucetButton = dynamic(() => import("@/components/FaucetButton"), { ssr: false });
import PriceChart from "@/components/PriceChart";
import OrderbookPanel from "@/components/OrderbookPanel";
import PositionsPanel from "@/components/PositionsPanel";
import BatchTimer from "@/components/BatchTimer";
import { OrderForm } from "@/components/OrderForm";
import type { Market, PolyEvent } from "@/lib/polymarket";
import { getRelayerUrl } from "@/lib/relayerUrl";
import { filterAndDeduplicateMarkets, outcomeLabel, fmtPct, fmtCents } from "@/lib/marketUtils";

function formatVolume(vol: number | string): string {
  const n = typeof vol === "string" ? parseFloat(vol) : vol;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function parseField(v: any) {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

function normalizeMarket(m: any): Market {
  return {
    ...m,
    outcomePrices: parseField(m.outcomePrices) ?? [],
    outcomes:      parseField(m.outcomes)      ?? [],
    tokens:        parseField(m.tokens)        ?? [],
    tags:          parseField(m.tags)          ?? [],
    clobTokenIds:  parseField(m.clobTokenIds)  ?? [],
  };
}

function getTokenId(m: Market): string | undefined {
  return m.clobTokenIds?.[0] ?? m.tokens?.[0]?.token_id;
}

// Multi-outcome Liveline chart
const OUTCOME_COLORS = ["#00FFB3", "#4D83FF", "#FFB800", "#FF6B35"];

type Interval = "6h" | "1d" | "1w" | "max";
const INTERVALS: { label: string; value: Interval; fidelity: number }[] = [
  { label: "6H",  value: "6h",  fidelity: 10 },
  { label: "1D",  value: "1d",  fidelity: 60 },
  { label: "1W",  value: "1w",  fidelity: 240 },
  { label: "ALL", value: "max", fidelity: 1440 },
];

const WINDOW_SECS: Partial<Record<Interval, number>> = {
  "6h": 6  * 3_600,
  "1d": 24 * 3_600,
  "1w": 7  * 86_400,
};

interface ChartLine { marketId: string; name: string; color: string; pts: Array<{ t: number; p: number }>; }

function MultiOutcomeChart({ markets, selectedMarketId }: { markets: Market[]; selectedMarketId?: string }) {
  const [iv, setIv] = useState<Interval>("max");
  const [lines, setLines] = useState<ChartLine[]>([]);
  const [loading, setLoading] = useState(true);

  const sortedMarkets = filterAndDeduplicateMarkets(markets)
    .filter((m) => !!getTokenId(m))
    .sort((a, b) => parseFloat(b.outcomePrices?.[0] ?? "0") - parseFloat(a.outcomePrices?.[0] ?? "0"));
  const selectedMkt = selectedMarketId
    ? sortedMarkets.find((m) => m.conditionId === selectedMarketId)
    : undefined;
  const chartMarkets = selectedMkt && !sortedMarkets.slice(0, 4).some((m) => m.conditionId === selectedMkt.conditionId)
    ? [selectedMkt, ...sortedMarkets.filter((m) => m.conditionId !== selectedMkt.conditionId).slice(0, 3)]
    : sortedMarkets.slice(0, 4);
  const marketKey = chartMarkets.map((m) => getTokenId(m) ?? m.conditionId).join(",");

  useEffect(() => {
    if (chartMarkets.length === 0) { setLoading(false); return; }
    setLoading(true);
    const fidelity = INTERVALS.find((i) => i.value === iv)?.fidelity ?? 60;
    Promise.all(
      chartMarkets.map((m, idx) =>
        fetch(`/api/prices?token_id=${encodeURIComponent(getTokenId(m)!)}&interval=${iv}&fidelity=${fidelity}`)
          .then((r) => r.json())
          .then((d) => ({
            marketId: m.conditionId,
            name: outcomeLabel(m), color: OUTCOME_COLORS[idx],
            pts: (d.history ?? []).filter((p: any) => typeof p.p === "number" && p.p > 0),
          }))
          .catch(() => ({ marketId: m.conditionId, name: outcomeLabel(m), color: OUTCOME_COLORS[idx], pts: [] as Array<{ t: number; p: number }> })),
      ),
    )
      .then((results) => setLines(results.filter((r) => r.pts.length >= 2)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iv, marketKey, selectedMarketId]);

  return (
    <div className="border-b border-border">
      {/* Legend */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 gap-3">
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          {(lines.length > 0 ? lines : chartMarkets.map((m, i) => ({ marketId: m.conditionId, name: outcomeLabel(m), color: OUTCOME_COLORS[i], pts: [] as ChartLine["pts"] }))).map((l, i) => {
            const lastP = l.pts[l.pts.length - 1]?.p ?? 0;
            const isSelected = !!selectedMarketId && l.marketId === selectedMarketId;
            return (
              <div key={i} className="flex items-center gap-1.5 flex-shrink-0">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: l.color }} />
                <span className={clsx("text-[11px] truncate max-w-[160px]", isSelected ? "text-text" : "text-text/70")}>{l.name}</span>
                <span className="text-[11px] font-bold tabular-nums" style={{ color: l.color }}>{fmtPct(lastP)}</span>
              </div>
            );
          })}
          {loading && <div className="w-2 h-2 border border-muted/40 border-t-transparent rounded-full animate-spin flex-shrink-0" />}
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {INTERVALS.map(({ label, value }) => (
            <button key={value} onClick={() => setIv(value)}
              className={clsx("text-[10px] px-1.5 py-0.5 tracking-widest transition-colors",
                iv === value ? "text-accent border border-accent/30 bg-accent/5" : "text-muted-dim hover:text-muted"
              )}>{label}</button>
          ))}
        </div>
      </div>

      {/* Liveline chart */}
      <div className="pt-0.5 pb-1 px-1" style={{ height: 330 }}>
        <Liveline
          data={lines[0]?.pts.map((p) => ({ time: p.t, value: p.p })) ?? []}
          value={lines[0]?.pts.at(-1)?.p ?? 0}
          series={lines.map((l) => ({
            id:    l.marketId,
            data:  l.pts.map((p) => ({ time: p.t, value: p.p })),
            value: l.pts.at(-1)?.p ?? 0,
            color: l.color,
          }))}
          seriesToggleCompact
          window={(() => {
            if (iv !== "max") return WINDOW_SECS[iv];
            const nowSec = Date.now() / 1000;
            let minT = nowSec;
            for (const l of lines) {
              if (l.pts.length > 0 && l.pts[0].t < minT) minT = l.pts[0].t;
            }
            return Math.ceil((nowSec - minT) * 1.05) || 7 * 86_400;
          })()}
          theme="dark"
          grid
          scrub
          loading={loading}
          emptyText="NO PRICE HISTORY"
          formatValue={(v: number) => `${Math.round(v * 100)}%`}
          formatTime={(t: number) => {
            const d = new Date(t * 1000);
            if (iv === "6h" || iv === "1d") {
              return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
            }
            if (iv === "1w") {
              return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
            }
            return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          }}
          style={{ height: "290px" }}
        />
      </div>
    </div>
  );
}

export default function EventPageClient({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = usePrivy();
  const solanaWallet = user?.linkedAccounts?.find((a: any) => a.type === "wallet" && a.chainType === "solana") as any;
  const walletAddress = solanaWallet?.address ?? user?.wallet?.address;
  const [event, setEvent] = useState<PolyEvent | null>(null);
  const [eventLoading, setEventLoading] = useState(true);
  const [selectedMarket, setSelectedMarket] = useState<Market | null>(null);
  const [leftTab, setLeftTab] = useState<"outcomes" | "orderbook">("outcomes");
  const [rightTab, setRightTab] = useState<"order" | "positions">("order");
  const [batchActive, setBatchActive] = useState(false);
  const [batch, setBatch] = useState({ batchId: 0n, openedAt: Math.floor(Date.now() / 1000) - 8, batchWindow: 30, commitmentCount: 0, totalDeposited: 0n, status: 0, clearingPrice: 0n });

  // Fetch event data
  useEffect(() => {
    fetch(`/api/events?limit=100`)
      .then((r) => r.json())
      .then((events) => {
        const raw = (events ?? []).find((e: any) => e.id === id);
        if (!raw) { setEventLoading(false); return; }
        const rawTags: any[] = parseField(raw.tags) ?? [];
        const tags: string[] = rawTags.map((t: any) =>
          typeof t === "string" ? t : (t?.label ?? t?.id ?? String(t))
        );
        const parsed: PolyEvent = {
          ...raw,
          tags,
          category: raw.category ?? (tags[0] || undefined),
          volumeNum: raw.volumeNum != null ? Number(raw.volumeNum) : parseFloat(String(raw.volume ?? "0")) || 0,
          markets: (raw.markets ?? []).map(normalizeMarket),
        };
        setEvent(parsed);
        // Auto-select first outcome
        const filtered = filterAndDeduplicateMarkets(parsed.markets)
          .sort((a, b) => parseFloat(b.outcomePrices?.[0] ?? "0") - parseFloat(a.outcomePrices?.[0] ?? "0"));
        if (filtered.length > 0) setSelectedMarket(filtered[0]);
      })
      .catch(() => {})
      .finally(() => setEventLoading(false));
  }, [id]);

  // Poll batch status
  useEffect(() => {
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl || !selectedMarket) return;
    const poll = async () => {
      try {
        const res = await fetch(`${relayerUrl}/batch-status?marketId=${selectedMarket.conditionId}`);
        if (res.ok) {
          const data = await res.json();
          setBatchActive(true);
          setBatch((prev) => ({
            ...prev,
            batchId: data.currentBatchId ? BigInt(data.currentBatchId) : prev.batchId,
            commitmentCount: data.orderCount ?? 0,
            status: data.processingBatch ? 1 : 0,
            totalDeposited: data.batchRunningUsd ? BigInt(data.batchRunningUsd) : prev.totalDeposited,
            openedAt: data.openedAt ?? prev.openedAt,
          }));
        } else {
          setBatchActive(false);
        }
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => clearInterval(iv);
  }, [selectedMarket]);

  if (eventLoading) {
    return <div className="min-h-screen flex items-center justify-center"><div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" /></div>;
  }
  if (!event) {
    return <div className="min-h-screen flex flex-col items-center justify-center gap-4"><p className="text-muted text-sm">Event not found.</p><Link href="/" className="text-accent text-xs tracking-widest hover:underline">← MARKETS</Link></div>;
  }

  const sorted = filterAndDeduplicateMarkets(event.markets).sort(
    (a, b) => parseFloat(b.outcomePrices?.[0] ?? "0") - parseFloat(a.outcomePrices?.[0] ?? "0"),
  );
  const volume = event.volumeNum ?? parseFloat(event.volume ?? "0");
  const selYesPrice = selectedMarket ? parseFloat(selectedMarket.outcomePrices?.[0] ?? "0") : 0;
  const selNoPriceRaw = selectedMarket ? parseFloat(selectedMarket.outcomePrices?.[1] ?? "0") : 0;
  const selNoPrice = selNoPriceRaw >= 0.999 ? (1 - selNoPriceRaw) : selNoPriceRaw;
  const selYesProb = Math.round(selYesPrice * 100);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-1.5 text-muted hover:text-text transition-colors text-[11px] tracking-widest uppercase">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Markets
          </Link>
          <span className="text-border">|</span>
          <Link href="/" className="text-xl font-black tracking-tight text-text" style={{ fontFamily: "var(--font-display)" }}>PREDACY</Link>
        </div>
        <div className="flex items-center gap-3">
          <FaucetButton />
          <WalletButton />
        </div>
      </header>

      {/* Event title + selected outcome */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          {event.category && <span className="text-[10px] text-muted tracking-widest uppercase border border-border px-2 py-0.5">{event.category}</span>}
          {event.endDate && <span className="text-[10px] text-muted">Ends {formatDate(event.endDate)}</span>}
          <span className="text-[11px] text-muted ml-auto tabular-nums">{formatVolume(volume)} vol</span>
        </div>
        <h1 className="text-xl font-black text-text tracking-tight leading-snug" style={{ fontFamily: "var(--font-display)" }}>{event.title}</h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5 border border-border bg-surface/35 px-3 py-2">
          <span className="text-[10px] text-muted tracking-widest uppercase">Selected</span>
          <span className="text-sm font-bold text-text">{selectedMarket ? outcomeLabel(selectedMarket) : "Select an outcome"}</span>
          {selectedMarket && (
            <>
              <span className="text-muted">•</span>
              <span className="text-sm font-black text-text tabular-nums" style={{ fontFamily: "var(--font-display)" }}>{selYesProb}% chance</span>
              <span className="text-muted">•</span>
              <span className="text-[11px] text-accent tabular-nums">YES {fmtCents(selYesPrice)}</span>
              <span className="text-[11px] text-danger tabular-nums">NO {fmtCents(selNoPrice)}</span>
            </>
          )}
        </div>
      </div>

      {/* Main layout */}
      <div className="flex flex-1 min-h-0 flex-col xl:flex-row xl:divide-x xl:divide-border">
        {/* Left column: chart + outcome list */}
        <div className="flex-1 flex flex-col min-h-[320px] min-w-0">
          {leftTab === "outcomes" && <MultiOutcomeChart markets={event.markets} selectedMarketId={selectedMarket?.conditionId} />}

          {/* Tabs */}
          <div className="px-5 py-2.5 border-b border-border flex items-center justify-between flex-shrink-0">
            <span className="text-[10px] text-muted tracking-widest uppercase">{sorted.length} Outcomes</span>
            <div className="flex border border-border text-[10px] tracking-widest uppercase">
              <button onClick={() => setLeftTab("outcomes")}
                className={clsx("px-3 py-1 transition-colors", leftTab === "outcomes" ? "text-text bg-surface/60" : "text-muted-dim hover:text-muted")}>
                Outcomes
              </button>
              <button onClick={() => setLeftTab("orderbook")}
                className={clsx("px-3 py-1 border-l border-border transition-colors", leftTab === "orderbook" ? "text-text bg-surface/60" : "text-muted-dim hover:text-muted")}>
                Orderbook
              </button>
            </div>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto flex flex-col">
            {leftTab === "orderbook" ? (
              <OrderbookPanel market={selectedMarket} />
            ) : (
              <div className="divide-y divide-border/40">
                {sorted.map((market, idx) => {
                  const yp = parseFloat(market.outcomePrices?.[0] ?? "0");
                  const np = parseFloat(market.outcomePrices?.[1] ?? "0");
                  const prob = Math.round(yp * 100);
                  const bar = prob > 60 ? "#00FFB3" : prob < 20 ? "#FF3355" : "#4D83FF";
                  const sel = selectedMarket?.conditionId === market.conditionId;
                  const npDisplay = np >= 0.999 ? (1 - np) : np;

                  return (
                    <div key={market.conditionId}
                      onClick={() => setSelectedMarket(market)}
                      className={clsx(
                        "flex items-center gap-3 px-5 py-3 cursor-crosshair transition-colors group border-l-2",
                        sel ? "bg-surface/70 border-l-accent shadow-[inset_0_0_0_1px_rgba(78,163,255,0.22)]" : "border-l-transparent hover:bg-white/[0.02]",
                      )}>
                      <span className="text-[10px] text-muted-dim w-4 flex-shrink-0 tabular-nums text-right">{idx + 1}</span>
                      <div className={clsx("w-1 h-6 rounded-full flex-shrink-0 transition-all", sel ? "opacity-100" : "opacity-0")} style={{ background: bar }} />
                      <div className="flex flex-col flex-1 min-w-0">
                        <span className={clsx("text-sm truncate transition-colors", sel ? "text-text" : "text-text/70 group-hover:text-text/90")}>{outcomeLabel(market)}</span>
                        <span className="text-[10px] text-muted-dim tabular-nums">{formatVolume(market.volumeNum || parseFloat(market.volume ?? "0"))} vol</span>
                      </div>
                      <div className="w-20 h-[2px] bg-border rounded-full overflow-hidden flex-shrink-0 hidden sm:block">
                        <div className="h-full rounded-full" style={{ width: `${Math.max(prob, 1)}%`, background: bar }} />
                      </div>
                      <span className="text-sm font-black tabular-nums w-9 text-right flex-shrink-0" style={{ fontFamily: "var(--font-display)", color: bar }}>{fmtPct(yp)}</span>
                      <div className="hidden lg:flex items-center gap-1 flex-shrink-0">
                        <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums" style={{ borderColor: "#00FFB330", color: "#00FFB3", background: "#00FFB305" }}>{fmtCents(yp)}</span>
                        <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums" style={{ borderColor: "#FF335530", color: "#FF3355", background: "#FF335505" }}>{fmtCents(npDisplay)}</span>
                      </div>
                      <svg className={clsx("w-3 h-3 flex-shrink-0 transition-colors", sel ? "text-accent" : "text-muted-dim group-hover:text-muted")}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Trade panel */}
        <div className="w-full xl:w-[380px] xl:flex-shrink-0 flex flex-col overflow-hidden border-t border-border xl:border-t-0">
          {selectedMarket ? (
            <>
              <div className="px-4 py-3 border-b border-border bg-surface/20">
                <div className="flex items-center gap-2 mb-2">
                  <label className="text-[10px] text-muted tracking-widest uppercase">Outcome</label>
                </div>
                <select value={selectedMarket.conditionId}
                  onChange={(e) => { const next = sorted.find((m) => m.conditionId === e.target.value); if (next) setSelectedMarket(next); }}
                  className="w-full bg-surface border border-border text-[12px] text-text px-2.5 py-2 focus:outline-none focus:border-border-bright">
                  {sorted.map((m) => <option key={m.conditionId} value={m.conditionId}>{outcomeLabel(m)}</option>)}
                </select>
              </div>
              {/* Order / Positions tabs */}
              <div className="flex border-b border-border">
                <button onClick={() => setRightTab("order")}
                  className={clsx("flex-1 px-3 py-2.5 text-[11px] tracking-widest uppercase transition-colors border-b-2",
                    rightTab === "order" ? "border-accent/50 text-text bg-accent/5" : "border-transparent text-muted hover:text-text"
                  )}>Order</button>
                <button onClick={() => setRightTab("positions")}
                  className={clsx("flex-1 px-3 py-2.5 text-[11px] tracking-widest uppercase transition-colors border-b-2",
                    rightTab === "positions" ? "border-accent/50 text-text bg-accent/5" : "border-transparent text-muted hover:text-text"
                  )}>My Positions</button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {rightTab === "positions" ? (
                  walletAddress ? (
                    <PositionsPanel walletAddress={walletAddress} marketId={selectedMarket.conditionId} />
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-3 p-6">
                      <p className="text-muted text-xs text-center">Connect wallet to view positions</p>
                    </div>
                  )
                ) : (
                  <OrderForm
                    marketId={selectedMarket.conditionId}
                    marketQuestion={outcomeLabel(selectedMarket)}
                    yesPrice={selYesPrice}
                    noPrice={selNoPrice}
                  />
                )}
              </div>
              {/* Mini batch timer */}
              <div className="border-t border-border px-4 py-3 bg-surface/20">
                {batchActive ? (
                  <BatchTimer
                    openedAt={batch.openedAt} batchWindow={batch.batchWindow}
                    commitmentCount={batch.commitmentCount} totalDeposited={batch.totalDeposited}
                    batchId={batch.batchId} status={batch.status} clearingPrice={batch.clearingPrice}
                    mini
                  />
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="flex-shrink-0 w-16 h-16 border border-border rounded-full flex items-center justify-center">
                      <span className="text-muted-dim text-[10px] tracking-widest">—</span>
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted tracking-widest uppercase">No active batch</span>
                      <p className="text-[9px] text-muted-dim">Place an order to start a batch</p>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
              <p className="text-muted text-xs tracking-widest uppercase">Select an outcome to trade</p>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-2 flex items-center justify-between bg-surface/30 flex-shrink-0">
        <span className="text-[9px] text-muted-dim tracking-widest uppercase">Predacy · Dark Pool · Powered by Polymarket Liquidity</span>
        <span className="text-[9px] text-muted-dim"><span className="text-accent/30">●</span> No position info leaks on-chain</span>
      </footer>
    </div>
  );
}
