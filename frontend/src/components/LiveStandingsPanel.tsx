"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { getSessionStats, type SessionStatsRecord } from "@/lib/lpApi";

interface Props {
  handleIdHex: string;
  /** Full session lineup parsed from the event's marketLabels. Used to
   *  render rows for every known player even if the gameState OCR
   *  hasn't seen them act yet (otherwise the panel only shows whoever
   *  the OCR happened to attribute a hand/all-in/bust to, which can be
   *  as few as 2 of 9 players in a heavy heads-up early window). */
  lineup: string[];
}

const POLL_MS = 5_000;
/** Beyond this staleness, surface a "stalled" warning so users don't
 *  trust counters that haven't moved in a long time. The OCR loop
 *  pings every 5s; anything past 60s likely means the loop is broken
 *  or the broadcaster is on intermission. */
const STALE_THRESHOLD_S = 60;

const EMPTY_PLAYER = {
  bluffs: 0,
  biggestPotWonUsd: 0,
  handsWon: 0,
  bustedAt: null,
  allInsBy: 0,
};

type PlayerRow = {
  name: string;
  p: {
    bluffs: number;
    biggestPotWonUsd: number;
    handsWon: number;
    bustedAt: number | null;
    allInsBy: number;
  };
  /** True when this player is in the lineup but the gameState OCR
   *  hasn't observed any action attributed to them yet — render with
   *  dim styling and dashes. */
  unseen: boolean;
};

export default function LiveStandingsPanel({ handleIdHex, lineup }: Props) {
  const [stats, setStats] = useState<SessionStatsRecord | null | undefined>(undefined);
  const [now, setNow] = useState<number>(Math.floor(Date.now() / 1000));

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

  // Tick a wall-clock so the "X s ago" label updates between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // For agent-unaware events (manually-seeded, no lineup) keep the
  // prior behaviour of rendering nothing. For agent-managed events the
  // lineup will always be non-empty here.
  if (lineup.length === 0 && (stats === undefined || stats === null)) return null;

  const safeStats = stats && stats !== null ? stats : null;

  // Build a row for EVERY player in the lineup, hydrating from stats
  // when present, falling back to zeros (rendered dimly) otherwise.
  const seenKeys = new Set(safeStats ? Object.keys(safeStats.players) : []);
  const playerEntries: PlayerRow[] = lineup.map((displayName) => {
    const key = displayName.toLowerCase();
    const observed = safeStats?.players[key];
    return {
      name: displayName,
      p: observed ?? EMPTY_PLAYER,
      unseen: !observed,
    };
  });
  // Players the OCR saw but who aren't in the lineup parser's view —
  // probably names captured before a lineup-replace. Append them so we
  // don't silently drop their counters.
  if (safeStats) {
    const lineupKeys = new Set(lineup.map((n) => n.toLowerCase()));
    for (const [k, p] of Object.entries(safeStats.players)) {
      if (lineupKeys.has(k) || seenKeys.has(k) === false) continue;
      // (this branch only runs if observed-but-not-in-lineup; stays out
      // of the way otherwise)
      playerEntries.push({ name: titleCaseName(k), p, unseen: false });
    }
  }
  const sortedByPotWon = [...playerEntries].sort((a, b) => b.p.biggestPotWonUsd - a.p.biggestPotWonUsd);
  const sortedByHandsWon = [...playerEntries].sort((a, b) => b.p.handsWon - a.p.handsWon);
  const sortedByBluffs = [...playerEntries].sort((a, b) => b.p.bluffs - a.p.bluffs);

  const stalenessSec = safeStats?.lastSnapshotAt
    ? Math.max(1, now - safeStats.lastSnapshotAt)
    : null;
  const isStale = stalenessSec !== null && stalenessSec > STALE_THRESHOLD_S;
  const lastUpdate = stalenessSec === null
    ? "no snapshot yet"
    : stalenessSec < 60
      ? `${stalenessSec}s ago`
      : stalenessSec < 3600
        ? `${Math.floor(stalenessSec / 60)}m ago`
        : `${Math.floor(stalenessSec / 3600)}h ago`;

  return (
    <div className="border border-card-border bg-card-elevated">
      <div className="flex items-center justify-between border-b border-card-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className={clsx(
            "w-1.5 h-1.5 rounded-full inline-block",
            isStale ? "bg-warning" : "bg-accent animate-pulse",
          )} />
          <span className={clsx(
            "text-[11px] tracking-widest uppercase",
            isStale ? "text-warning" : "text-accent",
          )}>
            {isStale ? "Live table state · stalled" : "Live table state"}
          </span>
        </div>
        <span className={clsx(
          "text-[10px]",
          isStale ? "text-warning" : "text-muted-dim",
        )}>
          {(safeStats?.framesProcessed ?? 0)} frames · updated {lastUpdate}
        </span>
      </div>

      {/* Session-level chips */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-card-border">
        <Chip label="Hands" value={String(safeStats?.handsSeen ?? 0)} />
        <Chip label="Max pot" value={safeStats && safeStats.maxPotSoFar > 0 ? `$${formatBigNumber(safeStats.maxPotSoFar)}` : "—"} />
        <Chip label="All-ins" value={String(safeStats?.allInsCount ?? 0)} />
        <Chip label="Quads" value={safeStats?.quadsHit ? "HIT" : "—"} accent={!!safeStats?.quadsHit} />
        <Chip label="Royal" value={safeStats?.royalFlushHit ? "HIT" : "—"} accent={!!safeStats?.royalFlushHit} />
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

            {sortedByHandsWon.map(({ name, p, unseen }) => {
              const isPotLeader = sortedByPotWon[0]?.p === p && p.biggestPotWonUsd > 0;
              const isBluffLeader = sortedByBluffs[0]?.p === p && p.bluffs > 0;
              const isBust = p.bustedAt !== null;
              const dim = unseen || isBust;
              return (
                <div key={name} className="contents">
                  <span className={clsx(
                    "text-[12px] font-mono",
                    isBust ? "text-muted-dim line-through" : unseen ? "text-muted-dim" : "text-text",
                  )}>
                    {name}
                  </span>
                  <span className={clsx(
                    "text-[12px] font-mono tabular-nums text-right",
                    dim ? "text-muted-dim" : "text-text",
                  )}>
                    {unseen ? "—" : p.handsWon}
                  </span>
                  <span className={clsx(
                    "text-[12px] font-mono tabular-nums text-right",
                    isPotLeader ? "text-accent" : dim ? "text-muted-dim" : "text-text",
                  )}>
                    {p.biggestPotWonUsd > 0 ? `$${formatBigNumber(p.biggestPotWonUsd)}` : "—"}
                  </span>
                  <span className={clsx(
                    "text-[12px] font-mono tabular-nums text-right",
                    isBluffLeader ? "text-accent" : dim ? "text-muted-dim" : "text-text",
                  )}>
                    {unseen ? "—" : p.bluffs}
                  </span>
                  <span className={clsx(
                    "text-[12px] font-mono tabular-nums text-right",
                    dim ? "text-muted-dim" : "text-text",
                  )}>
                    {unseen ? "—" : p.allInsBy}
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
