"use client";

import { useState, useEffect, useRef } from "react";
import { clsx } from "clsx";
import type { Market } from "@/lib/polymarket";

interface OrderbookEntry { price: string; size: string; }
interface OrderbookData { bids: OrderbookEntry[]; asks: OrderbookEntry[]; }

const LEVELS = 8;
const REFRESH_MS = 5_000;

function formatPrice(p: number): string { return (p * 100).toFixed(1) + "¢"; }
function formatShares(s: number): string { return s.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function formatUSD(usd: number): string { return "$" + usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function buildRows(raw: { price: number; size: number }[]) {
  let cum = 0;
  return raw.map((r) => { const usd = r.size * r.price; cum += usd; return { ...r, usd, cumUsd: cum }; });
}

export default function OrderbookPanel({ market }: { market: Market | null }) {
  const [data, setData]               = useState<OrderbookData | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [tick, setTick]               = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [ago, setAgo]                 = useState("—");
  const asksRef = useRef<HTMLDivElement>(null);

  const tokenId = market?.clobTokenIds?.[0];

  useEffect(() => {
    if (!tokenId) { setData(null); return; }
    setLoading(true); setError(null);
    fetch(`/api/orderbook?token_id=${encodeURIComponent(tokenId)}`)
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setData(d as OrderbookData); setLastUpdated(new Date()); })
      .catch((e) => setError(e.message ?? "Failed to load"))
      .finally(() => setLoading(false));
  }, [tokenId, tick]);

  useEffect(() => {
    if (!asksRef.current) return;
    asksRef.current.scrollTop = asksRef.current.scrollHeight;
  }, [tokenId, data !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tokenId) return;
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [tokenId]);

  useEffect(() => {
    if (!lastUpdated) return;
    setAgo("just now");
    const id = setInterval(() => {
      const s = Math.round((Date.now() - lastUpdated.getTime()) / 1000);
      setAgo(s < 5 ? "just now" : `${s}s ago`);
    }, 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  if (!market) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 px-6 py-12 text-center">
        <p className="text-[11px] text-muted tracking-widest uppercase">Select an outcome</p>
        <p className="text-[10px] text-muted-dim">Click any outcome to view its live orderbook</p>
      </div>
    );
  }

  if (!tokenId) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 px-6 py-12 text-center">
        <p className="text-[11px] text-muted-dim">Orderbook not available for this market</p>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
          <span className="text-[10px] text-muted tracking-widest uppercase">Loading…</span>
          <div className="w-3 h-3 border border-muted/40 border-t-transparent rounded-full animate-spin" />
        </div>
        <div className="flex-1 flex flex-col gap-px p-3">
          {Array.from({ length: 17 }).map((_, i) => (
            <div key={i} className="h-[26px] bg-surface/50 animate-pulse" style={{ opacity: 0.8 - Math.abs(i - 8) * 0.05 }} />
          ))}
        </div>
      </div>
    );
  }

  const outcomeLabel = market.groupItemTitle ?? market.question ?? "YES";
  const rawBids = (data?.bids ?? []).map((e) => ({ price: parseFloat(e.price), size: parseFloat(e.size) })).filter((e) => e.price > 0 && e.size > 0).sort((a, b) => b.price - a.price).slice(0, LEVELS);
  const rawAsks = (data?.asks ?? []).map((e) => ({ price: parseFloat(e.price), size: parseFloat(e.size) })).filter((e) => e.price > 0 && e.size > 0).sort((a, b) => a.price - b.price).slice(0, LEVELS);
  const bids = buildRows(rawBids);
  const asks = buildRows(rawAsks);

  const maxBidCumUsd = bids[bids.length - 1]?.cumUsd ?? 1;
  const maxAskCumUsd = asks[asks.length - 1]?.cumUsd ?? 1;
  const asksDisplay = [...asks].reverse();

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 1;
  const mid     = (bestBid + bestAsk) / 2;
  const spread  = bestAsk - bestBid;

  const AskRow = ({ ask, i }: { ask: ReturnType<typeof buildRows>[number]; i: number }) => {
    const pct = Math.min((ask.cumUsd / maxAskCumUsd) * 100, 100);
    return (
      <div key={i} className="relative grid grid-cols-[1fr_auto_auto] items-center border-b border-border/10">
        <div className="absolute inset-0 left-auto bg-danger/[0.07]" style={{ width: `${pct}%` }} />
        <span className="relative px-3 py-[5px] text-[11px] font-medium text-danger tabular-nums">{formatPrice(ask.price)}</span>
        <span className="relative pr-4 py-[5px] text-[10px] text-muted tabular-nums text-right">{formatShares(ask.size)}</span>
        <span className="relative pr-3 py-[5px] text-[10px] text-muted-dim tabular-nums text-right w-20">{formatUSD(ask.cumUsd)}</span>
      </div>
    );
  };

  const BidRow = ({ bid, i }: { bid: ReturnType<typeof buildRows>[number]; i: number }) => {
    const pct = Math.min((bid.cumUsd / maxBidCumUsd) * 100, 100);
    return (
      <div key={i} className="relative grid grid-cols-[1fr_auto_auto] items-center border-b border-border/10">
        <div className="absolute inset-0 left-auto bg-accent/[0.07]" style={{ width: `${pct}%` }} />
        <span className="relative px-3 py-[5px] text-[11px] font-medium text-accent tabular-nums">{formatPrice(bid.price)}</span>
        <span className="relative pr-4 py-[5px] text-[10px] text-muted tabular-nums text-right">{formatShares(bid.size)}</span>
        <span className="relative pr-3 py-[5px] text-[10px] text-muted-dim tabular-nums text-right w-20">{formatUSD(bid.cumUsd)}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] text-muted tracking-widest uppercase flex-shrink-0">Orderbook</span>
          <span className="text-[10px] text-muted-dim flex-shrink-0">·</span>
          <span className="text-[10px] text-text truncate">{outcomeLabel} YES</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={clsx("w-1.5 h-1.5 rounded-full transition-colors flex-shrink-0", loading ? "bg-accent animate-pulse" : "bg-accent/50")} />
          <span className="text-[9px] text-muted-dim tabular-nums">{ago}</span>
          <button type="button" onClick={() => setTick((t) => t + 1)} title="Refresh"
            className="text-[13px] text-muted-dim hover:text-muted transition-colors leading-none ml-1">↻</button>
        </div>
      </div>
      {error && <div className="px-4 py-1.5 text-[10px] text-danger border-b border-border/40 flex-shrink-0">{error}</div>}
      <div className="grid grid-cols-[1fr_auto_auto] px-3 py-1.5 border-b border-border/30 flex-shrink-0">
        <span className="text-[9px] text-muted-dim tracking-widest uppercase">Price</span>
        <span className="text-[9px] text-muted-dim tracking-widest uppercase text-right pr-4">Shares</span>
        <span className="text-[9px] text-muted-dim tracking-widest uppercase text-right w-20">Total</span>
      </div>
      <div className="flex-1 flex flex-col min-h-0">
        <div ref={asksRef} className="flex-1 min-h-0 overflow-y-auto">
          {asks.length === 0 && data && (
            <div className="h-full flex items-end justify-center pb-2"><span className="text-[10px] text-muted-dim">No asks</span></div>
          )}
          {asksDisplay.map((ask, i) => <AskRow key={i} ask={ask} i={i} />)}
        </div>
        <div className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-y border-border/40 bg-surface/40">
          <span className="text-[10px] text-muted-dim tabular-nums">
            Spread <span className="text-muted font-medium">{(spread * 100).toFixed(2)}¢</span>
          </span>
          <span className="text-sm font-black tabular-nums" style={{ fontFamily: "var(--font-display)", color: "#4D83FF" }}>{formatPrice(mid)}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {bids.map((bid, i) => <BidRow key={i} bid={bid} i={i} />)}
          {bids.length === 0 && data && (<div className="py-3 text-center"><span className="text-[10px] text-muted-dim">No bids</span></div>)}
          <div className="px-3 py-2.5 flex justify-center">
            <span className="text-[9px] text-muted-dim tracking-widest uppercase">Polymarket CLOB · live · 5s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
