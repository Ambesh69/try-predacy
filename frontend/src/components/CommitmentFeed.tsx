"use client";

import { useState, useEffect, useRef } from "react";
import { clsx } from "clsx";

interface CommitmentEntry {
  hash: `0x${string}`;
  amount?: bigint;
  trader?: `0x${string}`;
  timestamp: number;
  isBuy?: boolean;
}

interface CommitmentFeedProps {
  entries: CommitmentEntry[];
  myAddress?: string;
}

const CRYPTO_CHARS = "0123456789abcdef";

function useScramble(value: string, duration = 600): string {
  const [display, setDisplay] = useState(value);
  const frameRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let frame = 0;
    const totalFrames = Math.floor(duration / 40);
    if (frameRef.current) clearInterval(frameRef.current);
    frameRef.current = setInterval(() => {
      frame++;
      if (frame >= totalFrames) {
        setDisplay(value);
        if (frameRef.current) clearInterval(frameRef.current);
        return;
      }
      const progress = frame / totalFrames;
      const revealedChars = Math.floor(progress * value.length);
      const scrambled = value
        .split("")
        .map((char, i) => {
          if (i < revealedChars) return char;
          if (char === "x" || char === "0") return char;
          return CRYPTO_CHARS[Math.floor(Math.random() * CRYPTO_CHARS.length)];
        })
        .join("");
      setDisplay(scrambled);
    }, 40);
    return () => { if (frameRef.current) clearInterval(frameRef.current); };
  }, [value, duration]);

  return display;
}

function HashEntry({ entry, isMe }: { entry: CommitmentEntry; isMe: boolean }) {
  const shortHash = entry.hash.slice(0, 18) + "…" + entry.hash.slice(-6);
  const shortTrader = entry.trader
    ? entry.trader.slice(0, 6) + "…" + entry.trader.slice(-4)
    : "0x???…????";
  const scrambledHash = useScramble(shortHash, 800);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={clsx(
        "group flex items-center gap-3 px-3 py-2.5 border-b last:border-b-0",
        "border-border transition-colors duration-150",
        isMe ? "bg-accent/5 hover:bg-accent/8" : "hover:bg-surface",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", {
        "bg-accent animate-pulse": isMe, "bg-muted": !isMe,
      })} />
      <div className="flex-1 min-w-0">
        <span className={clsx("text-xs font-medium", isMe ? "text-accent" : "hash-text")}>{scrambledHash}</span>
        {isMe && <span className="ml-2 text-[10px] text-accent/60 tracking-widest uppercase">you</span>}
      </div>
      <div className="text-right flex-shrink-0">
        {isMe && entry.amount != null ? (
          <span className="text-xs text-accent/80 tabular-nums">
            {entry.isBuy === false
              ? `${(Number(entry.amount) / 1_000_000).toFixed(2)} YES`
              : `$${(Number(entry.amount) / 1_000_000).toFixed(0)}`}
          </span>
        ) : (
          <span className="text-xs text-muted-dim">{hovered ? "???" : "·····"}</span>
        )}
      </div>
      <div className="text-right flex-shrink-0 w-20 hidden sm:block">
        {isMe ? (
          <span className="text-[10px] text-muted">{shortTrader}</span>
        ) : (
          <span className="text-[10px] text-muted-dim">{hovered ? "0x???…????" : shortTrader}</span>
        )}
      </div>
    </div>
  );
}

export default function CommitmentFeed({ entries, myAddress }: CommitmentFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [entries.length]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          <span className="text-[11px] tracking-widest text-muted uppercase">Sealed Orders</span>
        </div>
        <span className="text-[11px] text-muted tabular-nums">{entries.length} committed</span>
      </div>
      <div className="px-3 py-2 border-b border-border bg-surface/50">
        <p className="text-[10px] text-muted-dim leading-relaxed">
          <span className="text-accent/60">//</span> Only commitment hashes are visible on-chain.{" "}
          Amounts and directions are cryptographically hidden until settlement.
        </p>
      </div>
      <div ref={feedRef} className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
            <div className="w-8 h-8 border border-border flex items-center justify-center">
              <div className="w-2 h-2 bg-muted/30" />
            </div>
            <span className="text-muted text-xs tracking-widest uppercase">awaiting orders</span>
          </div>
        ) : (
          <div>
            {entries.map((entry) => (
              <HashEntry key={entry.hash} entry={entry}
                isMe={!!myAddress && !!entry.trader && myAddress.toLowerCase() === entry.trader.toLowerCase()} />
            ))}
          </div>
        )}
      </div>
      {myAddress && entries.find((e) => e.trader && e.trader.toLowerCase() === myAddress.toLowerCase()) && (
        <div className="border-t border-border p-3 space-y-1.5">
          <span className="text-[10px] text-muted-dim tracking-widest uppercase">Privacy Status</span>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-border/30 p-2 rounded-sm">
              <p className="text-[10px] text-muted-dim mb-0.5">others see</p>
              <p className="text-[10px] text-muted hash-text">0x4f2a…c3d1</p>
            </div>
            <div className="bg-accent/5 p-2 rounded-sm border border-accent/20">
              <p className="text-[10px] text-accent/50 mb-0.5">you see</p>
              <p className="text-[10px] text-accent/80">your order ✓</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
