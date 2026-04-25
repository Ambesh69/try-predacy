/**
 * Sanity tests for lpRegistry + LP selection inside polymarketRouter.
 * Run: `cd relayer && npx ts-node scripts/test-lp-registry.ts`
 */

import { LPRegistry, getLPRegistry } from "../src/lpRegistry";
import { computePairMatching } from "../src/pairMatcher";
import { routeResiduals } from "../src/polymarketRouter";
import { Order, OrderSide } from "../src/types";

let passed = 0;
let failed = 0;

function assertEq(label: string, got: unknown, want: unknown) {
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

console.log("\n╔═══ LPRegistry unit tests ═══╗\n");

// Case A: cheapest LP wins.
{
  console.log("Case A: select lowest fee");
  const r = new LPRegistry();
  r.register({ id: "cheap", displayName: "Cheap LP", solanaReceiveAddress: "s1", polygonPayoutAddress: "p1", availableUsdc: 1_000_000_000n, feeBps: 5 });
  r.register({ id: "mid", displayName: "Mid LP", solanaReceiveAddress: "s2", polygonPayoutAddress: "p2", availableUsdc: 5_000_000_000n, feeBps: 20 });
  r.register({ id: "big-expensive", displayName: "Big LP", solanaReceiveAddress: "s3", polygonPayoutAddress: "p3", availableUsdc: 100_000_000_000n, feeBps: 50 });
  const q = r.reserveCapital(10_000_000n);
  assertEq("picked cheapest", q?.lpId, "cheap");
  assertEq("fee = 10m * 5 / 10000 = 5000", q?.feeUsdc, 5_000n);
}

// Case B: if cheapest can't cover, fall back to next cheapest.
{
  console.log("\nCase B: cheapest too small → next-cheapest wins");
  const r = new LPRegistry();
  r.register({ id: "tiny", displayName: "Tiny", solanaReceiveAddress: "s1", polygonPayoutAddress: "p1", availableUsdc: 1_000_000n, feeBps: 5 });   // $1, super cheap
  r.register({ id: "mid", displayName: "Mid", solanaReceiveAddress: "s2", polygonPayoutAddress: "p2", availableUsdc: 1_000_000_000n, feeBps: 20 }); // $1k, ok
  const q = r.reserveCapital(100_000_000n); // need $100
  assertEq("fallback to 'mid'", q?.lpId, "mid");
}

// Case C: nobody has capacity → null.
{
  console.log("\nCase C: no LP has capacity");
  const r = new LPRegistry();
  r.register({ id: "a", displayName: "A", solanaReceiveAddress: "s1", polygonPayoutAddress: "p1", availableUsdc: 1_000n, feeBps: 5 });
  const q = r.reserveCapital(1_000_000n);
  assertEq("null quote", q, null);
}

// Case D: fee-tie → deeper pool wins.
{
  console.log("\nCase D: fee tie → deeper pool");
  const r = new LPRegistry();
  r.register({ id: "shallow", displayName: "Shallow", solanaReceiveAddress: "s1", polygonPayoutAddress: "p1", availableUsdc: 10_000_000n, feeBps: 15 });
  r.register({ id: "deep", displayName: "Deep", solanaReceiveAddress: "s2", polygonPayoutAddress: "p2", availableUsdc: 100_000_000n, feeBps: 15 });
  const q = r.reserveCapital(5_000_000n);
  assertEq("prefer deep", q?.lpId, "deep");
}

// Case E: capital correctly deducted + released.
{
  console.log("\nCase E: reserve/release capital accounting");
  const r = new LPRegistry();
  r.register({ id: "x", displayName: "X", solanaReceiveAddress: "s1", polygonPayoutAddress: "p1", availableUsdc: 100_000_000n, feeBps: 10 });
  const q = r.reserveCapital(30_000_000n);
  assertEq("after reserve, available = 70m", r.get("x")?.availableUsdc, 70_000_000n);
  r.releaseCapital("x", 30_000_000n);
  assertEq("after release, available back to 100m", r.get("x")?.availableUsdc, 100_000_000n);
  // recordSettled should NOT re-add to availableUsdc, only bump earned fees.
  const q2 = r.reserveCapital(10_000_000n);
  r.recordSettled("x", q2!);
  assertEq("settled: available = 90m", r.get("x")?.availableUsdc, 90_000_000n);
  assertEq("settled: earned fees = 10k", r.get("x")?.earnedFeesUsdc, 10_000n);
  assertEq("settled: volume = 10m", r.get("x")?.totalVolumeUsdc, 10_000_000n);
}

// Case F: inactive LP is skipped.
{
  console.log("\nCase F: inactive LP skipped");
  const r = new LPRegistry();
  r.register({ id: "off", displayName: "Off", solanaReceiveAddress: "s1", polygonPayoutAddress: "p1", availableUsdc: 1_000_000_000n, feeBps: 1 });
  r.register({ id: "on", displayName: "On", solanaReceiveAddress: "s2", polygonPayoutAddress: "p2", availableUsdc: 1_000_000_000n, feeBps: 10 });
  r.setActive("off", false);
  const q = r.reserveCapital(10_000_000n);
  assertEq("picked the active one", q?.lpId, "on");
}

// Case G: integration — polymarketRouter picks LP for buy-side residuals.
console.log("\n╔═══ polymarketRouter + LP integration ═══╗\n");
(async () => {
  // Using the singleton so default seeded LPs are available.
  const registry = getLPRegistry();
  const seeded = registry.list();
  console.log(`  Seeded LPs: ${seeded.map((lp) => `${lp.id}(${lp.feeBps}bps)`).join(", ")}`);

  // Residual scenario: YES_BUY overshoot with $60 residual
  const orders: Order[] = [
    { side: OrderSide.YES_BUY, amount: 120_000_000n, limitPrice: 700_000n, salt: 1n },
    { side: OrderSide.NO_BUY, amount: 40_000_000n, limitPrice: 400_000n, salt: 2n },
  ];
  const matching = computePairMatching(600_000n, 120_000_000n, 40_000_000n, 0n, 0n);
  const summary = await routeResiduals(orders, 600_000n, matching);

  assertEq("lpQuote present", summary.lpQuote !== null, true);
  assertEq("lpUnavailable false", summary.lpUnavailable, false);
  // $60 residual buy-side USDC
  assertEq("LP covers $60", summary.lpQuote?.usdcAmount, 60_000_000n);
  // Cheapest seeded LP was lp-boutique at 10bps → fee = 60m * 10 / 10000 = 60k
  assertEq("fee = 60 * 0.001 = $0.06", summary.lpQuote?.feeUsdc, 60_000n);
  assertEq("picked boutique (cheapest)", summary.lpQuote?.lpId, "lp-boutique");

  console.log(`\n═════════════════════════════════════`);
  console.log(` ${passed} passed, ${failed} failed`);
  console.log(`═════════════════════════════════════\n`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
