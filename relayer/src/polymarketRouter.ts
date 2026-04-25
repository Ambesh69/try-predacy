import { Order, OrderSide, PRICE_DECIMALS } from "./types";
import { PairMatchingResult } from "./pairMatcher";
import { getLPRegistry, LPQuote } from "./lpRegistry";

/**
 * Mock Polymarket CLOB router.
 *
 * In the production flow, residual order quantities identified by
 * `computePairMatching()` would be:
 *   1. Unlocked from the user's shielded Solana USDC via Ika MPC
 *   2. Bridged to an LP's Polygon USDC address (atomically, Ika-signed)
 *   3. Posted as individual limit orders on Polymarket's CLOB
 *   4. Matched against existing book liquidity at each user's limit price
 *   5. Fill receipts bridged back to Solana via Ika signature attestation
 *
 * See ARCHITECTURE.md §5.3 + §6.3 Path B.
 *
 * On devnet, Polygon + Polymarket + LPs don't exist, so this module plays
 * the role of all four. It takes the residuals from the batch and produces
 * a structured "routing receipt" — a log entry per synthetic CLOB order —
 * that mirrors what the relayer would emit on mainnet. The actual token
 * movement on-chain is still handled by the existing `lock_funds` /
 * `settle_batch` flow (protocol as universal counterparty); the router's
 * output is advisory metadata for observability + API.
 *
 * When we move to mainnet: swap this file's `simulate` path for real Ika
 * CPI + Polymarket CLOB calls. The classification logic in `pairMatcher.ts`
 * stays exactly the same.
 */

export interface CLOBFillReceipt {
  /** Which side of the order this receipt covers. */
  side: OrderSide;
  /** Token quantity filled (6-decimal). */
  qty: bigint;
  /** User's limit price that would be posted to Polymarket (6-decimal). */
  limitPrice: bigint;
  /**
   * USDC value transferred. For BUY: amount paid. For SELL: proceeds received.
   */
  usdcValue: bigint;
  /**
   * Synthetic fill price in 6-decimal. On devnet we assume full fill at the
   * clearing price (simplification). Real Polymarket CLOB would fill against
   * the book at market-determined prices, possibly partial.
   */
  fillPrice: bigint;
  /** Tag so we can tell mock vs real at a glance in logs + API. */
  source: "mock-devnet" | "polymarket-mainnet";
}

export interface CLOBRoutingSummary {
  /** One receipt per user order that had a residual portion routed. */
  receipts: CLOBFillReceipt[];
  /** Total USDC that would leave the Solana vaults via LP / Ika. */
  totalUsdcToLp: bigint;
  /** Total USDC that would come back in from Polymarket fills. */
  totalUsdcFromPolymarket: bigint;
  /** Wall-clock ms spent simulating the route (mostly just logging). */
  elapsedMs: number;
  /**
   * LP reservation details — present iff the buy-side residuals needed
   * Polygon USDC (sell-side doesn't require LP capital because USDC flows
   * IN from Polymarket, not OUT). Null means either no residuals or the
   * batch was pure-sell.
   */
  lpQuote: LPQuote | null;
  /** Set when no LP could cover the buy-side residuals. */
  lpUnavailable: boolean;
}

/**
 * Route residuals to (mock) Polymarket CLOB.
 *
 * This is pure metadata — no on-chain txs are issued. The batch's lock_funds
 * / settle_batch path already moves the tokens in devnet's protocol-as-MM
 * model. What we return here is the "routing manifest" the frontend and
 * settlement API use to show `matched = X%, CLOB = Y%`.
 */
export async function routeResiduals(
  filledOrders: Order[],
  clearingPrice: bigint,
  matching: PairMatchingResult,
): Promise<CLOBRoutingSummary> {
  const startedAt = Date.now();
  const noPrice = PRICE_DECIMALS - clearingPrice;

  // If every side balanced out, nothing goes to CLOB — log and return.
  const nothingToRoute =
    matching.residualYesBuyQty === 0n &&
    matching.residualNoBuyQty === 0n &&
    matching.residualYesSellQty === 0n &&
    matching.residualNoSellQty === 0n;

  if (nothingToRoute) {
    console.log(
      `[polymarketRouter] All filled volume matched as complete-set pairs — no CLOB routing needed.`,
    );
    return {
      receipts: [],
      totalUsdcToLp: 0n,
      totalUsdcFromPolymarket: 0n,
      elapsedMs: Date.now() - startedAt,
      lpQuote: null,
      lpUnavailable: false,
    };
  }

  // Reserve LP capital for the buy-side USDC outflow. Compute this BEFORE
  // we build receipts so we can bail out early if no LP can cover.
  const buySideUsdc =
    (matching.residualYesBuyQty * clearingPrice) / PRICE_DECIMALS +
    (matching.residualNoBuyQty * noPrice) / PRICE_DECIMALS;

  let lpQuote: LPQuote | null = null;
  let lpUnavailable = false;
  if (buySideUsdc > 0n) {
    const registry = getLPRegistry();
    lpQuote = registry.reserveCapital(buySideUsdc);
    if (!lpQuote) {
      lpUnavailable = true;
      console.warn(
        `[polymarketRouter] ⚠ No LP has $${Number(buySideUsdc) / 1e6} of Polygon USDC available — ` +
          `buy-side residuals cannot be routed. In production this would abort the batch via Ika.`,
      );
    } else {
      console.log(
        `[polymarketRouter] Reserved $${Number(lpQuote.usdcAmount) / 1e6} from ${lpQuote.displayName} ` +
          `(lp=${lpQuote.lpId}, fee=${lpQuote.feeBps}bps = $${Number(lpQuote.feeUsdc) / 1e6})`,
      );
    }
  }

  const receipts: CLOBFillReceipt[] = [];
  let totalUsdcToLp = 0n;
  let totalUsdcFromPolymarket = 0n;

  // Walk through residual quantities side-by-side, attributing each to the
  // user order that contributed. For the purposes of the mock we spread the
  // residual evenly across the filled orders of the matching side.
  const bySide = {
    [OrderSide.YES_BUY]: filledOrders.filter((o) => o.side === OrderSide.YES_BUY),
    [OrderSide.NO_BUY]: filledOrders.filter((o) => o.side === OrderSide.NO_BUY),
    [OrderSide.YES_SELL]: filledOrders.filter((o) => o.side === OrderSide.YES_SELL),
    [OrderSide.NO_SELL]: filledOrders.filter((o) => o.side === OrderSide.NO_SELL),
  };

  const routeSide = (
    side: OrderSide,
    residualQty: bigint,
    isBuy: boolean,
    fillPrice: bigint,
  ) => {
    if (residualQty === 0n) return;
    const orders = bySide[side];
    if (orders.length === 0) return;

    // For BUYs, residualQty is in TOKEN UNITS (we already converted).
    // For SELLs, residualQty is also in TOKEN UNITS (seller-supplied quantity).
    // Spread proportionally across the orders of this side by their own size.
    const totalOrderQty = orders.reduce((acc, o) => {
      // Convert to TOKENS the same way: for BUY, tokens = amount / fillPrice;
      // for SELL, tokens = amount (already tokens).
      const tokens = isBuy ? (o.amount * PRICE_DECIMALS) / fillPrice : o.amount;
      return acc + tokens;
    }, 0n);
    if (totalOrderQty === 0n) return;

    for (const o of orders) {
      const orderTokens = isBuy ? (o.amount * PRICE_DECIMALS) / fillPrice : o.amount;
      const share = (residualQty * orderTokens) / totalOrderQty;
      if (share === 0n) continue;
      const usdcValue = (share * fillPrice) / PRICE_DECIMALS;

      receipts.push({
        side,
        qty: share,
        limitPrice: o.limitPrice,
        usdcValue,
        fillPrice,
        source: "mock-devnet",
      });

      if (isBuy) totalUsdcToLp += usdcValue;
      else totalUsdcFromPolymarket += usdcValue;
    }
  };

  routeSide(OrderSide.YES_BUY, matching.residualYesBuyQty, true, clearingPrice);
  routeSide(OrderSide.NO_BUY, matching.residualNoBuyQty, true, noPrice);
  routeSide(OrderSide.YES_SELL, matching.residualYesSellQty, false, clearingPrice);
  routeSide(OrderSide.NO_SELL, matching.residualNoSellQty, false, noPrice);

  console.log(
    `[polymarketRouter] Simulated ${receipts.length} CLOB orders: ` +
      `$${Number(totalUsdcToLp) / 1e6} USDC to LP, ` +
      `$${Number(totalUsdcFromPolymarket) / 1e6} back from Polymarket ` +
      `(source=mock-devnet — real CLOB routing requires Ika + LP Polygon USDC).`,
  );

  // Confirm the LP's quote if we successfully generated receipts for the
  // buy side. In production this would fire after the Ika atomic swap
  // completes — failure would call releaseCapital instead.
  if (lpQuote && totalUsdcToLp > 0n) {
    const registry = getLPRegistry();
    registry.recordSettled(lpQuote.lpId, lpQuote);
  }

  return {
    receipts,
    totalUsdcToLp,
    totalUsdcFromPolymarket,
    elapsedMs: Date.now() - startedAt,
    lpQuote,
    lpUnavailable,
  };
}
