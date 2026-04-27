/**
 * LS-LMSR pricing for the Tier 0 Bootstrap Pool. See docs/LIQUIDITY.md §5.1
 * for design rationale, on-chain `BootstrapPool` account in
 * programs/predacy/src/state.rs for the state we mutate.
 *
 * LS-LMSR ("liquidity-sensitive LMSR", originally Othman & Sandholm 2010,
 * popularized for prediction markets by Augur) is the same family of curve
 * xo.market revived recently. Two properties we care about:
 *
 *   1. **Bounded loss.** For a binary market, max loss to the seeder is
 *      `b × ln(2)`. With b = α × Q and α = 1.44, that's ≈ Q. So a $100-
 *      seeded pool bounds protocol loss at ~$100. Predictable cost of
 *      running price discovery before Tier 1 graduates in.
 *
 *   2. **Liquidity-sensitivity.** The `b` parameter scales with total
 *      collateral Q. As trades flow in, Q grows, b grows, the curve
 *      naturally deepens — no manual top-ups, no LP refresh cycles.
 *
 * Math (binary case, YES + NO = 1):
 *   Cost function:  C(q_y, q_n) = b * ln(e^(q_y/b) + e^(q_n/b))
 *   Marginal price: p_yes = e^(q_y/b) / (e^(q_y/b) + e^(q_n/b))
 *   Buy cost:       cost(Δq, side) = C(q_y', q_n') - C(q_y, q_n)
 *
 * We use log-sum-exp factoring to avoid overflow when q/b is large:
 *   ln(e^a + e^b) = max(a,b) + ln(1 + e^(min(a,b) - max(a,b)))
 */

export interface BootstrapPoolState {
  /** 6-decimal USDC. Total collateral in the pool. */
  currentQ: bigint;
  /** Liquidity parameter — for LS-LMSR, b = α × Q. */
  bParam: bigint;
  /** Outstanding YES shares (6-decimal). */
  yesShares: bigint;
  /** Outstanding NO shares (6-decimal). */
  noShares: bigint;
}

/** Result of a curve-priced fill. All numbers in 6-decimal USDC / shares. */
export interface BootstrapQuote {
  /** USDC the curve charges (when isBuy=true) or pays out (when isBuy=false). */
  usdcAmount: bigint;
  /** Marginal price after the fill, 6-decimal fixed point. */
  marginalPriceAfter: number;
  /** Marginal price before the fill, for slippage display. */
  marginalPriceBefore: number;
}

/** Convert 6-decimal bigint to JS number for log/exp work. */
function toFloat(x: bigint): number {
  return Number(x) / 1_000_000;
}

/** Convert JS number back to 6-decimal bigint, rounding half-up. */
function fromFloat(x: number): bigint {
  return BigInt(Math.round(x * 1_000_000));
}

/**
 * log-sum-exp-stable cost function:
 *   C(q_y, q_n) = b * ln(e^(q_y/b) + e^(q_n/b))
 *               = b * (max + ln(1 + e^(min - max)))
 * where max, min are q_y/b, q_n/b.
 */
function lmsrCost(qYes: number, qNo: number, b: number): number {
  if (b <= 0) throw new Error("LMSR: b must be > 0");
  const yScaled = qYes / b;
  const nScaled = qNo / b;
  const hi = Math.max(yScaled, nScaled);
  const lo = Math.min(yScaled, nScaled);
  return b * (hi + Math.log1p(Math.exp(lo - hi)));
}

/** Marginal price (probability) for a side given current state. */
export function marginalPrice(
  state: BootstrapPoolState,
  side: "yes" | "no",
): number {
  const b = toFloat(state.bParam);
  const qY = toFloat(state.yesShares);
  const qN = toFloat(state.noShares);
  if (b <= 0) return 0.5;

  const yScaled = qY / b;
  const nScaled = qN / b;
  const hi = Math.max(yScaled, nScaled);
  // logSumExp = hi + log(1 + e^(lo-hi))
  const num = side === "yes" ? Math.exp(yScaled - hi) : Math.exp(nScaled - hi);
  const denom = Math.exp(yScaled - hi) + Math.exp(nScaled - hi);
  return num / denom;
}

/**
 * Quote the cost to BUY `qtyShares` of `side` against the curve.
 * Buyer pays `usdcAmount`, pool gains `qtyShares` outstanding on that side.
 *
 * Pre-condition: `qtyShares > 0`.
 */
export function quoteBuy(
  state: BootstrapPoolState,
  side: "yes" | "no",
  qtyShares: bigint,
): BootstrapQuote {
  if (qtyShares <= 0n) {
    throw new Error(`bootstrap.quoteBuy: qtyShares must be > 0, got ${qtyShares}`);
  }
  const b = toFloat(state.bParam);
  const qY = toFloat(state.yesShares);
  const qN = toFloat(state.noShares);
  const dq = toFloat(qtyShares);

  const before = lmsrCost(qY, qN, b);
  const after =
    side === "yes" ? lmsrCost(qY + dq, qN, b) : lmsrCost(qY, qN + dq, b);
  const cost = after - before;

  return {
    usdcAmount: fromFloat(cost),
    marginalPriceBefore: marginalPrice(state, side),
    marginalPriceAfter: marginalPrice(
      side === "yes"
        ? { ...state, yesShares: state.yesShares + qtyShares }
        : { ...state, noShares: state.noShares + qtyShares },
      side,
    ),
  };
}

/**
 * Quote the USDC paid out to SELL `qtyShares` of `side` back to the curve.
 * The pool buys back the shares; outstanding shares on that side decrease.
 *
 * Pre-condition: `qtyShares > 0` and `qtyShares <= state.{yes,no}Shares`.
 */
export function quoteSell(
  state: BootstrapPoolState,
  side: "yes" | "no",
  qtyShares: bigint,
): BootstrapQuote {
  if (qtyShares <= 0n) {
    throw new Error(`bootstrap.quoteSell: qtyShares must be > 0, got ${qtyShares}`);
  }
  const outstanding = side === "yes" ? state.yesShares : state.noShares;
  if (qtyShares > outstanding) {
    throw new Error(
      `bootstrap.quoteSell: cannot sell ${qtyShares} shares; pool has ${outstanding} outstanding`,
    );
  }
  const b = toFloat(state.bParam);
  const qY = toFloat(state.yesShares);
  const qN = toFloat(state.noShares);
  const dq = toFloat(qtyShares);

  const before = lmsrCost(qY, qN, b);
  const after =
    side === "yes" ? lmsrCost(qY - dq, qN, b) : lmsrCost(qY, qN - dq, b);
  // sell payout = before - after (curve pays out the cost differential)
  const payout = before - after;

  return {
    usdcAmount: fromFloat(payout),
    marginalPriceBefore: marginalPrice(state, side),
    marginalPriceAfter: marginalPrice(
      side === "yes"
        ? { ...state, yesShares: state.yesShares - qtyShares }
        : { ...state, noShares: state.noShares - qtyShares },
      side,
    ),
  };
}

/**
 * Worst-case loss for the seeder of a binary LS-LMSR pool: b × ln(2).
 * Useful for capacity planning and the README pitch ("$100 seed bounds
 * protocol loss at $100/market").
 */
export function maxLoss(state: BootstrapPoolState): bigint {
  const b = toFloat(state.bParam);
  return fromFloat(b * Math.LN2);
}
