"use client";

import { useState, useEffect, useRef } from "react";
import { clsx } from "clsx";

interface BatchTimerProps {
  openedAt: number;
  batchWindow: number;
  commitmentCount: number;
  totalDeposited: bigint;
  batchId: bigint;
  status: number;
  clearingPrice?: bigint;
  mini?: boolean;
  maxBatchUsd?: number;
  maxBatchOrders?: number;
  settlingStartedAt?: number; // unix seconds when settling began
  settlingEstimateSecs?: number; // expected settlement duration (default 12s)
}

const RADIUS        = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const RADIUS_MINI        = 24;
const CIRCUMFERENCE_MINI = 2 * Math.PI * RADIUS_MINI;

export default function BatchTimer({
  openedAt, batchWindow, commitmentCount, totalDeposited,
  batchId, status, clearingPrice, mini = false,
  maxBatchUsd = 5000, maxBatchOrders = 50,
  settlingStartedAt = 0, settlingEstimateSecs = 12,
}: BatchTimerProps) {
  const [remaining, setRemaining] = useState(batchWindow);
  const [progress, setProgress]   = useState(1);
  const [settleRemaining, setSettleRemaining] = useState(settlingEstimateSecs);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Settling countdown
  useEffect(() => {
    if (status !== 1 || !settlingStartedAt) return;
    const tick = () => {
      const elapsed = Math.floor(Date.now() / 1000) - settlingStartedAt;
      setSettleRemaining(Math.max(0, settlingEstimateSecs - elapsed));
    };
    tick();
    const iv = setInterval(tick, 500);
    return () => clearInterval(iv);
  }, [status, settlingStartedAt, settlingEstimateSecs]);

  useEffect(() => {
    const update = () => {
      const now     = Math.floor(Date.now() / 1000);
      const elapsed = now - openedAt;
      const rem     = Math.max(0, batchWindow - elapsed);
      setRemaining(rem);
      setProgress(rem / batchWindow);
    };
    update();
    if (status === 0) {
      intervalRef.current = setInterval(update, 200);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [openedAt, batchWindow, status]);

  const isIdle   = status === 0 && remaining <= 0 && commitmentCount === 0;
  const isUrgent = remaining <= 8 && status === 0 && !isIdle;
  const isOpen   = status === 0;

  const strokeColor = status === 2 ? "#4D83FF" : isIdle ? "#42425A" : isUrgent ? "#FF3355" : "#00FFB3";

  const ringProgress     = isIdle ? 1 : progress;
  const strokeDashoffset = CIRCUMFERENCE * (1 - ringProgress);
  const strokeDashoffsetMini = CIRCUMFERENCE_MINI * (1 - ringProgress);

  const formatTime = (sec: number) => Math.ceil(sec).toString().padStart(2, "0");

  const volumeDisplay = (Number(totalDeposited) / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });

  const capacityPct   = Math.min(100, (Number(totalDeposited) / 1_000_000 / maxBatchUsd) * 100);
  const capacityColor = capacityPct >= 80 ? "#FF3355" : capacityPct >= 50 ? "#FFB800" : "#4D83FF";
  const maxUsdDisplay = maxBatchUsd >= 1000 ? `$${(maxBatchUsd / 1000).toFixed(0)}k` : `$${maxBatchUsd}`;

  const statusLabel =
    status === 0
      ? isIdle    ? "WAITING FOR ORDERS"
      : isUrgent  ? "CLOSING SOON"
      :             "ACCEPTING ORDERS"
    : status === 1
      ? settlingStartedAt && settleRemaining > 0
        ? `SETTLING ~${settleRemaining}s`
        : "COMPUTING PRICE"
    : "POSITIONS CLAIMABLE";

  if (mini) {
    return (
      <div className="flex items-center gap-3 w-full">
        <div className="flex-shrink-0 relative" style={{ width: 64, height: 64 }}>
          {!isIdle && (
            <div className="absolute inset-0 rounded-full opacity-20 blur-md pointer-events-none" style={{ background: strokeColor }} />
          )}
          <svg width="64" height="64" className="rotate-[-90deg]">
            <circle cx="32" cy="32" r={RADIUS_MINI} fill="none" stroke="#13131F" strokeWidth="2" />
            <circle
              cx="32" cy="32" r={RADIUS_MINI} fill="none" stroke={strokeColor}
              strokeWidth="2" strokeLinecap="square"
              strokeDasharray={CIRCUMFERENCE_MINI} strokeDashoffset={strokeDashoffsetMini}
              style={{ transition: "stroke-dashoffset 0.2s linear, stroke 0.3s ease", filter: `drop-shadow(0 0 4px ${strokeColor}80)` }}
            />
            {Array.from({ length: 30 }).map((_, i) => {
              const angle = (i / 30) * 360 - 90;
              const rad   = (angle * Math.PI) / 180;
              const major = i % 5 === 0;
              const r1 = major ? 27 : 28, r2 = 31;
              return (
                <line key={i}
                  x1={32 + r1 * Math.cos(rad)} y1={32 + r1 * Math.sin(rad)}
                  x2={32 + r2 * Math.cos(rad)} y2={32 + r2 * Math.sin(rad)}
                  stroke={major ? "#1E1E30" : "#13131F"} strokeWidth={major ? 1.5 : 1}
                />
              );
            })}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {status === 0 ? (
              isIdle ? (
                <span className="text-xs font-black" style={{ color: "#42425A", fontFamily: "var(--font-display)" }}>—</span>
              ) : (
                <span className={clsx("text-lg font-black leading-none", isUrgent ? "glow-danger" : "glow-accent")}
                  style={{ color: strokeColor, fontFamily: "var(--font-display)" }}>{formatTime(remaining)}</span>
              )
            ) : status === 1 ? (
              <div className="w-3 h-3 border border-blue border-t-transparent rounded-full animate-spin" />
            ) : (
              <span className="text-xs font-black glow-blue" style={{ fontFamily: "var(--font-display)", color: "#4D83FF" }}>✓</span>
            )}
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted tracking-widest uppercase">Batch #{batchId.toString()}</span>
            <span className="flex items-center gap-1 flex-shrink-0">
              <span className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", { "animate-pulse": isOpen })}
                style={{ background: strokeColor, boxShadow: `0 0 4px ${strokeColor}` }} />
              <span className="text-[9px] tracking-widest uppercase" style={{ color: strokeColor }}>{statusLabel}</span>
            </span>
          </div>
          <div className="flex gap-3 text-[10px] tabular-nums flex-wrap">
            <span className="text-muted-dim">
              <span className={clsx(isOpen ? "text-accent" : "text-text")}>{commitmentCount}</span>{" orders"}
            </span>
            <span style={{ color: isOpen && capacityPct >= 80 ? "#FF3355" : isOpen && capacityPct >= 50 ? "#FFB800" : "" }}
              className="text-muted-dim">${volumeDisplay} / {maxUsdDisplay}</span>
            {status === 2 && clearingPrice !== undefined && clearingPrice > 0n && (
              <span className="text-blue glow-blue">@ {(Number(clearingPrice) / 10_000).toFixed(1)}¢</span>
            )}
          </div>
          <div className="h-[2px] rounded-full overflow-hidden" style={{ background: "#13131F" }}>
            <div className="h-full rounded-full transition-all duration-200"
              style={{ width: status === 2 ? "100%" : `${progress * 100}%`, background: `linear-gradient(90deg, ${strokeColor}40, ${strokeColor})`, boxShadow: `0 0 4px ${strokeColor}` }} />
          </div>
          {status === 0 && (
            <div className="h-[2px] rounded-full overflow-hidden" style={{ background: "#13131F" }}>
              <div className="h-full rounded-full transition-all duration-500"
                style={{ width: `${capacityPct}%`, background: capacityColor, boxShadow: `0 0 4px ${capacityColor}40` }} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="relative flex items-center justify-center">
        {!isIdle && <div className="absolute inset-0 rounded-full opacity-20 blur-xl" style={{ background: strokeColor }} />}
        <svg width="140" height="140" className="rotate-[-90deg]">
          <circle cx="70" cy="70" r={RADIUS} fill="none" stroke="#13131F" strokeWidth="3" />
          <circle cx="70" cy="70" r={RADIUS} fill="none" stroke={strokeColor}
            strokeWidth="3" strokeLinecap="square"
            strokeDasharray={CIRCUMFERENCE} strokeDashoffset={strokeDashoffset}
            style={{ transition: "stroke-dashoffset 0.2s linear, stroke 0.3s ease", filter: `drop-shadow(0 0 6px ${strokeColor}80)` }} />
          {Array.from({ length: 30 }).map((_, i) => {
            const angle = (i / 30) * 360 - 90;
            const rad   = (angle * Math.PI) / 180;
            return (
              <line key={i}
                x1={70 + 62 * Math.cos(rad)} y1={70 + 62 * Math.sin(rad)}
                x2={70 + 66 * Math.cos(rad)} y2={70 + 66 * Math.sin(rad)}
                stroke={i % 5 === 0 ? "#1E1E30" : "#13131F"} strokeWidth={i % 5 === 0 ? 1.5 : 1} />
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {status === 0 ? (
            isIdle ? (
              <div className="flex flex-col items-center gap-1">
                <span className="text-4xl font-black leading-none" style={{ color: "#42425A", fontFamily: "var(--font-display)" }}>—</span>
                <span className="text-[10px] tracking-widest uppercase" style={{ color: "#42425A" }}>idle</span>
              </div>
            ) : (
              <>
                <span className={clsx("font-display text-5xl font-black leading-none tracking-tight", isUrgent ? "glow-danger" : "glow-accent")}
                  style={{ color: strokeColor, fontFamily: "var(--font-display)" }}>{formatTime(remaining)}</span>
                <span className="text-muted text-[10px] tracking-widest uppercase mt-1">seconds</span>
              </>
            )
          ) : status === 1 ? (
            <div className="flex flex-col items-center gap-1">
              <div className="w-5 h-5 border-2 border-blue border-t-transparent rounded-full animate-spin" />
              <span className="text-blue text-[10px] tracking-widest uppercase mt-1">settling</span>
            </div>
          ) : (
            <>
              <span className="font-display text-3xl font-black glow-blue" style={{ fontFamily: "var(--font-display)", color: "#4D83FF" }}>DONE</span>
              <span className="text-blue text-[10px] tracking-widest uppercase mt-1">settled</span>
            </>
          )}
        </div>
      </div>
      <div className="w-full space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-muted text-xs tracking-widest uppercase">batch</span>
          <span className="text-text text-xs font-medium">#{batchId.toString()}</span>
        </div>
        <div className="h-px bg-border" />
        <div className="flex items-center justify-between">
          <span className="text-muted text-xs">orders sealed</span>
          <span className={clsx("text-xs font-medium tabular-nums", isOpen ? "text-accent" : "text-text")}>{commitmentCount}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted text-xs">batch capacity</span>
          <span className="text-xs font-medium tabular-nums" style={{ color: isOpen && capacityPct >= 80 ? "#FF3355" : isOpen && capacityPct >= 50 ? "#FFB800" : "" }}>
            ${volumeDisplay} / {maxUsdDisplay}
          </span>
        </div>
        {status === 0 && (
          <div className="h-[2px] rounded-full overflow-hidden" style={{ background: "#13131F" }}>
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width: `${capacityPct}%`, background: capacityColor, boxShadow: `0 0 4px ${capacityColor}` }} />
          </div>
        )}
        {status === 2 && clearingPrice !== undefined && (
          <>
            <div className="h-px bg-border" />
            <div className="flex items-center justify-between">
              <span className="text-muted text-xs">clearing price</span>
              <span className="text-blue text-xs font-medium tabular-nums glow-blue">{(Number(clearingPrice) / 10_000).toFixed(1)}¢</span>
            </div>
          </>
        )}
      </div>
      <div className="w-full h-[2px] rounded-full overflow-hidden" style={{ background: "#13131F" }}>
        <div className="h-full rounded-full transition-all duration-200"
          style={{ width: status === 2 ? "100%" : `${progress * 100}%`, background: `linear-gradient(90deg, ${strokeColor}40, ${strokeColor})`, boxShadow: `0 0 8px ${strokeColor}` }} />
      </div>
      <div className="flex items-center gap-2">
        <div className={clsx("w-1.5 h-1.5 rounded-full", { "animate-pulse": isOpen })}
          style={{ background: strokeColor, boxShadow: `0 0 4px ${strokeColor}` }} />
        <span className="text-[11px] tracking-widest uppercase" style={{ color: strokeColor }}>{statusLabel}</span>
      </div>
    </div>
  );
}
