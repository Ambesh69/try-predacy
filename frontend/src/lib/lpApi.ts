/**
 * Liquidity Stack API client — wraps the relayer's LP/event endpoints
 * (docs/LIQUIDITY.md). Used by the `/lp` page and its components.
 *
 * Endpoint surface (as of relayer commit 6135d67):
 *   GET  /events                     — list events with graduation/fee meta
 *   POST /events                     — operator-only, creates EventHandle
 *   POST /events/:id/markets         — operator-only, binds market
 *   POST /lp/commit                  — build unsigned plaintext commit tx
 *   POST /lp/commit-blind            — build unsigned blind commit tx (FHE encrypt)
 *   GET  /lp/positions?wallet=…       — list LP positions across events
 *   POST /lp/withdraw                — build unsigned withdraw tx
 *
 * The tx-building endpoints return a base64-encoded `Transaction`. The
 * frontend deserializes, signs via Privy, and submits to Solana.
 */

import { getRelayerUrl } from "./relayerUrl";

export type EventCategory = "LiveStream" | "Sports" | "Crypto" | "Politics" | "Custom";

export interface EventDescriptor {
  /** Hex-encoded 32-byte handle id (sha256 of label). */
  handleId: string;
  /** Original human-readable label. Optional — older entries created
   *  before the label field was added on the relayer may not have one. */
  label?: string;
  category: EventCategory;
  /** Base58 PDA on Solana. */
  eventHandlePda: string;
  /** Unix seconds. After this, capital auto-refunds. */
  closesAt: number;
  /** 6-decimal USDC, stringified bigint. */
  graduationThresholdUsdc: string;
  graduationBatches: number;
  graduated: boolean;
  /** 6-decimal USDC, stringified. Cumulative across all batches. */
  cumulativeVolumeUsdc: string;
  marketCount: number;
  feeBpsTaker: number;
  feeBpsTreasury: number;
  feeBpsRebates: number;
  bootstrapSeedUsdc: string;
  closed: boolean;
  /** Hex conditionIds (lowercase, no 0x) of markets bound under this event.
   *  Optional because pre-marketIds entries from older relayer deploys lack it. */
  marketIds?: string[];
  /** Human-readable label per attached market, keyed by marketId hex. */
  marketLabels?: Record<string, string>;
  /** Final per-market resolution once SettlementEngine has fired
   *  resolve_market on-chain. Keys are marketId hex, values "YES"/"NO".
   *  Markets not in this map are still UNRESOLVED. */
  resolutions?: Record<string, "YES" | "NO">;
}

export interface PredacyMarketMeta {
  marketId: string;
  label: string | null;
  eventHandleId: string;
  eventLabel: string | null;
  eventCategory: EventCategory;
  eventClosesAt: number;
  feeBpsTaker: number;
  feeBpsRebates: number;
  graduated: boolean;
  /** True once SettlementEngine has resolved the market on-chain. */
  resolved?: boolean;
  /** "YES" or "NO" — the winning side. null/undefined while unresolved. */
  outcome?: "YES" | "NO" | null;
}

export async function getEvent(handleIdHex: string): Promise<EventDescriptor | null> {
  const events = await listEvents();
  return events.find((e) => e.handleId.toLowerCase() === handleIdHex.toLowerCase()) ?? null;
}

export async function getPredacyMarket(marketIdHex: string): Promise<PredacyMarketMeta | null> {
  try {
    return await relayerJson<PredacyMarketMeta>(
      `/market/${marketIdHex.replace(/^0x/, "")}`,
    );
  } catch {
    return null;
  }
}

// ─── Agent stats (live table state from the streamMonitor) ──────────

export interface PerPlayerStats {
  bluffs: number;
  biggestPotWonUsd: number;
  handsWon: number;
  bustedAt: number | null;
  allInsBy: number;
}

export interface SessionStatsRecord {
  sessionLabel: string;
  handleIdHex: string;
  startedAt: number;
  lastSnapshotAt: number;
  framesProcessed: number;
  players: Record<string, PerPlayerStats>;
  maxPotSoFar: number;
  maxPotWinnerName: string | null;
  quadsHit: boolean;
  royalFlushHit: boolean;
  allInsCount: number;
  bustsCount: number;
  firstBustAt: number | null;
  currentBoardCardCount: number;
  handsSeen: number;
}

export async function getSessionStats(handleIdHex: string): Promise<SessionStatsRecord | null> {
  try {
    return await relayerJson<SessionStatsRecord>(
      `/agent/stats?handleId=${encodeURIComponent(handleIdHex)}`,
    );
  } catch {
    return null;
  }
}

export interface LPPosition {
  /** Hex handle id of the event this position is in. */
  handleId: string;
  category: EventCategory;
  eventHandlePda: string;
  /** 6-decimal USDC, stringified. */
  shares: string;
  depositedUsdc: string;
  depositedAt: number;
  commitmentExpiresAt: number;
  withdrawn: boolean;
}

export interface CommitTxResponse {
  ok: true;
  txBase64: string;
  /** Present only on /lp/commit-blind when FHE encryption succeeded. */
  ciphertextIdHex?: string;
  /** "blind" = real FHE ciphertext stored on-chain. "plaintext-fallback" =
   *  Encrypt unavailable, plaintext path used (still functional). */
  mode?: "blind" | "plaintext-fallback";
}

export interface WithdrawTxResponse {
  ok: true;
  txBase64: string;
}

async function relayerJson<T>(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<T> {
  const url = `${getRelayerUrl()}${path}`;
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) detail = j.error;
    } catch { /* noop */ }
    throw new Error(`relayer ${path}: ${detail}`);
  }
  return (await res.json()) as T;
}

export async function listEvents(): Promise<EventDescriptor[]> {
  const j = await relayerJson<{ events: EventDescriptor[] }>("/events");
  return j.events;
}

export async function listLpPositions(wallet: string): Promise<LPPosition[]> {
  const j = await relayerJson<{ positions: LPPosition[] }>(
    `/lp/positions?wallet=${encodeURIComponent(wallet)}`,
  );
  return j.positions;
}

export async function buildCommitTx(args: {
  /** "blind" hits /lp/commit-blind (FHE encrypt + on-chain ciphertext id).
   *  "plaintext" hits /lp/commit. Both produce an unsigned tx. */
  mode: "blind" | "plaintext";
  handleIdHex: string;
  depositor: string;
  /** 6-decimal USDC as bigint string. */
  amount: string;
  /** Unix seconds. */
  commitmentExpiresAt: number;
}): Promise<CommitTxResponse> {
  const path = args.mode === "blind" ? "/lp/commit-blind" : "/lp/commit";
  return relayerJson<CommitTxResponse>(path, {
    method: "POST",
    body: {
      handleIdHex: args.handleIdHex,
      depositor: args.depositor,
      amount: args.amount,
      commitmentExpiresAt: args.commitmentExpiresAt,
    },
  });
}

export async function buildWithdrawTx(args: {
  handleIdHex: string;
  depositor: string;
  cranker: string;
}): Promise<WithdrawTxResponse> {
  return relayerJson<WithdrawTxResponse>("/lp/withdraw", {
    method: "POST",
    body: args,
  });
}

/** Decode a base64-encoded `Transaction` blob from the relayer into a
 *  `Uint8Array` ready for `useSignAndSendTransaction`. Browser-only. */
export function decodeTxBase64(b64: string): Uint8Array {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes;
}

/** Convenience formatters for UI display. */
export function formatUsdc6(microStr: string | bigint, decimals = 2): string {
  const micro = typeof microStr === "bigint" ? microStr : BigInt(microStr);
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  const fracStr = String(frac).padStart(6, "0").slice(0, decimals);
  return decimals > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

export function relativeTime(unixSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const dt = unixSec - now;
  const abs = Math.abs(dt);
  const sign = dt >= 0 ? "in " : "";
  const past = dt < 0 ? " ago" : "";
  if (abs < 60) return `${sign}${abs}s${past}`;
  if (abs < 3600) return `${sign}${Math.floor(abs / 60)}m${past}`;
  if (abs < 86400) return `${sign}${Math.floor(abs / 3600)}h${past}`;
  return `${sign}${Math.floor(abs / 86400)}d${past}`;
}
