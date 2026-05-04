"use client";

import Link from "next/link";
import { clsx } from "clsx";
import { type EventDescriptor, formatUsdc6, relativeTime } from "@/lib/lpApi";

interface Props {
  event: EventDescriptor;
}

export default function PredacyEventCard({ event }: Props) {
  const closesIn = event.closesAt - Math.floor(Date.now() / 1000);
  const isClosingSoon = closesIn > 0 && closesIn < 86400;
  const isExpired = closesIn <= 0;
  const display = event.label ?? `${event.handleId.slice(0, 8)}…`;

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

        <h3 className="text-text text-sm leading-snug font-mono">
          {display}
        </h3>

        <div className="grid grid-cols-3 gap-2 pt-1">
          <Stat
            label="Volume"
            value={`$${formatUsdc6(event.cumulativeVolumeUsdc, 0)}`}
          />
          <Stat
            label="Markets"
            value={String(event.marketCount)}
          />
          <Stat
            label="Taker fee"
            value={`${event.feeBpsTaker / 100}%`}
          />
        </div>

        <div className="h-[2px] bg-border rounded-full" />

        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-muted">
            Grad threshold ${formatUsdc6(event.graduationThresholdUsdc, 0)} × {event.graduationBatches}
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
