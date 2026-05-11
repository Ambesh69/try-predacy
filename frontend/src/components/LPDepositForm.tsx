"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Connection } from "@solana/web3.js";
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
import { getRelayerUrl } from "@/lib/relayerUrl";

// Browser-side polling RPC. Has to be CORS-friendly — our private rpcfast
// URL (NEXT_PUBLIC_SOLANA_RPC_URL) doesn't allow cross-origin browser
// requests, so we pin this to the public devnet endpoint regardless of
// the env var. Public devnet has lower rate limits but we only hit it
// during the 45s confirmation window per deposit.
const BROWSER_RPC_URL = "https://api.devnet.solana.com";

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
  const { wallets: solanaWallets } = useSolanaWallets();
  // Privy exposes BOTH the user's linked external wallet (e.g. Phantom)
  // AND an auto-provisioned embedded Privy wallet via useSolanaWallets().
  // We want the user's external wallet — the one they trade from — for
  // both the depositor address and the signer. Match by address against
  // user.linkedAccounts so we don't accidentally route the deposit
  // through the embedded wallet (different pubkey, separate USDC
  // balance, confusing UX).
  const linkedSolanaMeta = user?.linkedAccounts?.find(
    (a: any) => a.type === "wallet" && a.chainType === "solana",
  ) as any;
  const linkedAddress: string | undefined =
    linkedSolanaMeta?.address ?? user?.wallet?.address;
  const wallet =
    solanaWallets.find((w) => w.address === linkedAddress) ?? solanaWallets[0];
  const walletAddress: string | undefined = wallet?.address ?? linkedAddress;
  const { signAndSendTransaction } = useSignAndSendTransaction();

  const [amount, setAmount] = useState("");
  const [presetIdx, setPresetIdx] = useState(0);
  const [blindMode, setBlindMode] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [phaseDetail, setPhaseDetail] = useState("");
  const [resultMsg, setResultMsg] = useState<{ ok: boolean; msg: string; ctHex?: string; sig?: string } | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);

  // Fetch the depositor's USDC balance — surfaces an explicit "fund your
  // wallet" error before the user wastes a signing round-trip. Uses the
  // demo market id since /balances just needs any marketId to derive the
  // USDC ATA (the mint is shared).
  useEffect(() => {
    if (!walletAddress) {
      setUsdcBalance(null);
      return;
    }
    let cancelled = false;
    async function refresh() {
      try {
        const demoMarketId = Buffer.from("predacy-demo-v1")
          .toString("hex")
          .padEnd(64, "0");
        const res = await fetch(
          `${getRelayerUrl()}/balances?wallet=${walletAddress}&marketId=${demoMarketId}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setUsdcBalance(BigInt(data.usdc ?? "0"));
      } catch {
        /* keep prior value */
      }
    }
    refresh();
    const iv = setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [walletAddress]);

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
    // Captured outside the try block so the catch can surface the
    // explorer link even when the confirmation poll times out / reverts.
    let capturedSig: string | undefined;

    try {
      const amountMicro = BigInt(Math.floor(amountNum * 1_000_000));
      const expiresAt = commitmentExpiresAt();

      // ── Phase 0: pre-flight balance check. Catches the
      // most common failure mode (depositor wallet underfunded) before
      // we waste a signing round-trip and end up with a dropped tx that
      // never lands on-chain.
      if (usdcBalance !== null && amountMicro > usdcBalance) {
        const have = (Number(usdcBalance) / 1_000_000).toFixed(2);
        throw new Error(
          `Not enough USDC in ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)} — you have $${have}, need $${amountNum.toFixed(2)}. Fund this address and retry.`,
        );
      }

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
      // signAndSendTransaction is Privy's blessed path — the
      // wallet.signTransaction direct call doesn't actually exist on
      // the Privy ConnectedSolanaWallet shape and threw "e is not
      // iterable". The relayer now top-ups the depositor's SOL via a
      // separate tx before returning this one, so the previous "tx
      // dropped during preflight" issue is also handled.
      setPhase("signing");
      setPhaseDetail("Approve in your wallet…");
      const txBytes = decodeTxBase64(built.txBase64);
      // Diagnostic: surface the addresses involved so the user can
      // verify Privy is signing with the expected wallet. Mismatch
      // here = invalid signature = tx silently dropped at preflight.
      // eslint-disable-next-line no-console
      console.log("[LPDeposit] signer/depositor", {
        signerAddress: (wallet as any)?.address,
        walletType: (wallet as any)?.walletClientType,
        depositorInTx: walletAddress,
        linkedAddress,
        allWallets: solanaWallets.map((w: any) => ({
          address: w.address,
          type: w.walletClientType,
        })),
      });
      const result = await signAndSendTransaction({
        transaction: txBytes,
        wallet: wallet as any,
        chain: "solana:devnet" as any,
      });

      setPhase("submitting");
      setPhaseDetail("Confirming on Solana…");
      const sig = bytesToBase58(result.signature);
      capturedSig = sig;
      // eslint-disable-next-line no-console
      console.log("[LPDeposit] submitted tx", sig, `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      const conn = new Connection(BROWSER_RPC_URL, "confirmed");
      const deadline = Date.now() + 45_000;
      let confirmed = false;
      while (Date.now() < deadline) {
        const r = await conn.getSignatureStatuses([sig], {
          searchTransactionHistory: false,
        });
        const s = r.value?.[0];
        if (s) {
          if (s.err) {
            throw new Error(
              `Deposit reverted on-chain: ${JSON.stringify(s.err)}`,
            );
          }
          if (
            s.confirmationStatus === "confirmed" ||
            s.confirmationStatus === "finalized"
          ) {
            confirmed = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      if (!confirmed) {
        throw new Error(
          "Deposit not confirmed within 45s — check the explorer with the signature below.",
        );
      }

      setPhase("success");
      setPhaseDetail("");
      setResultMsg({
        ok: true,
        msg: `Deposited $${amountNum.toFixed(2)} to ${event.handleId.slice(0, 8)}…`,
        ctHex: built.ciphertextIdHex,
        sig,
      });
      pushToast(
        "success",
        actualMode === "blind" ? "Blind LP committed" : "LP committed",
        `$${amountNum.toFixed(2)} · tx ${sig.slice(0, 6)}…${sig.slice(-4)}`,
      );
      setAmount("");
      onDeposited?.();
      // 30s — long enough for the user to click the explorer link if
      // they want to inspect the tx. They can dismiss it manually by
      // starting another deposit (setResultMsg(null) on submit).
      setTimeout(() => {
        setPhase("idle");
        setResultMsg(null);
      }, 30_000);
    } catch (err: any) {
      setPhase("error");
      setPhaseDetail("");
      const msg = cleanError(err.message ?? "Deposit failed");
      setResultMsg({ ok: false, msg, sig: capturedSig });
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
        <div className="flex items-baseline justify-between">
          <label className="text-[10px] tracking-widest uppercase text-muted">
            Amount (USDC)
          </label>
          {authenticated && (
            <span className="text-[10px] text-muted tabular-nums">
              Balance:{" "}
              <span
                className={clsx(
                  "font-mono",
                  usdcBalance === null
                    ? "text-muted-dim"
                    : amountNum > 0 &&
                        BigInt(Math.floor(amountNum * 1_000_000)) > usdcBalance
                      ? "text-danger"
                      : "text-text",
                )}
              >
                {usdcBalance === null
                  ? "…"
                  : `$${(Number(usdcBalance) / 1_000_000).toFixed(2)}`}
              </span>
            </span>
          )}
        </div>
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
          {resultMsg.sig && (
            <a
              href={`https://explorer.solana.com/tx/${resultMsg.sig}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block font-mono text-[9px] text-muted hover:text-accent underline decoration-dotted underline-offset-2 truncate max-w-full"
              title={resultMsg.sig}
            >
              tx {resultMsg.sig.slice(0, 12)}…{resultMsg.sig.slice(-8)} ↗
            </a>
          )}
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
  // SPL token program returns this on insufficient source balance — surface
  // it in plain English so the user knows to fund the right wallet.
  if (raw.includes("0x1") && raw.toLowerCase().includes("custom"))
    return "Not enough USDC in your wallet — fund the connected address and retry.";
  if (raw.includes("InvalidEventTiming")) return "Lockup window invalid for this event.";
  if (raw.includes("rejected")) return "Transaction rejected in wallet.";
  if (raw.length > 120) return raw.slice(0, 120) + "…";
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
