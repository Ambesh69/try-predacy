"use client";

import { useState } from "react";
import clsx from "clsx";
import { usePrivy } from "@privy-io/react-auth";
import {
  useSignAndSendTransaction,
  useWallets as useSolanaWallets,
} from "@privy-io/react-auth/solana";
import {
  EventDescriptor,
  buildCommitTx,
  decodeTxBase64,
  formatUsdc6,
} from "@/lib/lpApi";
import { pushToast } from "@/components/Toast";

type Phase = "idle" | "encrypting" | "signing" | "submitting" | "success" | "error";

const COMMITMENT_PRESETS = [
  { label: "Stream length", multiplier: 1, hint: "auto-refunds at event close" },
  { label: "1 day",         multiplier: -1, durationSec: 86400 },
  { label: "1 week",        multiplier: -1, durationSec: 7 * 86400 },
];

interface LPDepositFormProps {
  event: EventDescriptor | null;
  onDeposited?: () => void;
}

export default function LPDepositForm({ event, onDeposited }: LPDepositFormProps) {
  const { authenticated, login, user } = usePrivy();
  const solanaWalletMeta = user?.linkedAccounts?.find(
    (a: any) => a.type === "wallet" && a.chainType === "solana",
  ) as any;
  const walletAddress: string | undefined =
    solanaWalletMeta?.address ?? user?.wallet?.address;
  const { wallets: solanaWallets } = useSolanaWallets();
  const wallet = solanaWallets[0];
  const { signAndSendTransaction } = useSignAndSendTransaction();

  const [amount, setAmount] = useState("");
  const [presetIdx, setPresetIdx] = useState(0);
  const [blindMode, setBlindMode] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [phaseDetail, setPhaseDetail] = useState("");
  const [resultMsg, setResultMsg] = useState<{ ok: boolean; msg: string; ctHex?: string } | null>(null);

  const amountNum = parseFloat(amount || "0");
  const canSubmit =
    authenticated &&
    !!event &&
    amountNum > 0 &&
    amountNum <= 100_000 &&
    (phase === "idle" || phase === "success" || phase === "error");

  function commitmentExpiresAt(): number {
    if (!event) return 0;
    const preset = COMMITMENT_PRESETS[presetIdx];
    if (preset.multiplier === 1) {
      // Track event close exactly — capital auto-refunds at event end.
      return event.closesAt;
    }
    const target = Math.floor(Date.now() / 1000) + (preset.durationSec ?? 0);
    // Cap at event close to keep the chain ix happy.
    return Math.min(target, event.closesAt);
  }

  async function handleSubmit() {
    if (!canSubmit || !event || !walletAddress || !wallet) return;
    setResultMsg(null);

    try {
      const amountMicro = BigInt(Math.floor(amountNum * 1_000_000));
      const expiresAt = commitmentExpiresAt();

      // ── Phase 1: build (relayer encrypts amount via Encrypt CreateInput
      // when mode=blind, returns an unsigned tx with the ciphertext id) ──
      setPhase("encrypting");
      setPhaseDetail(
        blindMode
          ? "Encrypting deposit under Encrypt FHE…"
          : "Building deposit tx…",
      );
      const built = await buildCommitTx({
        mode: blindMode ? "blind" : "plaintext",
        handleIdHex: event.handleId,
        depositor: walletAddress,
        amount: amountMicro.toString(),
        commitmentExpiresAt: expiresAt,
      });

      // If user requested blind but Encrypt was unreachable, the relayer
      // falls back to plaintext. Surface that honestly.
      const actualMode = built.mode ?? (blindMode ? "blind" : "plaintext");
      if (blindMode && actualMode === "plaintext-fallback") {
        pushToast(
          "info",
          "Plaintext fallback",
          "Encrypt gRPC unavailable; deposit lands as plaintext. Privacy ships next batch.",
        );
      }

      // ── Phase 2: sign + send via Privy ──
      setPhase("signing");
      setPhaseDetail("Approve in your wallet…");
      const txBytes = decodeTxBase64(built.txBase64);
      const result = await signAndSendTransaction({
        transaction: txBytes,
        wallet: wallet as any,
        chain: "solana:devnet" as any,
      });

      setPhase("submitting");
      setPhaseDetail("Confirming on Solana…");
      // signAndSendTransaction already submitted to the cluster; we surface
      // success once we have the signature back.
      const sig = bytesToBase58(result.signature);

      setPhase("success");
      setPhaseDetail("");
      setResultMsg({
        ok: true,
        msg: `Deposited $${amountNum.toFixed(2)} to ${event.handleId.slice(0, 8)}…`,
        ctHex: built.ciphertextIdHex,
      });
      pushToast(
        "success",
        actualMode === "blind" ? "Blind LP committed" : "LP committed",
        `$${amountNum.toFixed(2)} · tx ${sig.slice(0, 6)}…${sig.slice(-4)}`,
      );
      setAmount("");
      onDeposited?.();
      setTimeout(() => {
        setPhase("idle");
        setResultMsg(null);
      }, 5000);
    } catch (err: any) {
      setPhase("error");
      setPhaseDetail("");
      const msg = cleanError(err.message ?? "Deposit failed");
      setResultMsg({ ok: false, msg });
      pushToast("error", "Deposit failed", msg);
    }
  }

  return (
    <div className="space-y-4 p-4 border border-card-border bg-card">
      <div>
        <p className="text-[11px] tracking-widest uppercase text-accent">
          Provide Liquidity
        </p>
        <p className="text-[10px] text-muted mt-1">
          Earn pro-rata share of taker fees + spread for the duration of the event.
          Capital auto-refunds at expiry.
        </p>
      </div>

      {/* Amount */}
      <div className="space-y-2">
        <label className="text-[10px] tracking-widest uppercase text-muted">
          Amount (USDC)
        </label>
        <div className="relative">
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            max="100000"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={!event || phase !== "idle" && phase !== "success" && phase !== "error"}
            className="w-full px-3 py-2.5 bg-input border border-card-border focus:border-accent outline-none text-text font-mono text-[14px] disabled:opacity-50"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted">
            USDC
          </span>
        </div>
        <div className="flex gap-1">
          {[10, 100, 1000].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setAmount(String(preset))}
              className="flex-1 py-1 text-[10px] border border-card-border hover:border-accent/50 transition-colors text-muted hover:text-accent"
              disabled={!event}
            >
              ${preset}
            </button>
          ))}
        </div>
      </div>

      {/* Commitment duration */}
      <div className="space-y-2">
        <label className="text-[10px] tracking-widest uppercase text-muted">
          Lockup
        </label>
        <div className="grid grid-cols-3 gap-1">
          {COMMITMENT_PRESETS.map((preset, idx) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setPresetIdx(idx)}
              className={clsx(
                "py-2 text-[10px] tracking-widest uppercase border transition-colors",
                presetIdx === idx
                  ? "border-accent text-accent bg-accent/5"
                  : "border-card-border text-muted hover:border-accent/50",
              )}
              disabled={!event}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-muted-dim">
          {COMMITMENT_PRESETS[presetIdx].hint ??
            `Capped at event close (${event ? new Date(event.closesAt * 1000).toLocaleString() : "—"})`}
        </p>
      </div>

      {/* Blind mode toggle — the moat */}
      <div className="border border-card-border bg-card-elevated p-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <p className="text-[11px] tracking-widest uppercase font-bold text-accent">
              Blind LP · FHE-encrypted
            </p>
            <p className="text-[10px] text-muted mt-1 leading-snug">
              Deposit amount is encrypted under Encrypt's network key before
              landing on-chain. Aggregate vault balance stays public; your
              individual allocation does not. Falls back to plaintext if
              Encrypt's pre-Alpha gRPC is unreachable.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setBlindMode((v) => !v)}
            className={clsx(
              "shrink-0 w-10 h-6 rounded-full relative transition-colors",
              blindMode ? "bg-accent" : "bg-card-border",
            )}
            role="switch"
            aria-checked={blindMode}
          >
            <span
              className={clsx(
                "absolute top-0.5 w-5 h-5 rounded-full bg-card transition-transform",
                blindMode ? "translate-x-[18px]" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </div>

      {/* Submit */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className={clsx(
          "w-full py-3 text-[11px] tracking-widest uppercase font-bold border transition-colors",
          canSubmit
            ? "border-accent text-accent hover:bg-accent/5"
            : "border-card-border text-muted opacity-40 cursor-not-allowed",
        )}
      >
        {!authenticated
          ? "Connect Wallet"
          : !event
            ? "Pick an event"
            : phase === "encrypting"
              ? "ENCRYPTING…"
              : phase === "signing"
                ? "APPROVE IN WALLET…"
                : phase === "submitting"
                  ? "CONFIRMING…"
                  : `${blindMode ? "BLIND " : ""}DEPOSIT $${amountNum > 0 ? amountNum.toFixed(2) : "0.00"}`}
      </button>

      {phaseDetail && (
        <p className="text-[10px] text-muted animate-pulse">{phaseDetail}</p>
      )}

      {resultMsg && (
        <div
          className={clsx(
            "p-3 border text-[10px]",
            resultMsg.ok
              ? "border-accent/30 bg-accent/5 text-accent"
              : "border-danger/30 bg-danger/5 text-danger",
          )}
        >
          <p className="font-bold tracking-widest uppercase">
            {resultMsg.ok ? "Deposit sealed" : "Failed"}
          </p>
          <p className="mt-1 leading-snug">{resultMsg.msg}</p>
          {resultMsg.ctHex && (
            <p className="mt-1 font-mono text-[9px] text-muted truncate">
              FHE ct: {resultMsg.ctHex.slice(0, 16)}…
            </p>
          )}
        </div>
      )}

      {!authenticated && (
        <button
          type="button"
          onClick={login}
          className="w-full py-2 text-[10px] tracking-widest uppercase text-accent hover:bg-accent/5 border border-accent/30"
        >
          Log in with Privy
        </button>
      )}
    </div>
  );
}

function cleanError(raw: string): string {
  if (raw.includes("EventClosed")) return "Event has closed.";
  if (raw.includes("InsufficientBalance")) return "Not enough USDC in your wallet.";
  if (raw.includes("InvalidEventTiming")) return "Lockup window invalid for this event.";
  if (raw.includes("rejected")) return "Transaction rejected in wallet.";
  if (raw.length > 100) return raw.slice(0, 100) + "…";
  return raw;
}

// Lightweight base58 encoder for displaying tx signatures. Avoids pulling
// in @solana/web3.js just for this.
function bytesToBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (bytes.length === 0) return "";
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    s = ALPHABET[r] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}
