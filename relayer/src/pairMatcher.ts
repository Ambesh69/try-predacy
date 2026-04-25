import { PRICE_DECIMALS } from "./types";

/**
 * Pair-matching math for Predacy's two-path execution model.
 *
 * After the uniform clearing price P is computed, every filled order falls
 * into exactly one of two execution paths:
 *
 *   Path A — Complete-set mint (complementary YES_BUY + NO_BUY pair):
 *     Alice pays P for 1 YES, Bob pays (1-P) for 1 NO, total = $1 → mint 1
 *     complete set on Polymarket CTF. No inventory risk — 1 YES + 1 NO is
 *     always worth exactly $1 until resolution.
 *
 *   Path B — CLOB routing (the remainder):
 *     Any buy/sell volume left over after the complementary match runs out
 *     on one side (or both). Routed as individual Polymarket CLOB limit
 *     orders at each user's original limit price, against the external book.
 *
 * We also absorb SELL-side supply into the matching. A YES_SELL at P fills
 * the same demand a CLOB-sourced YES fills would — it's a direct internal
 * trade, no Polymarket round-trip needed. Equivalent for NO_SELL.
 *
 * The computation here doesn't change `lock_funds` behavior on devnet
 * (protocol still over-mints as universal counterparty — see ARCHITECTURE §5
 * for why that's safe as a devnet expedient). It classifies each token
 * quantity so we can log the split, surface it on the settlement API, and
 * wire the routing intent (via the mock Polymarket router) that would fire
 * on mainnet once Ika atomic swaps + LP Polygon USDC are live.
 */
export interface PairMatchingResult {
  /**
   * Number of complete sets (1 YES + 1 NO) minted via Path A.
   * In 6-decimal token units (matches YES_MINT / NO_MINT decimals).
   */
  matchedPairQty: bigint;

  /**
   * USDC consumed by the matched-pair complete-set mints (= matchedPairQty,
   * since each complete set costs exactly $1). 6-decimal USDC.
   */
  matchedPairUsdc: bigint;

  /**
   * Net YES-token demand left over after: (a) YES_SELL supply absorbed YES
   * demand internally, and (b) matched NO-BUY pairs consumed what was left.
   * This is the YES quantity the relayer would buy on the Polymarket CLOB.
   * In 6-decimal token units.
   */
  residualYesBuyQty: bigint;

  /** Same as above for NO (only one of YES/NO residualBuy is non-zero by construction). */
  residualNoBuyQty: bigint;

  /**
   * Net YES-token supply that couldn't be absorbed by YES_BUY demand. The
   * relayer would sell this on the Polymarket CLOB. 6-decimal tokens.
   */
  residualYesSellQty: bigint;
  residualNoSellQty: bigint;

  /**
   * Convenience: total fraction of "volume" going via Path A vs Path B.
   * Percentage in basis points (10000 = 100%). Shown on settlement UI.
   */
  matchedPercentBps: number;
}

/**
 * Given a cleared batch's totals, compute the matched-pair / residual split.
 *
 * @param clearingPrice  6-decimal fixed-point P (0 < P < PRICE_DECIMALS)
 * @param filledYesBuyVol   USDC volume of YES_BUY orders that fill
 * @param filledNoBuyVol    USDC volume of NO_BUY orders that fill
 * @param filledYesSellQty  YES tokens deposited by filling YES_SELL orders
 * @param filledNoSellQty   NO tokens deposited by filling NO_SELL orders
 */
export function computePairMatching(
  clearingPrice: bigint,
  filledYesBuyVol: bigint,
  filledNoBuyVol: bigint,
  filledYesSellQty: bigint,
  filledNoSellQty: bigint,
): PairMatchingResult {
  if (clearingPrice <= 0n || clearingPrice >= PRICE_DECIMALS) {
    throw new Error(`Invalid clearingPrice: ${clearingPrice}`);
  }
  const noPrice = PRICE_DECIMALS - clearingPrice;

  // Step 1: Convert buy-side USDC demand into TOKEN QUANTITIES at price P.
  // A buyer paying $filledYesBuyVol at P=0.60 walks away with
  // filledYesBuyVol/0.60 YES tokens.
  const yesBuyTokens = (filledYesBuyVol * PRICE_DECIMALS) / clearingPrice;
  const noBuyTokens = (filledNoBuyVol * PRICE_DECIMALS) / noPrice;

  // Step 2: Absorb SELL-side supply first. Internal trade: YES_SELL tokens
  // directly satisfy YES_BUY demand at price P (seller gets $P * qty USDC
  // from buyer deposits, buyer gets the token the seller deposited).
  // Whichever is larger becomes the post-sell net.
  const yesNetBuyDemand = yesBuyTokens > filledYesSellQty ? yesBuyTokens - filledYesSellQty : 0n;
  const yesNetSellSupply = filledYesSellQty > yesBuyTokens ? filledYesSellQty - yesBuyTokens : 0n;
  const noNetBuyDemand = noBuyTokens > filledNoSellQty ? noBuyTokens - filledNoSellQty : 0n;
  const noNetSellSupply = filledNoSellQty > noBuyTokens ? filledNoSellQty - noBuyTokens : 0n;

  // Step 3: Match complementary pairs. Every complete set mint needs
  // one unit of YES buy-demand AND one unit of NO buy-demand. Take the
  // smaller of the two remaining net demands.
  const matchedPairQty = yesNetBuyDemand < noNetBuyDemand ? yesNetBuyDemand : noNetBuyDemand;
  const matchedPairUsdc = matchedPairQty; // 1 complete set = $1 USDC

  // Step 4: Whatever buy-demand remains after complete-set matching goes to
  // CLOB. By construction exactly one of these is non-zero (or both zero).
  const residualYesBuyQty = yesNetBuyDemand - matchedPairQty;
  const residualNoBuyQty = noNetBuyDemand - matchedPairQty;

  // Sell-side residuals: supply that couldn't be absorbed internally.
  const residualYesSellQty = yesNetSellSupply;
  const residualNoSellQty = noNetSellSupply;

  // Step 5: Compute matched-vs-total ratio for reporting.
  // "Matched" = USDC volume that stayed internal (never hit the CLOB).
  // We derive it by subtracting the USDC-equivalent of residuals from total:
  //   matchedPct = 1 - (residual USDC / total USDC volume)
  // This naturally covers both complete-set matches (Path A) AND internal
  // YES_BUY↔YES_SELL / NO_BUY↔NO_SELL absorptions — all of them avoid CLOB.
  const totalUsdcVolume =
    filledYesBuyVol +
    filledNoBuyVol +
    (filledYesSellQty * clearingPrice) / PRICE_DECIMALS +
    (filledNoSellQty * noPrice) / PRICE_DECIMALS;
  const residualUsdcVolume =
    (residualYesBuyQty * clearingPrice) / PRICE_DECIMALS +
    (residualNoBuyQty * noPrice) / PRICE_DECIMALS +
    (residualYesSellQty * clearingPrice) / PRICE_DECIMALS +
    (residualNoSellQty * noPrice) / PRICE_DECIMALS;
  const matchedPercentBps =
    totalUsdcVolume === 0n
      ? 0
      : Number(((totalUsdcVolume - residualUsdcVolume) * 10_000n) / totalUsdcVolume);

  return {
    matchedPairQty,
    matchedPairUsdc,
    residualYesBuyQty,
    residualNoBuyQty,
    residualYesSellQty,
    residualNoSellQty,
    matchedPercentBps,
  };
}

/** Short human-readable summary for logs. */
export function formatPairMatching(r: PairMatchingResult): string {
  const pct = (r.matchedPercentBps / 100).toFixed(1);
  return (
    `matched=${Number(r.matchedPairQty) / 1e6} pairs ($${Number(r.matchedPairUsdc) / 1e6}, ${pct}% of vol) | ` +
    `residuals: YES_BUY=${Number(r.residualYesBuyQty) / 1e6} NO_BUY=${Number(r.residualNoBuyQty) / 1e6} ` +
    `YES_SELL=${Number(r.residualYesSellQty) / 1e6} NO_SELL=${Number(r.residualNoSellQty) / 1e6}`
  );
}
