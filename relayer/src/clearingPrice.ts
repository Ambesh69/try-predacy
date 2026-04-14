import { Order, OrderSide, ClearingResult, PRICE_DECIMALS } from "./types";

/**
 * Compute the uniform clearing price for a 4-sided batch auction.
 *
 * Algorithm:
 * 1. Generate candidate prices from all YES limit prices + complements of NO prices
 * 2. For each price P, compute total buy/sell volumes
 * 3. Choose P that maximizes filled volume (tie-break: highest price)
 *
 * YES_BUY fills if limitPrice >= P
 * YES_SELL fills if limitPrice <= P
 * NO_BUY fills if limitPrice >= (1M - P)
 * NO_SELL fills if limitPrice <= (1M - P)
 */
export function computeClearingPrice(orders: Order[]): ClearingResult {
  if (orders.length === 0) {
    return {
      clearingPrice: 0n,
      filledYesBuyVol: 0n,
      filledNoBuyVol: 0n,
      filledYesSellQty: 0n,
      filledNoSellQty: 0n,
      filledOrders: [],
      unfilledOrders: [],
    };
  }

  // Collect candidate prices
  const candidatePrices = new Set<bigint>();

  for (const order of orders) {
    if (order.amount === 0n) continue;
    if (order.side === OrderSide.YES_BUY || order.side === OrderSide.YES_SELL) {
      candidatePrices.add(order.limitPrice);
    } else {
      // NO side: complement price
      candidatePrices.add(PRICE_DECIMALS - order.limitPrice);
    }
  }

  // Also add boundary prices
  candidatePrices.add(1n);
  candidatePrices.add(PRICE_DECIMALS - 1n);

  let bestPrice = 0n;
  let bestVolume = 0n;
  let bestResult: ClearingResult | null = null;

  for (const price of candidatePrices) {
    if (price <= 0n || price >= PRICE_DECIMALS) continue;
    const noPrice = PRICE_DECIMALS - price;

    let filledYesBuyVol = 0n;
    let filledNoBuyVol = 0n;
    let filledYesSellQty = 0n;
    let filledNoSellQty = 0n;

    const filledOrders: Order[] = [];
    const unfilledOrders: Order[] = [];

    for (const order of orders) {
      if (order.amount === 0n) continue;
      let fills = false;

      switch (order.side) {
        case OrderSide.YES_BUY:
          fills = order.limitPrice >= price;
          if (fills) filledYesBuyVol += order.amount;
          break;
        case OrderSide.YES_SELL:
          fills = order.limitPrice <= price;
          if (fills) filledYesSellQty += order.amount;
          break;
        case OrderSide.NO_BUY:
          fills = order.limitPrice >= noPrice;
          if (fills) filledNoBuyVol += order.amount;
          break;
        case OrderSide.NO_SELL:
          fills = order.limitPrice <= noPrice;
          if (fills) filledNoSellQty += order.amount;
          break;
      }

      if (fills) {
        filledOrders.push(order);
      } else {
        unfilledOrders.push(order);
      }
    }

    // Total volume (USDC equivalent)
    // Protocol is always the counterparty: mints tokens for buyers,
    // burns tokens and returns USDC for sellers. All orders fill.
    const totalBuyUsdc = filledYesBuyVol + filledNoBuyVol;
    const totalSellUsdc =
      (filledYesSellQty * price) / PRICE_DECIMALS +
      (filledNoSellQty * noPrice) / PRICE_DECIMALS;
    const totalVolume = totalBuyUsdc + totalSellUsdc;

    // Maximize total filled volume, tie-break on highest price
    if (totalVolume > bestVolume || (totalVolume === bestVolume && price > bestPrice)) {
      bestVolume = totalVolume;
      bestPrice = price;
      bestResult = {
        clearingPrice: price,
        filledYesBuyVol,
        filledNoBuyVol,
        filledYesSellQty,
        filledNoSellQty,
        filledOrders,
        unfilledOrders,
      };
    }
  }

  return bestResult || {
    clearingPrice: 0n,
    filledYesBuyVol: 0n,
    filledNoBuyVol: 0n,
    filledYesSellQty: 0n,
    filledNoSellQty: 0n,
    filledOrders: [],
    unfilledOrders: [],
  };
}
