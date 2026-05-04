"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { getSessionStats, type SessionStatsRecord } from "@/lib/lpApi";

interface Props {
  handleIdHex: string;
}

const POLL_MS = 5_000;

export default function LiveStandingsPanel({ handleIdHex }: Props) {
  const [stats, setStats] = useState<SessionStatsRecord | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const s = await getSessionStats(handleIdHex);
      if (!cancelled) setStats(s);
    }
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [handleIdHex]);

  // Stats are only present for agent-managed sessions. For manually-
  // seeded events (no agent loop), don't render the panel at all.
  if (stats === undefined) return null;
  if (stats === null) return null;

  // Stats keys are lowercase player names. Pair them so we can display
  // title-cased names without losing the link back to the stats record.
  const playerEntries = Object.entries(stats.players).map(([nameKey, p]) => ({
    name: titleCaseName(nameKey),
    p,
  }));
  const sortedByPotWon = [...playerEntries].sort((a, b) => b.p.biggestPotWonUsd - a.p.biggestPotWonUsd);
  const sortedByHandsWon = [...playerEntries].sort((a, b) => b.p.handsWon - a.p.handsWon);
  const sortedByBluffs = [...playerEntries].sort((a, b) => b.p.bluffs - a.p.bluffs);

  const lastUpdate = stats.lastSnapshotAt
    ? `${Math.max(1, Math.floor(Date.now() / 1000) - stats.lastSnapshotAt)}s ago`
    : "no snapshot yet";

  return (
    <div className="border border-card-border bg-card-elevated">
      <div className="flex items-center justify-between border-b border-card-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse inline-block" />
          <span className="text-[11px] tracking-widest uppercase text-accent">Live table state</span>
        </div>
        <span className="text-[10px] text-muted-dim">
          {stats.framesProcessed} frames · updated {lastUpdate}
        </span>
      </div>

      {/* Session-level chips */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-card-border">
        <Chip label="Hands" value={String(stats.handsSeen)} />
        <Chip label="Max pot" value={stats.maxPotSoFar > 0 ? `$${formatBigNumber(stats.maxPotSoFar)}` : "—"} />
        <Chip label="All-ins" value={String(stats.allInsCount)} />
        <Chip label="Quads" value={stats.quadsHit ? "HIT" : "—"} accent={stats.quadsHit} />
        <Chip label="Royal" value={stats.royalFlushHit ? "HIT" : "—"} accent={stats.royalFlushHit} />
      </div>

      {/* Per-player leaderboard */}
      {playerEntries.length > 0 ? (
        <div className="px-4 py-3">
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 gap-y-1 text-[10px]">
            <span className="text-muted tracking-widest uppercase">Player</span>
            <span className="text-muted tracking-widest uppercase text-right">Won</span>
            <span className="text-muted tracking-widest uppercase text-right">Pot best</span>
            <span className="text-muted tracking-widest uppercase text-right">Bluffs</span>
            <span className="text-muted tracking-widest uppercase text-right">All-ins</span>

            {sortedByHandsWon.map(({ name, p }) => {
              const isPotLeader = sortedByPotWon[0]?.p === p && p.biggestPotWonUsd > 0;
              const isBluffLeader = sortedByBluffs[0]?.p === p && p.bluffs > 0;
              const isBust = p.bustedAt !== null;
              return (
                <div key={name} className="contents">
                  <span className={clsx(
                    "text-[12px] font-mono",
                    isBust ? "text-muted-dim line-through" : "text-text",
                  )}>
                    {name}
                  </span>
                  <span className="text-[12px] font-mono tabular-nums text-right text-text">
                    {p.handsWon}
                  </span>
                  <span className={clsx(
                    "text-[12px] font-mono tabular-nums text-right",
                    isPotLeader ? "text-accent" : "text-text",
                  )}>
                    {p.biggestPotWonUsd > 0 ? `$${formatBigNumber(p.biggestPotWonUsd)}` : "—"}
                  </span>
                  <span className={clsx(
                    "text-[12px] font-mono tabular-nums text-right",
                    isBluffLeader ? "text-accent" : "text-text",
                  )}>
                    {p.bluffs}
                  </span>
                  <span className="text-[12px] font-mono tabular-nums text-right text-text">
                    {p.allInsBy}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-[11px] text-muted">
          Waiting for first hand to resolve…
        </div>
      )}
    </div>
  );
}

function Chip({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={clsx(
      "bg-card px-3 py-2.5",
      accent && "bg-accent/5",
    )}>
      <p className="text-[9px] tracking-widest uppercase text-muted">{label}</p>
      <p className={clsx(
        "text-[14px] font-mono tabular-nums mt-0.5",
        accent ? "text-accent" : "text-text",
      )}>
        {value}
      </p>
    </div>
  );
}

function formatBigNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** sessionStats keys players by lowercase name (so `Phil Ivey` and
 *  `phil  ivey` collide). We've lost the original casing — title-case
 *  is a reasonable display fallback. Streamer handles like `xQc` come
 *  out as `Xqc` here, which we'll fix on the backend later by storing
 *  the original-case alongside the canonical key. */
function titleCaseName(lower: string): string {
  return lower.replace(/\b\w/g, (c) => c.toUpperCase());
}
