/**
 * Sanity tests for pairMatcher + polymarketRouter.
 * Run: `cd relayer && npx ts-node scripts/test-pair-matcher.ts`
 */

import { computePairMatching, formatPairMatching } from "../src/pairMatcher";
import { routeResiduals } from "../src/polymarketRouter";
import { Order, OrderSide, PRICE_DECIMALS } from "../src/types";

let passed = 0;
let failed = 0;

function assertEq(label: string, got: unknown, want: unknown) {
  // BigInt-safe compare: stringify via a replacer that handles bigint.
  const s = (v: unknown) =>
    typeof v === "bigint"
      ? v.toString() + "n"
      : JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() + "n" : val));
  const ok = s(got) === s(want);
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`     got:  ${s(got)}`);
    console.log(`     want: ${s(want)}`);
    failed++;
  }
}

console.log("\n╔═══ pairMatcher unit tests ═══╗\n");

// Case 1: Perfectly balanced YES_BUY + NO_BUY at P=0.60
// YES_BUY: $60 → wants 100 YES (at $0.60)
// NO_BUY:  $40 → wants 100 NO  (at $0.40)
// matched = min(100, 100) = 100 complete sets → $100 USDC consumed
// residuals: all 0
{
  console.log("Case 1: Balanced complementary buy pair");
  const r = computePairMatching(
    600_000n, // P = 0.60
    60_000_000n, // $60 YES_BUY
    40_000_000n, // $40 NO_BUY
    0n,
    0n,
  );
  console.log("  " + formatPairMatching(r));
  assertEq("matchedPairQty", r.matchedPairQty, 100_000_000n);
  assertEq("residualYesBuy", r.residualYesBuyQty, 0n);
  assertEq("residualNoBuy", r.residualNoBuyQty, 0n);
  assertEq("matchedPct 100%", r.matchedPercentBps, 10000); // 100% of volume stayed internal
}

// Case 2: Imbalanced — more YES_BUY than NO_BUY
// YES_BUY: $120 at P=0.60 → wants 200 YES
// NO_BUY:  $40  at P=0.40 → wants 100 NO
// matched = min(200, 100) = 100 pairs → $100 USDC in complete sets
// residualYesBuy = 200 - 100 = 100 YES to route to CLOB
{
  console.log("\nCase 2: YES_BUY overshoot → YES residual to CLOB");
  const r = computePairMatching(
    600_000n,
    120_000_000n, // $120 YES_BUY
    40_000_000n,  // $40 NO_BUY
    0n, 0n,
  );
  console.log("  " + formatPairMatching(r));
  assertEq("matchedPairQty", r.matchedPairQty, 100_000_000n);
  assertEq("residualYesBuy", r.residualYesBuyQty, 100_000_000n);
  assertEq("residualNoBuy", r.residualNoBuyQty, 0n);
}

// Case 3: YES_SELL absorbs YES_BUY internally (no CLOB needed on YES side)
// YES_BUY: $60 at P=0.60 → wants 100 YES
// YES_SELL: 100 YES tokens supplied
// → internal trade eats all YES buy-demand
// NO_BUY:  $40 → wants 100 NO
// → all NO goes to CLOB since no NO supply
{
  console.log("\nCase 3: YES_SELL absorbs YES_BUY internally");
  const r = computePairMatching(
    600_000n,
    60_000_000n,    // $60 YES_BUY
    40_000_000n,    // $40 NO_BUY
    100_000_000n,   // 100 YES_SELL
    0n,
  );
  console.log("  " + formatPairMatching(r));
  assertEq("matchedPairQty (nothing left to pair)", r.matchedPairQty, 0n);
  assertEq("residualYesBuy", r.residualYesBuyQty, 0n);
  assertEq("residualNoBuy", r.residualNoBuyQty, 100_000_000n);
}

// Case 4: Pure SELL-only batch — all CLOB
{
  console.log("\nCase 4: Pure SELL side (no buyers)");
  const r = computePairMatching(
    500_000n,
    0n, 0n,
    50_000_000n, // 50 YES_SELL
    30_000_000n, // 30 NO_SELL
  );
  console.log("  " + formatPairMatching(r));
  assertEq("matchedPairQty", r.matchedPairQty, 0n);
  assertEq("residualYesSell", r.residualYesSellQty, 50_000_000n);
  assertEq("residualNoSell", r.residualNoSellQty, 30_000_000n);
}

// Case 5: polymarketRouter.routeResiduals — confirm receipts are produced
console.log("\n╔═══ polymarketRouter smoke test ═══╗\n");
(async () => {
  const orders: Order[] = [
    { side: OrderSide.YES_BUY, amount: 120_000_000n, limitPrice: 700_000n, salt: 1n },
    { side: OrderSide.NO_BUY, amount: 40_000_000n, limitPrice: 400_000n, salt: 2n },
  ];
  const matching = computePairMatching(600_000n, 120_000_000n, 40_000_000n, 0n, 0n);
  const summary = await routeResiduals(orders, 600_000n, matching);
  console.log(`  receipts: ${summary.receipts.length}`);
  console.log(`  totalUsdcToLp: $${Number(summary.totalUsdcToLp) / 1e6}`);
  assertEq("one receipt (YES_BUY residual)", summary.receipts.length, 1);
  assertEq("receipt side = YES_BUY", summary.receipts[0].side, OrderSide.YES_BUY);
  assertEq("receipt source tag", summary.receipts[0].source, "mock-devnet");

  console.log(`\n═════════════════════════════════════`);
  console.log(` ${passed} passed, ${failed} failed`);
  console.log(`═════════════════════════════════════\n`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
