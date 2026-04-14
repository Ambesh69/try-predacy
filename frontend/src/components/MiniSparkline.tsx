"use client";

import { useState, useEffect } from "react";

interface Props {
  tokenId:      string;
  currentPrice: number;
}

const W   = 80;
const H   = 28;
const PAD = 2;

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    const cx = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${cx} ${p0.y.toFixed(1)}, ${cx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

export default function MiniSparkline({ tokenId, currentPrice }: Props) {
  const [pts, setPts]     = useState<Array<{ t: number; p: number }>>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!tokenId) { setReady(true); return; }
    fetch(
      `/api/prices?token_id=${encodeURIComponent(tokenId)}&interval=1d&fidelity=120`,
    )
      .then((r) => r.json())
      .then((d) => {
        const history: Array<{ t: number; p: number }> = (d.history ?? []).filter(
          (p: any) => typeof p.p === "number" && p.p > 0,
        );
        setPts(history);
      })
      .catch(() => setPts([]))
      .finally(() => setReady(true));
  }, [tokenId]);

  if (!ready) {
    return (
      <div className="flex items-center gap-2 pt-0.5">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
          <line
            x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2}
            stroke="#1E1E2E" strokeWidth="1.5"
          />
        </svg>
        <span className="text-[10px] font-mono text-muted-dim w-8" />
      </div>
    );
  }

  if (pts.length < 2) return null;

  const minT  = pts[0].t;
  const maxT  = pts[pts.length - 1].t;
  const range = maxT - minT || 1;

  const toX = (t: number) => PAD + ((t - minT) / range) * (W - PAD * 2);
  const toY = (p: number) => PAD + (1 - p) * (H - PAD * 2);

  const svgPts  = pts.map((d) => ({ x: toX(d.t), y: toY(d.p) }));
  const linePath = smoothPath(svgPts);

  const lastPt  = svgPts[svgPts.length - 1];
  const areaPath =
    `${linePath} L ${lastPt.x.toFixed(1)} ${(H - PAD).toFixed(1)}` +
    ` L ${PAD} ${(H - PAD).toFixed(1)} Z`;

  const firstP = pts[0].p;
  const lastP  = pts[pts.length - 1].p;
  const delta  = lastP - firstP;

  const color =
    delta >  0.005 ? "#00FFB3" :
    delta < -0.005 ? "#FF3355" :
    "#4D83FF";

  const gradId = `msp-${tokenId.slice(-8)}`;

  return (
    <div className="flex items-center gap-2 pt-0.5">
      <svg
        width={W} height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: "block", overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0"    />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth="1.1"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          strokeOpacity="0.45"
          strokeDasharray="3 12"
        >
          <animate attributeName="stroke-dashoffset" from="0" to="-48" dur="3.8s" repeatCount="indefinite" />
        </path>
        <circle cx={lastPt.x.toFixed(1)} cy={lastPt.y.toFixed(1)} r="2" fill={color} />
        <circle
          cx={lastPt.x.toFixed(1)} cy={lastPt.y.toFixed(1)}
          r="2.2" fill="none" stroke={color} strokeWidth="0.9" strokeOpacity="0.65"
        >
          <animate attributeName="r" from="2.2" to="5.6" dur="2.2s" repeatCount="indefinite" />
          <animate attributeName="stroke-opacity" from="0.65" to="0" dur="2.2s" repeatCount="indefinite" />
        </circle>
      </svg>

      <span
        className="text-[10px] font-mono tabular-nums"
        style={{ color, minWidth: "2rem" }}
      >
        {delta >= 0 ? "+" : ""}
        {Math.round(delta * 100)}%
      </span>
    </div>
  );
}
