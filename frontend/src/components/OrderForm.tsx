"use client";

import { useState, useCallback, useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import clsx from "clsx";

interface OrderFormProps {
  marketId: string;
  marketQuestion: string;
  yesPrice: number;
  noPrice: number;
}

const PRICE_DECIMALS = 1_000_000;
const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3001";

function cleanError(raw: string): string {
  if (raw.includes("insufficient funds")) return "Insufficient token balance for this order.";
  if (raw.includes("InsufficientBalance")) return "Not enough tokens in your wallet.";
  if (raw.includes("BatchWindowNotElapsed")) return "Batch is still open — try again in a few seconds.";
  if (raw.includes("MaxOrdersReached")) return "Batch is full — your order will go in the next batch.";
  if (raw.includes("No active batch")) return "Starting market — please try again.";
  if (raw.includes("Market not active")) return "Initializing market — please try again.";
  if (raw.includes("Failed to fetch")) return "Relayer is unreachable — check your connection.";
  if (raw.includes("AccountNotInitialized")) return "Account setup needed — retrying...";
  if (raw.includes("Simulation failed")) return "Transaction failed — the batch may have closed. Try again.";
  if (raw.length > 80) return raw.slice(0, 80) + "…";
  return raw;
}

export function OrderForm({ marketId, marketQuestion, yesPrice, noPrice }: OrderFormProps) {
  const { authenticated, login, user } = usePrivy();
  const solanaWallet = user?.linkedAccounts?.find((a: any) => a.type === "wallet" && a.chainType === "solana") as any;
  const walletAddress = solanaWallet?.address ?? user?.wallet?.address;

  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [amount, setAmount] = useState("");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPriceInput, setLimitPriceInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [balances, setBalances] = useState<{ usdc: string; yes: string; no: string } | null>(null);

  // Fetch token balances
  useEffect(() => {
    if (!walletAddress || !marketId) return;
    const fetchBalances = async () => {
      try {
        const res = await fetch(`${RELAYER_URL}/balances?wallet=${walletAddress}&marketId=${marketId}`);
        if (res.ok) setBalances(await res.json());
      } catch {}
    };
    fetchBalances();
    const iv = setInterval(fetchBalances, 10_000);
    return () => clearInterval(iv);
  }, [walletAddress, marketId]);

  const currentPrice = side === "yes" ? yesPrice : noPrice;
  const effectivePrice = orderType === "limit" && limitPriceInput
    ? parseFloat(limitPriceInput) / 100
    : currentPrice;
  const amountNum = parseFloat(amount) || 0;
  const tokensToReceive = mode === "buy" && effectivePrice > 0 ? amountNum / effectivePrice : 0;
  const usdcToReceive = mode === "sell" ? amountNum * effectivePrice : 0;

  const orderSide = mode === "buy"
    ? (side === "yes" ? 0 : 2)
    : (side === "yes" ? 1 : 3);

  const handleSubmit = useCallback(async () => {
    if (!authenticated) { login(); return; }
    if (!amount || amountNum <= 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const saltBytes = crypto.getRandomValues(new Uint8Array(32));
      const salt = "0x" + Array.from(saltBytes).map(b => b.toString(16).padStart(2, "0")).join("");
      const amountMicro = Math.floor(amountNum * 1_000_000).toString();
      const limitPrice = orderType === "limit" && limitPriceInput
        ? Math.floor(parseFloat(limitPriceInput) * 10_000).toString()
        : Math.floor(currentPrice * PRICE_DECIMALS).toString();

      // Ensure market is active on relayer (opens batch if needed)
      const startRes = await fetch(`${RELAYER_URL}/market/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketId }),
      }).catch(() => null);

      // Small delay to ensure batch is fully initialized
      if (startRes) await new Promise(r => setTimeout(r, 1000));

      const res = await fetch(`${RELAYER_URL}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketId, side: orderSide, amount: amountMicro, limitPrice, salt }),
      });
      const data = await res.json();

      if (data.ok) {
        const orders = JSON.parse(localStorage.getItem(`predacy:orders:${walletAddress}`) || "[]");
        orders.push({
          commitment: data.commitment, salt, amount: amountMicro,
          side: orderSide, limitPrice, batchId: data.batchId,
          marketId, marketQuestion, timestamp: Date.now(),
        });
        if (orders.length > 200) orders.shift();
        localStorage.setItem(`predacy:orders:${walletAddress}`, JSON.stringify(orders));
        setResult({ ok: true, message: `Order sealed in batch #${data.batchId}` });
        setAmount("");
        // Auto-clear success after 5s
        setTimeout(() => setResult(null), 5000);
      } else {
        setResult({ ok: false, message: cleanError(data.error || "Order failed") });
      }
    } catch (err: any) {
      setResult({ ok: false, message: cleanError(err.message || "Network error") });
    } finally {
      setSubmitting(false);
    }
  }, [authenticated, login, amount, amountNum, marketId, orderSide, orderType, limitPriceInput, currentPrice, walletAddress, marketQuestion]);

  return (
    <div className="flex flex-col h-full">
      {/* Mode tabs */}
      <div className="flex border-b border-border">
        <button onClick={() => setMode("buy")}
          className={clsx(
            "flex-1 py-3 text-[11px] tracking-widest uppercase font-bold transition-colors border-b-2",
            mode === "buy" ? "border-accent text-accent bg-accent/5" : "border-transparent text-muted hover:text-text"
          )}>BUY</button>
        <button onClick={() => setMode("sell")}
          className={clsx(
            "flex-1 py-3 text-[11px] tracking-widest uppercase font-bold transition-colors border-b-2",
            mode === "sell" ? "border-danger text-danger bg-danger/5" : "border-transparent text-muted hover:text-text"
          )}>SELL</button>
      </div>

      <div className="p-4 space-y-4 flex-1">
        {/* Outcome selection */}
        <div>
          <p className="text-[10px] text-muted tracking-widest uppercase mb-2">Outcome</p>
          <div className="flex gap-2">
            <button onClick={() => setSide("yes")}
              className={clsx(
                "flex-1 py-2.5 text-[11px] tracking-widest uppercase font-bold transition-all border",
                side === "yes"
                  ? "border-accent text-accent bg-accent/10"
                  : "border-border text-muted hover:border-accent/40 hover:text-accent"
              )}>YES {Math.round(yesPrice * 100)}%</button>
            <button onClick={() => setSide("no")}
              className={clsx(
                "flex-1 py-2.5 text-[11px] tracking-widest uppercase font-bold transition-all border",
                side === "no"
                  ? "border-danger text-danger bg-danger/10"
                  : "border-border text-muted hover:border-danger/40 hover:text-danger"
              )}>NO {Math.round(noPrice * 100)}%</button>
          </div>
        </div>

        {/* Order type */}
        <div>
          <p className="text-[10px] text-muted tracking-widest uppercase mb-2">Type</p>
          <div className="flex gap-2">
            <button onClick={() => setOrderType("market")}
              className={clsx(
                "px-3 py-1.5 text-[10px] tracking-widest uppercase border transition-colors",
                orderType === "market" ? "border-accent/45 text-accent bg-accent/10" : "border-border text-muted hover:text-text"
              )}>Market</button>
            <button onClick={() => setOrderType("limit")}
              className={clsx(
                "px-3 py-1.5 text-[10px] tracking-widest uppercase border transition-colors",
                orderType === "limit" ? "border-accent/45 text-accent bg-accent/10" : "border-border text-muted hover:text-text"
              )}>Limit</button>
          </div>
        </div>

        {/* Limit price */}
        {orderType === "limit" && (
          <div>
            <p className="text-[10px] text-muted tracking-widest uppercase mb-2">Limit Price (%)</p>
            <input type="number" min="1" max="99" step="1"
              value={limitPriceInput}
              onChange={(e) => setLimitPriceInput(e.target.value)}
              placeholder={`${Math.round(currentPrice * 100)}`}
              className="w-full bg-bg border border-border px-3 py-2.5 text-[13px] text-text focus:border-border-bright transition-colors" />
          </div>
        )}

        {/* Balance display */}
        {balances && (
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted tracking-widest uppercase">Balance</span>
            <span className="text-text tabular-nums">
              {mode === "buy"
                ? `${(Number(balances.usdc) / 1_000_000).toFixed(2)} USDC`
                : side === "yes"
                ? `${(Number(balances.yes) / 1_000_000).toFixed(2)} YES`
                : `${(Number(balances.no) / 1_000_000).toFixed(2)} NO`}
            </span>
          </div>
        )}

        {/* Amount */}
        <div>
          <p className="text-[10px] text-muted tracking-widest uppercase mb-2">
            {mode === "buy" ? "Amount (USDC)" : "Tokens to sell"}
          </p>
          <div className="relative">
            <input type="number" min="0" step="0.01" value={amount}
              onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
              className="w-full bg-bg border border-border px-3 py-2.5 text-[13px] text-text focus:border-border-bright transition-colors" />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
              {mode === "buy" ? (
                [1, 5, 10, 25].map((v) => (
                  <button key={v} onClick={() => setAmount(v.toString())}
                    className="px-1.5 py-0.5 text-[9px] tracking-widest uppercase border border-border text-muted hover:text-text hover:border-border-bright transition-colors">
                    ${v}
                  </button>
                ))
              ) : (
                <>
                  {[25, 50, 100].map((pct) => {
                    const bal = side === "yes" ? Number(balances?.yes || "0") : Number(balances?.no || "0");
                    const tokens = (bal / 1_000_000) * (pct / 100);
                    return (
                      <button key={pct} onClick={() => setAmount(tokens.toFixed(2))}
                        className="px-1.5 py-0.5 text-[9px] tracking-widest uppercase border border-border text-muted hover:text-text hover:border-border-bright transition-colors">
                        {pct}%
                      </button>
                    );
                  })}
                  <button onClick={() => {
                    const bal = side === "yes" ? Number(balances?.yes || "0") : Number(balances?.no || "0");
                    setAmount((bal / 1_000_000).toFixed(2));
                  }}
                    className="px-1.5 py-0.5 text-[9px] tracking-widest uppercase border border-accent/40 text-accent hover:bg-accent/5 transition-colors">
                    MAX
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Limit price slider */}
        {orderType === "limit" && limitPriceInput && (
          <input type="range" min="1" max="99" value={limitPriceInput}
            onChange={(e) => setLimitPriceInput(e.target.value)}
            className={clsx("w-full", mode === "sell" && "danger")} />
        )}

        {/* Summary */}
        {amountNum > 0 && (
          <div className="border border-border p-3 space-y-2">
            {mode === "buy" ? (
              <>
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted">Avg price</span>
                  <span className="text-text tabular-nums">{Math.round(effectivePrice * 100)}%</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted">Tokens to receive</span>
                  <span className="text-accent tabular-nums font-medium">{tokensToReceive.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted">Potential payout</span>
                  <span className="text-accent tabular-nums font-medium">${tokensToReceive.toFixed(2)}</span>
                </div>
              </>
            ) : (
              <div className="flex justify-between text-[11px]">
                <span className="text-muted">You receive</span>
                <span className="text-accent tabular-nums font-medium">${usdcToReceive.toFixed(2)}</span>
              </div>
            )}
          </div>
        )}

        {/* Privacy badge */}
        <div className="flex items-center gap-2 border border-border/50 px-3 py-2">
          <span className="text-accent/60 text-[10px]">✓</span>
          <span className="text-[10px] text-muted-dim tracking-widest uppercase">Sealed-bid order · wallet hidden via ZK proof</span>
        </div>

        {/* Submit */}
        <button onClick={handleSubmit}
          disabled={submitting || (!amount || amountNum <= 0)}
          className={clsx(
            "w-full py-3 text-[11px] tracking-widest uppercase font-bold transition-colors border",
            mode === "buy"
              ? "border-accent text-accent hover:bg-accent/5"
              : "border-danger text-danger hover:bg-danger/5",
            (submitting || !amount || amountNum <= 0) && "opacity-40 cursor-not-allowed"
          )}>
          {!authenticated ? "CONNECT WALLET" : submitting ? "SUBMITTING…"
            : mode === "buy" ? `BUY ${side.toUpperCase()}` : `SELL ${side.toUpperCase()}`}
        </button>

        {/* Result toast */}
        {result && (
          <div className={clsx(
            "p-3 border animate-slide-up",
            result.ok ? "border-accent/30 bg-accent/5" : "border-danger/30 bg-danger/5"
          )}>
            <div className="flex items-center gap-2">
              {result.ok ? (
                <svg className="w-4 h-4 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-danger flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
              <div className="flex-1 min-w-0">
                <p className={clsx("text-[11px] font-bold tracking-widest uppercase", result.ok ? "text-accent" : "text-danger")}>
                  {result.ok ? "ORDER SEALED" : "ORDER FAILED"}
                </p>
                <p className={clsx("text-[10px] mt-0.5", result.ok ? "text-accent/70" : "text-danger/70")}>
                  {result.message}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
