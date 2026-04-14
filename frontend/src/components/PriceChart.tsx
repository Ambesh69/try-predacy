"use client";

import { useState, useEffect } from "react";
import { clsx } from "clsx";
import { Liveline } from "liveline";

interface PricePoint { t: number; p: number; }

const INTERVALS = [
  { label: "6H",  value: "6h",  fidelity: 10   },
  { label: "1D",  value: "1d",  fidelity: 60   },
  { label: "1W",  value: "1w",  fidelity: 240  },
  { label: "ALL", value: "max", fidelity: 1440 },
] as const;
type Interval = typeof INTERVALS[number]["value"];

const WINDOW_SECS: Partial<Record<Interval, number>> = {
  "6h": 6  * 3_600,
  "1d": 24 * 3_600,
  "1w": 7  * 86_400,
};

const YES_COLOR = "#2CE8C6";
const NO_COLOR  = "#FF5F6D";

interface PriceChartProps {
  tokenId:      string;
  currentPrice: number;
}

export default function PriceChart({ tokenId, currentPrice }: PriceChartProps) {
  const [iv, setIv]           = useState<Interval>("1d");
  const [raw, setRaw]         = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tokenId) return;
    setLoading(true);
    const fidelity = INTERVALS.find((i) => i.value === iv)?.fidelity ?? 60;
    fetch(`/api/prices?token_id=${encodeURIComponent(tokenId)}&interval=${iv}&fidelity=${fidelity}`)
      .then((r) => r.json())
      .then((d) => {
        const pts: PricePoint[] = (d.history ?? []).filter(
          (p: any) => typeof p.p === "number" && p.p > 0,
        );
        setRaw(pts);
      })
      .catch(() => setRaw([]))
      .finally(() => setLoading(false));
  }, [tokenId, iv]);

  const hasData = raw.length >= 2;
  const yesData = raw.map((d) => ({ time: d.t, value: d.p }));
  const noData  = raw.map((d) => ({ time: d.t, value: 1 - d.p }));
  const yesLast = raw.length ? raw[raw.length - 1].p       : currentPrice;
  const noLast  = raw.length ? 1 - raw[raw.length - 1].p  : 1 - currentPrice;

  return (
    <div className="border-b border-border bg-surface/[0.12]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-px" style={{ backgroundColor: YES_COLOR }} />
            <span className="text-[10px] tracking-widest uppercase" style={{ color: YES_COLOR }}>YES</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-px" style={{ backgroundColor: NO_COLOR }} />
            <span className="text-[10px] tracking-widest uppercase" style={{ color: NO_COLOR }}>NO</span>
          </div>
          {loading && (
            <div className="w-2.5 h-2.5 border border-muted/40 border-t-transparent rounded-full animate-spin" />
          )}
        </div>

        {/* Interval selector */}
        <div className="flex items-center gap-0.5">
          {INTERVALS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setIv(value)}
              className={clsx(
                "text-[10px] px-1.5 py-0.5 tracking-widest transition-colors",
                iv === value
                  ? "text-accent border border-accent/30 bg-accent/5"
                  : "text-muted-dim hover:text-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="px-2 pb-2" style={{ height: 160 }}>
        <Liveline
          data={yesData}
          value={yesLast}
          series={[
            { id: "yes", data: yesData, value: yesLast, color: YES_COLOR, label: "YES" },
            { id: "no",  data: noData,  value: noLast,  color: NO_COLOR,  label: "NO"  },
          ]}
          window={iv !== "max" ? WINDOW_SECS[iv] : (() => {
            const nowSec = Date.now() / 1000;
            const minT = raw.length > 0 ? raw[0].t : nowSec;
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
        />
      </div>
    </div>
  );
}
