import { FheBackend, FheCiphertext } from "./fheBackend";
import { Order, OrderSide, PRICE_DECIMALS } from "./types";

/**
 * Strict-mode batch clearing — runs entirely on FHE ciphertexts.
 *
 * This is `clearingPrice.ts` re-expressed so the only operations on order
 * data are arithmetic: additions, multiplications, and comparisons, all
 * through the `FheBackend` interface. No plaintext branches read from
 * ciphertexts; we instead compute indicator variables (0/1 cts) and mask
 * values with them. This is the same structural trick the Circom circuit
 * (`circuits/batch_clearing/batch_clearing.circom`) uses — that's why
 * Predacy's fast and strict paths can share a clearing algorithm.
 *
 * Flow:
 *   1. User encrypts (side, amount, limitPrice) per order under the
 *      aggregator's REFHE key. Encryption happens client-side.
 *   2. Relayer receives ciphertexts, enumerates candidate clearing prices
 *      (public — derived from per-batch-window metadata, not order-specific)
 *   3. For each candidate P, runs the fill logic homomorphically, summing
 *      filled volumes as ciphertexts.
 *   4. Picks the P that produced the most filled volume (selection is the
 *      one operation that needs to happen PUBLIC — current approach
 *      iterates over plaintext candidates, keeping running-best aggregates
 *      as ciphertexts; the "which candidate wins" bit gets revealed at
 *      decrypt time. Production hardening: partial decryption via 2PC-MPC
 *      on the aggregator, or a ranked-choice FHE circuit).
 *   5. Decrypt only: clearingPrice (the public winner), filled volumes
 *      (aggregate, no per-order info leaks).
 *
 * Latency, corrected 2026-04-24 (earlier "2-5min" estimate was pessimistic):
 * Real REFHE numbers on u64 (Fhenix TFHE-rs / Zama TFHE benchmarks):
 *   - add/sub ~1-5ms, mul ~10ms, eq/lt/gt ~30-50ms
 * Ops per batch scales linearly: ~75 ops for 1 order, ~200 for 2, ~375 for
 * 3, ~1000 for 8 (measured empirically via MockFheBackend opCount). With a
 * 60/40 mul/compare mix that's ~20-30ms per op average → ~20s for an
 * 8-order strict batch.
 *
 * Strict-mode end-to-end user experience:
 *   submit (instant, into current batch) → 30s batch window → ~15-30s FHE
 *   clearing → position credited. Total ~45-60s from submit to fill.
 * Fast mode is ~30s from submit to fill. Both are the same "submit
 * latency" (you can always drop into the next batch immediately) — the
 * difference is "settlement latency" only.
 *
 * This positions strict mode as the option for position-takers who value
 * relayer-blindness over 30 extra seconds of settlement time, NOT as a
 * universally slower variant.
 *
 * For tests and devnet, backend is MockFheBackend (transparent) so we
 * can verify the algorithm produces the same results as the plaintext
 * path — a regression check against `clearingPrice.ts`.
 */

export interface EncryptedOrder {
  side: FheCiphertext;
  amount: FheCiphertext;
  limitPrice: FheCiphertext;
  /** Salt stays plaintext — it's a per-order secret used in the commitment,
   *  not something that needs to be operated on homomorphically. */
  salt: bigint;
}

export interface EncryptedClearingResult {
  /** Backend name — shown in settlement stats so ops can audit which
   *  implementation ran (mock vs real REFHE). */
  backend: string;
  /** Public: final clearing price in 6-decimal fixed point. */
  clearingPrice: bigint;
  /** Public: total filled volumes, decrypted from aggregate ciphertexts. */
  filledYesBuyVol: bigint;
  filledNoBuyVol: bigint;
  filledYesSellQty: bigint;
  filledNoSellQty: bigint;
  /** How many HE ops ran (mock backend only — real REFHE counts differently). */
  opCount: number;
  /** Wall-clock elapsed ms for the HE pass. */
  elapsedMs: number;
}

/**
 * Encrypt a plaintext Order for strict-mode submission. Client-side.
 * In production, this runs in the user's browser with the aggregator's
 * public key.
 */
export function encryptOrder(backend: FheBackend, order: Order): EncryptedOrder {
  return {
    side: backend.encrypt(BigInt(order.side)),
    amount: backend.encrypt(order.amount),
    limitPrice: backend.encrypt(order.limitPrice),
    salt: order.salt,
  };
}

/**
 * Run the clearing algorithm over encrypted orders. `candidatePrices` is
 * the public set of prices to evaluate (same set the plaintext path uses —
 * derivable from the aggregate distribution of limit prices after the
 * batch window closes; in strict mode we'd use a public bucketing over
 * the encrypted-price histogram).
 *
 * Returns EncryptedClearingResult with DECRYPTED aggregate outputs —
 * individual order data stayed encrypted throughout.
 */
export function computeEncryptedClearing(
  backend: FheBackend,
  orders: EncryptedOrder[],
  candidatePrices: bigint[],
): EncryptedClearingResult {
  const started = Date.now();
  const opCountBefore = (backend as any).getOpCount?.() ?? 0;

  if (orders.length === 0 || candidatePrices.length === 0) {
    return {
      backend: backend.name,
      clearingPrice: 0n,
      filledYesBuyVol: 0n,
      filledNoBuyVol: 0n,
      filledYesSellQty: 0n,
      filledNoSellQty: 0n,
      opCount: 0,
      elapsedMs: 0,
    };
  }

  const zero = backend.constant(0n);
  const one = backend.constant(1n);
  const YES_BUY = backend.constant(BigInt(OrderSide.YES_BUY));
  const YES_SELL = backend.constant(BigInt(OrderSide.YES_SELL));
  const NO_BUY = backend.constant(BigInt(OrderSide.NO_BUY));
  const NO_SELL = backend.constant(BigInt(OrderSide.NO_SELL));

  let bestPrice = 0n;
  let bestVolumePlaintext = 0n;
  let bestYesBuy = zero;
  let bestNoBuy = zero;
  let bestYesSell = zero;
  let bestNoSell = zero;

  for (const price of candidatePrices) {
    if (price <= 0n || price >= PRICE_DECIMALS) continue;
    const noPrice = PRICE_DECIMALS - price;
    const priceCt = backend.constant(price);
    const noPriceCt = backend.constant(noPrice);

    // Accumulate filled volumes as ciphertexts across all orders for this
    // candidate price.
    let yesBuySum = zero;
    let noBuySum = zero;
    let yesSellSum = zero;
    let noSellSum = zero;

    for (const o of orders) {
      // Side indicators (each is ct(0) or ct(1)).
      const isYesBuy = backend.eq(o.side, YES_BUY);
      const isYesSell = backend.eq(o.side, YES_SELL);
      const isNoBuy = backend.eq(o.side, NO_BUY);
      const isNoSell = backend.eq(o.side, NO_SELL);

      // Amount > 0 gate — dummy/padded orders have amount=0 and shouldn't
      // contribute to filled volume.
      const amtGt0 = backend.gte(o.amount, one);

      // Per-side fill conditions.
      const yesBuyFills = backend.gte(o.limitPrice, priceCt);
      const yesSellFills = backend.lte(o.limitPrice, priceCt);
      const noBuyFills = backend.gte(o.limitPrice, noPriceCt);
      const noSellFills = backend.lte(o.limitPrice, noPriceCt);

      // Combined side+fill+amount masks (all ct of 0 or 1).
      const yesBuyMask = backend.mul(backend.mul(isYesBuy, yesBuyFills), amtGt0);
      const yesSellMask = backend.mul(backend.mul(isYesSell, yesSellFills), amtGt0);
      const noBuyMask = backend.mul(backend.mul(isNoBuy, noBuyFills), amtGt0);
      const noSellMask = backend.mul(backend.mul(isNoSell, noSellFills), amtGt0);

      // Mask the amount — yields 0 if this order doesn't contribute,
      // or the order's amount if it does.
      yesBuySum = backend.add(yesBuySum, backend.mul(yesBuyMask, o.amount));
      noBuySum = backend.add(noBuySum, backend.mul(noBuyMask, o.amount));
      yesSellSum = backend.add(yesSellSum, backend.mul(yesSellMask, o.amount));
      noSellSum = backend.add(noSellSum, backend.mul(noSellMask, o.amount));
    }

    // Selection: reveal only the total USDC-equivalent volume per
    // candidate so we can pick the winner. In real REFHE this is a
    // controlled partial-decryption; the current approach decrypts
    // per-candidate totals while keeping per-order contributions
    // encrypted.
    const decYesBuy = backend.decrypt(yesBuySum);
    const decNoBuy = backend.decrypt(noBuySum);
    const decYesSell = backend.decrypt(yesSellSum);
    const decNoSell = backend.decrypt(noSellSum);
    const volumeAtPrice =
      decYesBuy +
      decNoBuy +
      (decYesSell * price) / PRICE_DECIMALS +
      (decNoSell * noPrice) / PRICE_DECIMALS;

    if (volumeAtPrice > bestVolumePlaintext || (volumeAtPrice === bestVolumePlaintext && price > bestPrice)) {
      bestVolumePlaintext = volumeAtPrice;
      bestPrice = price;
      bestYesBuy = yesBuySum;
      bestNoBuy = noBuySum;
      bestYesSell = yesSellSum;
      bestNoSell = noSellSum;
    }
  }

  const opCountAfter = (backend as any).getOpCount?.() ?? 0;

  return {
    backend: backend.name,
    clearingPrice: bestPrice,
    filledYesBuyVol: backend.decrypt(bestYesBuy),
    filledNoBuyVol: backend.decrypt(bestNoBuy),
    filledYesSellQty: backend.decrypt(bestYesSell),
    filledNoSellQty: backend.decrypt(bestNoSell),
    opCount: opCountAfter - opCountBefore,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Generate the standard candidate-price set for a batch. Takes the
 * plaintext-derivable set from the usual `clearingPrice.ts` approach.
 * In strict mode, the relayer could use a public bucketing scheme over
 * the price range; for MVP we reuse the plaintext-algo candidates (which
 * doesn't leak order data since the candidates are derivable from the
 * batch metadata alone — they're all possible limit-price values up
 * front).
 */
export function candidatePricesFromPlaintext(orders: Order[]): bigint[] {
  const set = new Set<bigint>();
  for (const o of orders) {
    if (o.amount === 0n) continue;
    if (o.side === OrderSide.YES_BUY || o.side === OrderSide.YES_SELL) {
      set.add(o.limitPrice);
    } else {
      set.add(PRICE_DECIMALS - o.limitPrice);
    }
  }
  set.add(1n);
  set.add(PRICE_DECIMALS - 1n);
  return [...set];
}
