import { PublicKey } from "@solana/web3.js";

// ─── Order Sides (matches Solana program) ───

export enum OrderSide {
  YES_BUY = 0,
  YES_SELL = 1,
  NO_BUY = 2,
  NO_SELL = 3,
}

export enum BatchStatus {
  OPEN = 0,
  SETTLING = 1,
  LOCKED = 2,
  SETTLED = 3,
}

// ─── Order (submitted by user) ───

export interface Order {
  side: OrderSide;
  amount: bigint;       // USDC (BUY) or token qty (SELL), 6 decimals
  limitPrice: bigint;   // 6-decimal fixed point (e.g. 650000n = $0.65)
  salt: bigint;         // 256-bit random secret
  commitment?: bigint;  // Poseidon commitment hash (computed by relayer)
}

// ─── Clearing Price Result ───

export interface ClearingResult {
  clearingPrice: bigint;
  filledYesBuyVol: bigint;
  filledNoBuyVol: bigint;
  filledYesSellQty: bigint;
  filledNoSellQty: bigint;
  filledOrders: Order[];
  unfilledOrders: Order[];
}

// ─── Per-Market State ───

export interface MarketState {
  marketId: Buffer;           // 32 bytes
  currentBatchId: bigint | null;
  settlingBatchId: bigint | null;
  processingBatch: boolean;
  openingBatch: boolean;
  closingBatch: boolean;
  batchRunningUsd: bigint;
  lastOrderSubmitAt: number;
  batchOpenedAt: number;      // unix seconds when current batch opened
  settlingStartedAt: number;  // unix seconds when settling began (0 if not settling)
  orders: Map<string, Order>; // commitment hash → order
  /** Per-market batch window override. Hand-level markets ("Will X
   *  win hand #N?") use 10s so the trading window doesn't eat the
   *  whole hand; session/H2H markets keep the default 30s where
   *  privacy + frontrunning protection matter more than speed.
   *  Falls back to BATCH_WINDOW_MS when undefined. */
  batchWindowMsOverride?: number;
}

// ─── Claim Job ───

export interface ClaimJob {
  id: string;
  status: "pending" | "proving" | "submitting" | "done" | "error";
  batchId: bigint;
  marketId: Buffer;
  side: OrderSide;
  amount: bigint;
  limitPrice: bigint;
  salt: bigint;
  recipient: PublicKey;
  txHash?: string;
  error?: string;
}

// ─── ZK Proof ───

export interface Groth16Proof {
  proofA: Uint8Array;  // 64 bytes (G1)
  proofB: Uint8Array;  // 128 bytes (G2)
  proofC: Uint8Array;  // 64 bytes (G1)
}

// ─── Constants ───

export const PRICE_DECIMALS = 1_000_000n;
export const BATCH_WINDOW_MS = 30_000;
/** Tighter batch window for hand-level markets — a poker hand lasts
 *  60-180s, so a 30s sealed-bid window eats half the trading time. 10s
 *  keeps the privacy/frontrunning guarantee while feeling closer to
 *  Pumpcade's "instant" cadence on short-duration markets. */
export const HAND_LEVEL_BATCH_WINDOW_MS = 10_000;
export const MAX_BATCH_ORDERS = 8; // circuit limit
export const MAX_BATCH_USD = 5_000_000_000n; // $5,000 in 6-dec
