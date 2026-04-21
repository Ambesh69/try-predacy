"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import EventCard from "@/components/EventCard";
import WalletButton from "@/components/WalletButton";

const FaucetButton = dynamic(() => import("@/components/FaucetButton"), { ssr: false });
const HeaderBalance = dynamic(() => import("@/components/HeaderBalance"), { ssr: false });
import { MOCK_MARKETS, getEvents, type PolyEvent } from "@/lib/polymarket";
import { getRelayerUrl } from "@/lib/relayerUrl";
import {
  filterAndSortEvents,
  type DiscoverySort,
} from "@/lib/discovery";

const TICKER_ITEMS = [
  "SEALED BIDS",
  "BATCH AUCTIONS",
  "ZK PROOFS",
  "DARK ORACLE",
  "UNIFORM CLEARING",
  "NO FRONTRUNNING",
  "PRIVATE POSITIONS",
];

export default function HomePage() {
  const [events, setEvents] = useState<PolyEvent[]>(
    MOCK_MARKETS.map((m) => ({
      id: m.conditionId, title: m.question, volume: m.volume,
      volumeNum: m.volumeNum, active: m.active, closed: m.closed,
      endDate: m.endDate, category: m.category, tags: m.tags, markets: [m],
    }))
  );
  const [loading, setLoading] = useState(true);
  const [liveMarketIds, setLiveMarketIds] = useState<Set<string>>(new Set());
  const [recentlyLiveEventIds, setRecentlyLiveEventIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<DiscoverySort>("volume_desc");
  const prevLiveMarketIdsRef = useRef<Set<string>>(new Set());
  const shimmerTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) return;
    (async () => {
      try {
        const res = await fetch(`${relayerUrl}/health`);
        if (!res.ok) return;
        const data = await res.json();
        const ids = new Set<string>(Object.keys(data.markets ?? {}));
        setLiveMarketIds(ids);
      } catch { /* non-fatal */ }
    })();
  }, []);

  useEffect(() => {
    getEvents(50)
      .then((fetched) => {
        if (liveMarketIds.size > 0) {
          const live: PolyEvent[] = [];
          const rest: PolyEvent[] = [];
          for (const e of fetched) {
            if (e.markets.some((m) => liveMarketIds.has(m.conditionId.toLowerCase()))) live.push(e);
            else rest.push(e);
          }
          fetched = [...live, ...rest];
        }
        setEvents(fetched);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [liveMarketIds]);

  useEffect(() => {
    if (events.length === 0) return;
    const prev = prevLiveMarketIdsRef.current;
    const next = liveMarketIds;
    const newlyLiveMarketIds = [...next].filter((id) => !prev.has(id));
    if (newlyLiveMarketIds.length > 0) {
      const newlyLiveEventIds = events
        .filter((e) => e.markets.some((m) => newlyLiveMarketIds.includes(m.conditionId.toLowerCase())))
        .map((e) => e.id);
      if (newlyLiveEventIds.length > 0) {
        setRecentlyLiveEventIds((curr) => {
          const updated = new Set(curr);
          for (const id of newlyLiveEventIds) updated.add(id);
          return updated;
        });
        for (const id of newlyLiveEventIds) {
          const existing = shimmerTimersRef.current.get(id);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            setRecentlyLiveEventIds((curr) => { const u = new Set(curr); u.delete(id); return u; });
            shimmerTimersRef.current.delete(id);
          }, 20000);
          shimmerTimersRef.current.set(id, timer);
        }
      }
    }
    prevLiveMarketIdsRef.current = new Set(next);
  }, [events, liveMarketIds]);

  useEffect(() => {
    const timers = shimmerTimersRef.current;
    return () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); };
  }, []);

  const displayedEvents = useMemo(() => {
    return filterAndSortEvents(events, { q: searchQuery, sort: sortBy });
  }, [events, searchQuery, sortBy]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Ticker tape */}
      <div className="border-b border-border overflow-hidden py-2 bg-surface/45">
        <div className="flex ticker-content gap-8">
          {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
            <span key={i} className="text-[10px] text-muted tracking-widest uppercase whitespace-nowrap flex items-center gap-2">
              <span className="text-accent/50">◆</span>
              {item}
            </span>
          ))}
        </div>
      </div>

      {/* Header */}
      <header className="border-b border-border px-4 md:px-6 py-4 md:py-[22px] flex flex-col md:flex-row md:items-end md:justify-between gap-4 bg-surface/25 backdrop-blur-[2px]">
        <div>
          <h1 className="text-[2rem] md:text-[2.65rem] font-black tracking-tight leading-none text-text glow-blue"
            style={{ fontFamily: "var(--font-display)" }}>PREDACY</h1>
          <p className="text-muted text-[10px] md:text-xs tracking-widest mt-1">
            <span className="hidden sm:inline">DARK POOL PREDICTION MARKETS · </span>
            <span className="text-accent/70">SEALED-BID BATCH AUCTIONS</span>
          </p>
        </div>
        <div className="flex items-center gap-2 md:gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 border border-border-bright bg-surface px-3 py-1.5 shadow-[0_0_0_1px_rgba(78,163,255,0.12)]">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="text-[11px] text-muted tracking-widest">SOLANA</span>
          </div>
          <HeaderBalance />
          <FaucetButton />
          <WalletButton />
        </div>
      </header>

      {/* Hero section */}
      <section className="border-b border-border px-4 md:px-6 py-9 grid grid-cols-1 md:grid-cols-3 gap-0 bg-surface/[0.18]">
        <div className="md:col-span-2 pr-0 md:pr-8 md:border-r border-border pb-6 md:pb-0">
          <p className="text-muted text-[11px] tracking-widest uppercase mb-3">How it works</p>
          <div className="flex flex-col gap-2">
            {[
              { n: "01", label: "SEAL", desc: "Submit a cryptographic commitment — your order details are encrypted" },
              { n: "02", label: "BATCH", desc: "All orders accumulate privately for 30 seconds" },
              { n: "03", label: "CLEAR", desc: "A ZK proof computes the single uniform clearing price" },
              { n: "04", label: "SETTLE", desc: "Net position settles on Solana — only aggregate visible" },
            ].map(({ n, label, desc }) => (
              <div key={n} className="flex items-start gap-4 group">
                <span className="text-[10px] text-muted-dim mt-0.5 w-4 flex-shrink-0">{n}</span>
                <div>
                  <span className="text-sm font-black text-text mr-2" style={{ fontFamily: "var(--font-display)" }}>{label}</span>
                  <span className="text-xs text-muted">{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="pl-0 md:pl-8 pt-6 md:pt-0 flex flex-col justify-between">
          <p className="text-muted text-[11px] tracking-widest uppercase mb-3">Protocol Stats</p>
          <div className="space-y-4">
            {[
              { label: "Batch Window", value: "30s", sub: "sealed order window" },
              { label: "Privacy", value: "ZK", sub: "Groth16 proofs" },
              { label: "Chain", value: "Solana", sub: "sub-second finality" },
              { label: "Frontrunning", value: "0%", sub: "uniform clearing price" },
            ].map(({ label, value, sub }) => (
              <div key={label} className="flex items-end justify-between">
                <div>
                  <p className="text-[10px] text-muted uppercase tracking-wider">{label}</p>
                  <p className="text-[11px] text-muted-dim">{sub}</p>
                </div>
                <span className="text-xl font-black text-blue" style={{ fontFamily: "var(--font-display)" }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Market list */}
      <main className="flex-1 px-4 md:px-6 py-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-black text-text tracking-tight" style={{ fontFamily: "var(--font-display)" }}>ACTIVE MARKETS</h2>
            {loading && <div className="w-3 h-3 border border-muted/40 border-t-transparent rounded-full animate-spin" />}
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full lg:w-auto lg:max-w-[560px]">
            <label className="flex items-center border border-border bg-surface px-3 py-2 focus-within:border-border-bright flex-1 min-w-0">
              <svg className="w-3.5 h-3.5 text-muted mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m21 21-4.3-4.3m1.8-5.2a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />
              </svg>
              <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search events, markets, tags..."
                className="w-full bg-transparent text-[13px] text-text placeholder:text-muted-dim focus:outline-none" />
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted tracking-widest uppercase">Sort</span>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as DiscoverySort)}
                className="bg-surface border border-border text-[11px] text-text px-2.5 py-2 focus:outline-none focus:border-border-bright">
                <option value="volume_desc">Highest Volume</option>
                <option value="volume_asc">Lowest Volume</option>
                <option value="ending_soon">Ending Soon</option>
                <option value="newest">Latest Ending</option>
              </select>
            </div>
          </div>
        </div>

        <div className="active-markets-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-px bg-border/90 shadow-[0_0_0_1px_rgba(78,163,255,0.08)]">
          {loading && displayedEvents.length === 0
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={`skel-${i}`} className="bg-bg">
                  <div className="border border-border bg-surface p-5 h-full flex flex-col gap-3 animate-pulse">
                    <div className="flex gap-2">
                      <div className="h-4 w-16 bg-border" />
                      <div className="h-4 w-12 bg-border/60" />
                    </div>
                    <div className="h-4 w-4/5 bg-border/80" />
                    <div className="h-4 w-3/5 bg-border/50" />
                    <div className="flex items-end justify-between gap-3 pt-2">
                      <div className="h-8 w-16 bg-border" />
                      <div className="flex gap-1.5">
                        <div className="h-6 w-14 bg-border/60" />
                        <div className="h-6 w-14 bg-border/60" />
                      </div>
                    </div>
                    <div className="h-[2px] w-full bg-border" />
                    <div className="flex items-center justify-between pt-1">
                      <div className="h-3 w-16 bg-border/60" />
                      <div className="h-3 w-20 bg-border/40" />
                    </div>
                  </div>
                </div>
              ))
            : displayedEvents.map((event, idx) => {
                const shouldShimmer = idx < 2 || recentlyLiveEventIds.has(event.id);
                return (
                  <div key={event.id} className={`bg-bg ${shouldShimmer ? "shimmer-card" : ""}`}>
                    <EventCard event={event} liveMarketIds={liveMarketIds} />
                  </div>
                );
              })}
        </div>
        {!loading && displayedEvents.length === 0 && (
          <div className="mt-3 border border-border bg-surface/25 px-4 py-6 text-center">
            <p className="text-sm text-muted">No markets match your filters.</p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border px-4 md:px-6 py-4 flex items-center justify-between bg-surface/30">
        <span className="text-[10px] text-muted-dim tracking-widest uppercase">
          Predacy · Private Prediction Markets · Powered by Solana
        </span>
        <span className="text-[10px] text-muted-dim">
          <span className="text-accent/30">●</span> No position info leaks on-chain
        </span>
      </footer>
    </div>
  );
}
