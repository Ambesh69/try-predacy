"use client";

import Link from "next/link";
import { clsx } from "clsx";
import { type EventDescriptor, formatUsdc6, relativeTime } from "@/lib/lpApi";
import { playersFromMarketLabels } from "@/lib/marketUtils";

interface Props {
  event: EventDescriptor;
}

const CHANNEL_DISPLAY: Record<string, { name: string; subtitle: string; tag: string }> = {
  TRITON: {
    name: "Triton Poker",
    subtitle: "Cash Game Invitational",
    tag: "LIVESTREAM",
  },
  HCL: {
    name: "Hustler Casino Live",
    subtitle: "Streamer Showdown",
    tag: "LIVESTREAM",
  },
};

function parseChannel(label?: string | null): string | null {
  if (!label) return null;
  const m = label.match(/^([A-Z]+)-/);
  return m?.[1] ?? null;
}

/** Format a volume number into a 5–6-char label like "$1.1M" / "$880K" /
 *  "$540". Polymarket-style — the index card has no room for full
 *  precision and large numbers are the norm. */
function fmtVolume(microStr: string): string {
  const usd = Number(formatUsdc6(microStr, 0).replace(/,/g, ""));
  if (!isFinite(usd) || usd <= 0) return "$0";
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd}`;
}

export default function PredacyEventCard({ event }: Props) {
  const closesIn = event.closesAt - Math.floor(Date.now() / 1000);
  const isExpired = closesIn <= 0;

  const channel = parseChannel(event.label);
  const channelInfo = channel ? CHANNEL_DISPLAY[channel] : undefined;
  const players = playersFromMarketLabels(event.marketLabels);

  const title = channelInfo?.name ?? event.label ?? `Event ${event.handleId.slice(0, 8)}…`;
  const subtitle = channelInfo?.subtitle ?? event.category;
  const tag = channelInfo?.tag ?? event.category.toUpperCase();

  // Image-2-style preview: top 4 outcomes from the canonical "win the
  // most hands" multi-outcome group, displayed with uniform 1/N priors
  // until live price data lands. We surface this group specifically
  // because it's the most universally applicable across both Triton
  // (cash game) and HCL (streamer showdown) formats.
  const VISIBLE = 4;
  const previewOutcomes = players.slice(0, VISIBLE);
  const moreCount = Math.max(0, players.length - VISIBLE);
  const uniformPct = players.length > 0 ? Math.round(100 / players.length) : 0;

  const closesLabel = isExpired
    ? "Closed"
    : `Closes ${relativeTime(event.closesAt)}`;

  return (
    <Link href={`/event/predacy/${event.handleId}`} className="block h-full">
      <div className={clsx(
        "border bg-card p-5 cursor-crosshair flex flex-col gap-3 h-full hover:border-border-bright transition-colors",
        event.graduated
          ? "border-accent/60 shadow-[0_0_0_1px_rgba(44,232,198,0.2)]"
          : "border-card-border",
      )}>
        {/* Top row — tag left, closes right (matches image 2's layout) */}
        <div className="flex items-start justify-between gap-2">
          <span className="text-[10px] tracking-widest uppercase border border-border-bright text-muted px-2 py-0.5">
            {tag}
          </span>
          <span className={clsx(
            "text-[10px] tabular-nums shrink-0 mt-0.5",
            isExpired ? "text-danger" : "text-muted-dim",
          )}>
            {closesLabel}
          </span>
        </div>

        {/* Title block */}
        <div>
          <h3 className="text-text text-[15px] leading-snug font-bold">
            {title}
          </h3>
          {subtitle && (
            <p className="text-[10px] text-muted-dim mt-0.5 tracking-wider uppercase">
              {subtitle}
            </p>
          )}
        </div>

        {/* Outcomes preview — top N players with sparkline + uniform % */}
        {previewOutcomes.length > 0 ? (
          <div className="flex flex-col gap-1.5 mt-1">
            {previewOutcomes.map((player) => (
              <div key={player} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-[12px]">
                <span className="text-text font-mono truncate">
                  {player}
                </span>
                <div className="w-[60px] h-[2px] bg-border rounded-full overflow-hidden">
                  <div
                    className="h-full"
                    style={{ width: `${Math.max(2, uniformPct)}%`, background: "#4EA3FF" }}
                  />
                </div>
                <span className="tabular-nums w-[34px] text-right" style={{ color: "#4EA3FF" }}>
                  {uniformPct}%
                </span>
              </div>
            ))}
            {moreCount > 0 && (
              <p className="text-[10px] text-muted-dim mt-0.5">
                +{moreCount} more outcome{moreCount === 1 ? "" : "s"}
              </p>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-dim italic mt-1">Waiting on agent lineup…</p>
        )}

        {/* Bottom — volume + dark-pool tag (image 2 footer style) */}
        <div className="flex items-center justify-between mt-auto pt-2">
          <span className="text-[11px] text-muted tabular-nums">
            {fmtVolume(event.cumulativeVolumeUsdc)} vol
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-dim tracking-widest uppercase">
            <LockIcon /> Dark Pool
          </span>
        </div>
      </div>
    </Link>
  );
}

function LockIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
