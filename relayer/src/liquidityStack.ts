/**
 * LiquidityStack — orchestrator for the Predacy three-tier liquidity model
 * (docs/LIQUIDITY.md). Called from `batchProcessor` at settlement time
 * with the residual imbalance from pair-matching, decides which tier
 * absorbs it, and submits the appropriate on-chain ix.
 *
 *   pre-graduation  → Tier 0 LMSR `bootstrapFill`
 *   post-graduation → Tier 1 LP vault `lpSettleBatch`
 *
 * Always runs Tier 2 maker rebate accrual independently (per-batch credit
 * accumulation regardless of which tier filled the residual).
 */

import { PublicKey } from "@solana/web3.js";
import { SolanaClient } from "./solanaClient";
import {
  EventHandleEntry,
  EventLedger,
  handleIdToHex,
} from "./eventLedger";
import {
  BootstrapPoolState,
  quoteBuy,
  quoteSell,
} from "./bootstrapCurve";

export interface ResidualImbalance {
  /** Net YES tokens the residual side wants to BUY (qty > 0)
   *  or SELL (qty < 0). 6-decimal share-units. */
  yesNetBuy: bigint;
  /** Net NO tokens the residual side wants to BUY (qty > 0)
   *  or SELL (qty < 0). 6-decimal. */
  noNetBuy: bigint;
  /** Clearing price set by pair-matching, 6-decimal. Used for sanity
   *  bounds + to compute Tier 1 USDC values. */
  clearingPrice: bigint;
  /** Cumulative taker volume in this batch (USDC, 6-decimal). Drives the
   *  rebate pool funding amount. */
  takerVolumeUsdc: bigint;
}

export interface MakerCreditPlan {
  maker: PublicKey;
  /** Volume the maker absorbed × `1 + distance_from_mid_bps / 100`.
   *  v1 just uses raw volume. */
  credit: bigint;
}

export interface LiquidityFillResult {
  tier: "tier0" | "tier1" | "none";
  /** `bootstrap_fill` or `lp_settle_batch` tx signature. null if no
   *  residual or skip. */
  txSig: string | null;
  /** Effective USDC the curve/vault paid or received on this fill. */
  usdcDelta: bigint;
  /** YES inventory delta on the absorbing tier (positive = tier
   *  absorbed YES tokens). */
  deltaYes: bigint;
  /** NO inventory delta on the absorbing tier. */
  deltaNo: bigint;
}

export class LiquidityStack {
  private client: SolanaClient;
  private ledger: EventLedger;

  constructor(client: SolanaClient, ledger: EventLedger) {
    this.client = client;
    this.ledger = ledger;
  }

  /**
   * Look up which event a market belongs to, return its current ledger
   * entry. Returns undefined if the market predates the Liquidity Stack
   * (existing markets that don't yet have an event handle attached) —
   * caller should fall back to legacy LP routing in that case.
   */
  resolveEvent(marketIdHex: string): EventHandleEntry | undefined {
    return this.ledger.findEventForMarket(marketIdHex);
  }

  /**
   * Route residual imbalance from a settled batch through the Liquidity
   * Stack. Side-effect: submits on-chain ix and mutates ledger state.
   */
  async absorbResidual(
    marketId: Buffer,
    residual: ResidualImbalance,
  ): Promise<LiquidityFillResult> {
    const marketIdHex = marketId.toString("hex");
    const ev = this.resolveEvent(marketIdHex);
    if (!ev) {
      // No event handle — legacy market, caller should use legacy router.
      return { tier: "none", txSig: null, usdcDelta: 0n, deltaYes: 0n, deltaNo: 0n };
    }

    // Update ledger graduation state from this batch's volume FIRST so the
    // routing decision sees the freshest signal.
    this.ledger.recordBatchVolume(marketIdHex, residual.takerVolumeUsdc);

    const eventHandleKey = new PublicKey(ev.eventHandlePda);

    if (!ev.graduated) {
      return await this.fillTier0(marketId, eventHandleKey, residual);
    } else {
      return await this.fillTier1(marketId, eventHandleKey, residual);
    }
  }

  /**
   * Tier 0 — pull residual from the LMSR Bootstrap Pool. Requires reading
   * current pool state from on-chain to price each fill correctly.
   */
  private async fillTier0(
    marketId: Buffer,
    eventHandleKey: PublicKey,
    residual: ResidualImbalance,
  ): Promise<LiquidityFillResult> {
    if (residual.yesNetBuy === 0n && residual.noNetBuy === 0n) {
      return { tier: "tier0", txSig: null, usdcDelta: 0n, deltaYes: 0n, deltaNo: 0n };
    }

    let pool: any;
    try {
      pool = await this.client.fetchBootstrapPool(marketId);
    } catch (err) {
      console.warn(`[LiquidityStack] Tier 0 not initialised for market ${marketId.toString("hex")} — skipping`);
      return { tier: "tier0", txSig: null, usdcDelta: 0n, deltaYes: 0n, deltaNo: 0n };
    }

    if (pool.graduated) {
      console.warn("[LiquidityStack] Tier 0 marked graduated on-chain but ledger says not — skipping");
      return { tier: "tier0", txSig: null, usdcDelta: 0n, deltaYes: 0n, deltaNo: 0n };
    }

    const state: BootstrapPoolState = {
      currentQ: BigInt(pool.currentQ.toString()),
      bParam: BigInt(pool.bParam.toString()),
      yesShares: BigInt(pool.yesShares.toString()),
      noShares: BigInt(pool.noShares.toString()),
    };

    // Pick the dominant side. v1 only fills one side per batch — if both
    // sides have residuals (rare in practice since pair-matching consumes
    // mutual demand), we route the larger and let the other carry to the
    // next batch.
    const yesAbs = residual.yesNetBuy > 0n ? residual.yesNetBuy : -residual.yesNetBuy;
    const noAbs = residual.noNetBuy > 0n ? residual.noNetBuy : -residual.noNetBuy;
    const useYes = yesAbs >= noAbs;

    const qty = useYes ? residual.yesNetBuy : residual.noNetBuy;
    const isBuy = qty > 0n;
    const qtyAbs = isBuy ? qty : -qty;
    if (qtyAbs === 0n) {
      return { tier: "tier0", txSig: null, usdcDelta: 0n, deltaYes: 0n, deltaNo: 0n };
    }

    const sideStr = useYes ? "yes" : "no";
    const quote = isBuy
      ? quoteBuy(state, sideStr, qtyAbs)
      : quoteSell(state, sideStr, qtyAbs);

    const sideU8 = sideForOnChain(useYes, isBuy);

    const txSig = await this.client.bootstrapFill({
      marketId,
      eventHandleKey,
      side: sideU8,
      qtyShares: qtyAbs,
      usdcPaid: quote.usdcAmount,
      isBuy,
    });

    return {
      tier: "tier0",
      txSig,
      usdcDelta: isBuy ? quote.usdcAmount : -quote.usdcAmount,
      deltaYes: useYes ? (isBuy ? qtyAbs : -qtyAbs) : 0n,
      deltaNo: !useYes ? (isBuy ? qtyAbs : -qtyAbs) : 0n,
    };
  }

  /**
   * Tier 1 — record vault inventory delta. The actual token movements
   * still flow through `lock_funds`; this ix just attests the per-batch
   * impact on the vault's net position + rebate accrual.
   */
  private async fillTier1(
    marketId: Buffer,
    eventHandleKey: PublicKey,
    residual: ResidualImbalance,
  ): Promise<LiquidityFillResult> {
    const ev = this.ledger.findEventForMarket(marketId.toString("hex"));
    if (!ev) {
      return { tier: "tier1", txSig: null, usdcDelta: 0n, deltaYes: 0n, deltaNo: 0n };
    }

    // Vault rebate share = `fee_bps_rebates / 10_000` of taker volume.
    const rebateShareUsdc =
      (residual.takerVolumeUsdc * BigInt(ev.feeBpsRebates)) / 10_000n;

    const txSig = await this.client.lpSettleBatch({
      eventHandleKey,
      deltaYesPosition: residual.yesNetBuy,
      deltaNoPosition: residual.noNetBuy,
      rebateShareUsdc,
    });

    return {
      tier: "tier1",
      txSig,
      usdcDelta: rebateShareUsdc,
      deltaYes: residual.yesNetBuy,
      deltaNo: residual.noNetBuy,
    };
  }

  /**
   * Tier 2 — accrue maker credits from a settled batch. Called separately
   * from `absorbResidual` because credits are computed off-chain from the
   * pair-matching results (which makers absorbed which taker volume).
   *
   * Caller passes the planned credits; we batch-issue them on-chain.
   */
  async accrueMakerCredits(
    marketIdHex: string,
    plan: MakerCreditPlan[],
  ): Promise<{ accrued: number; failed: number }> {
    const ev = this.resolveEvent(marketIdHex);
    if (!ev) return { accrued: 0, failed: 0 };
    if (plan.length === 0) return { accrued: 0, failed: 0 };

    const eventHandleKey = new PublicKey(ev.eventHandlePda);
    let accrued = 0;
    let failed = 0;
    for (const credit of plan) {
      try {
        await this.client.accrueMakerCredit({
          eventHandleKey,
          maker: credit.maker,
          credit: credit.credit,
        });
        accrued++;
      } catch (err: any) {
        console.error(`[LiquidityStack] accrueMakerCredit failed for ${credit.maker.toBase58()}:`, err.message);
        failed++;
      }
    }
    return { accrued, failed };
  }

  /** Get the active event for a market, useful for logs and UI. */
  getEvent(marketIdHex: string): EventHandleEntry | undefined {
    return this.resolveEvent(marketIdHex);
  }
}

/** Map (yesSide, isBuy) → on-chain `OrderSide` u8 (0=YES_BUY 1=YES_SELL 2=NO_BUY 3=NO_SELL). */
function sideForOnChain(yesSide: boolean, isBuy: boolean): number {
  if (yesSide) return isBuy ? 0 : 1;
  return isBuy ? 2 : 3;
}

let instance: LiquidityStack | null = null;
export function getLiquidityStack(client: SolanaClient, ledger: EventLedger): LiquidityStack {
  if (!instance) instance = new LiquidityStack(client, ledger);
  return instance;
}
