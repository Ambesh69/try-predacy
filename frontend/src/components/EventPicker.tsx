"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  EventDescriptor,
  formatUsdc6,
  listEvents,
  relativeTime,
} from "@/lib/lpApi";

interface EventPickerProps {
  selected: EventDescriptor | null;
  onSelect: (ev: EventDescriptor | null) => void;
  /** When true, hide events that have already closed. Default true. */
  hideClosed?: boolean;
}

const CATEGORY_LABELS: Record<EventDescriptor["category"], string> = {
  LiveStream: "🎥 Live Stream",
  Sports: "⚽ Sports",
  Crypto: "₿ Crypto",
  Politics: "🗳 Politics",
  Custom: "✨ Custom",
};

export default function EventPicker({
  selected,
  onSelect,
  hideClosed = true,
}: EventPickerProps) {
  const [events, setEvents] = useState<EventDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Re-fetch every 30s — events graduate over time and we want their
  // post-graduation state visible without manual refresh.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const next = await listEvents();
        if (!cancelled) {
          setEvents(next);
          setError(null);
          // Sync the currently-selected event with its latest server-side
          // copy. Without this, a `selected` event captured before
          // `closesAt` (or any other field) changed on the relayer keeps
          // its stale value — consumers like LPDepositForm read
          // `selected.closesAt` to compute commitmentExpiresAt and the
          // resulting tx fails the on-chain `commitment_expires_at <=
          // event_handle.closes_at` check.
          if (selected) {
            const fresh = next.find((e) => e.handleId === selected.handleId);
            if (fresh && fresh.closesAt !== selected.closesAt) {
              onSelect(fresh);
            }
          }
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? "Failed to load events");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.handleId]);

  const visible = events.filter((ev) => (hideClosed ? !ev.closed : true));

  return (
    <div className="space-y-2">
      <label className="text-[10px] tracking-widest uppercase text-muted">
        Event
      </label>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 border border-card-border bg-card text-text hover:border-accent/50 transition-colors"
        disabled={loading || visible.length === 0}
      >
        <span className="flex items-center gap-2 text-[12px] truncate">
          {loading ? (
            <span className="text-muted">Loading events…</span>
          ) : selected ? (
            <>
              <span className="text-accent">
                {CATEGORY_LABELS[selected.category]}
              </span>
              <span className="text-muted">·</span>
              <span className="font-mono text-[11px]">
                {selected.handleId.slice(0, 8)}…
              </span>
              <span className="text-muted text-[10px]">
                {selected.graduated ? "graduated" : "pre-grad"}
              </span>
            </>
          ) : (
            <span className="text-muted">
              {visible.length === 0 ? "No events live" : "Pick an event…"}
            </span>
          )}
        </span>
        <span className="text-muted text-[10px]">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {error && (
        <p className="text-[10px] text-danger">⚠ {error}</p>
      )}

      {open && visible.length > 0 && (
        <div className="max-h-72 overflow-y-auto border border-card-border bg-card divide-y divide-card-border/40">
          {visible.map((ev) => (
            <button
              key={ev.handleId}
              type="button"
              onClick={() => {
                onSelect(ev);
                setOpen(false);
              }}
              className={clsx(
                "w-full text-left px-3 py-2.5 hover:bg-accent/5 transition-colors",
                selected?.handleId === ev.handleId && "bg-accent/10",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] tracking-widest uppercase text-accent">
                  {CATEGORY_LABELS[ev.category]}
                </span>
                <span
                  className={clsx(
                    "text-[10px] px-1.5 py-0.5 border rounded-sm",
                    ev.graduated
                      ? "border-accent/40 text-accent"
                      : "border-warning/40 text-warning",
                  )}
                >
                  {ev.graduated ? "GRADUATED" : "PRE-GRAD"}
                </span>
              </div>
              <p className="font-mono text-[11px] text-text mt-1 truncate">
                {ev.handleId}
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted mt-1">
                <span>{ev.marketCount} markets</span>
                <span>·</span>
                <span>${formatUsdc6(ev.cumulativeVolumeUsdc)} vol</span>
                <span>·</span>
                <span>{ev.feeBpsTaker / 100}% taker fee</span>
                <span>·</span>
                <span>closes {relativeTime(ev.closesAt)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
