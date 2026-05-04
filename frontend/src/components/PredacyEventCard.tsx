"use client";

import Link from "next/link";
import { clsx } from "clsx";
import { type EventDescriptor, formatUsdc6, relativeTime } from "@/lib/lpApi";

interface Props {
  event: EventDescriptor;
}

const CHANNEL_DISPLAY: Record<string, { name: string; subtitle: string }> = {
  TRITON: { name: "Triton Poker", subtitle: "Cash Game Invitational" },
  HCL: { name: "Hustler Casino Live", subtitle: "Streamer Showdown" },
};

/** Pull the channel tag (TRITON / HCL / etc.) off the front of a session
 *  label like "TRITON-SESSION-2026-05-04-7783281c", or the manual seed
 *  format "TRITON-2026-05-04". Returns null for non-stream events. */
function parseLabel(label?: string | null): { channel: string | null } {
  if (!label) return { channel: null };
  const m = label.match(/^([A-Z]+)-/);
  return { channel: m?.[1] ?? null };
}

/** Pull unique player names out of marketLabels by stripping the
 *  "Will <NAME> bluff the most…" / "Will <NAME> bust first?" prefixes.
 *  This is how we surface the agent's lineup on the card without the
 *  backend having to expose it as a separate field. */
function playersFromMarketLabels(labels: Record<string, string> | undefined): string[] {
  if (!labels) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lbl of Object.values(labels)) {
    let m = lbl.match(/^Will (.+?) bluff the most this session\?$/);
    if (!m) m = lbl.match(/^Will (.+?) bust first\?$/);
    if (!m) continue;
    const name = m[1].trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export default function PredacyEventCard({ event }: Props) {
  const closesIn = event.closesAt - Math.floor(Date.now() / 1000);
  const isClosingSoon = closesIn > 0 && closesIn < 86400;
  const isExpired = closesIn <= 0;

  const { channel } = parseLabel(event.label);
  const channelInfo = channel ? CHANNEL_DISPLAY[channel] : undefined;
  const players = playersFromMarketLabels(event.marketLabels);

  // Title: stream-friendly name when we recognise the channel; otherwise
  // fall back to the label itself (still better than the hash).
  const title = channelInfo?.name ?? event.label ?? `Event ${event.handleId.slice(0, 8)}…`;
  const subtitle = channelInfo?.subtitle ?? null;

  return (
    <Link href={`/event/predacy/${event.handleId}`} className="block h-full">
      <div className={clsx(
        "market-card border bg-surface p-5 cursor-crosshair flex flex-col gap-3 h-full",
        event.graduated
          ? "border-accent/60 shadow-[0_0_0_1px_rgba(44,232,198,0.2),0_12px_28px_rgba(8,20,30,0.35)]"
          : "border-border",
      )}>
        <div className="flex items-center gap-2 flex-wrap">
          {event.graduated ? (
            <span className="flex items-center gap-1 text-[10px] text-accent tracking-widest uppercase border border-accent/30 px-2 py-0.5 bg-accent/5">
              <span className="w-1 h-1 rounded-full bg-accent animate-pulse inline-block" /> TIER 1 ACTIVE
            </span>
          ) : (
            <span className="text-[10px] text-muted-dim tracking-widest uppercase border border-border-bright px-2 py-0.5">
              PRE-GRAD
            </span>
          )}
          <span className="text-[10px] text-muted tracking-widest uppercase border border-border-bright bg-surface/70 px-2 py-0.5">
            {event.category}
          </span>
          <span className={clsx(
            "text-[10px] ml-auto",
            isExpired ? "text-danger" : isClosingSoon ? "text-warning" : "text-muted",
          )}>
            {isExpired ? "Closed" : `Closes ${relativeTime(event.closesAt)}`}
          </span>
        </div>

        <div>
          <h3 className="text-text text-base leading-snug font-bold">
            {title}
          </h3>
          {subtitle && (
            <p className="text-[11px] text-muted mt-0.5">{subtitle}</p>
          )}
        </div>

        {/* Player lineup — this is the agent's read of who's at the table. */}
        {players.length > 0 ? (
          <div className="text-[11px] text-muted-dim leading-snug">
            <span className="text-accent">{players.length} player{players.length === 1 ? "" : "s"}:</span>{" "}
            <span className="text-muted">
              {players.slice(0, 4).join(", ")}
              {players.length > 4 && `, +${players.length - 4} more`}
            </span>
          </div>
        ) : (
          <p className="text-[11px] text-muted-dim italic">Waiting on agent lineup…</p>
        )}

        <div className="grid grid-cols-3 gap-2 pt-1">
          <Stat
            label="Markets"
            value={String(event.marketCount)}
          />
          <Stat
            label="Volume"
            value={`$${formatUsdc6(event.cumulativeVolumeUsdc, 0)}`}
          />
          <Stat
            label="Taker fee"
            value={`${event.feeBpsTaker / 100}%`}
          />
        </div>

        <div className="h-[2px] bg-border rounded-full mt-auto" />

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-dim font-mono">
            {event.handleId.slice(0, 8)}…
          </span>
          <span className="flex items-center gap-1 text-[10px] text-accent tracking-widest uppercase">
            Open <span className="text-accent">→</span>
          </span>
        </div>
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] tracking-widest uppercase text-muted">{label}</p>
      <p className="text-text text-[13px] font-mono tabular-nums mt-0.5">{value}</p>
    </div>
  );
}
