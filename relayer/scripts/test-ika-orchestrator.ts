/**
 * Sanity tests for ikaOrchestrator planning.
 * Run: `cd relayer && npx ts-node scripts/test-ika-orchestrator.ts`
 */

import { computePairMatching } from "../src/pairMatcher";
import { routeResiduals } from "../src/polymarketRouter";
import { planBundle, serializeBundle, getBundleStore } from "../src/ikaOrchestrator";
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
function assertTrue(label: string, cond: boolean) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

console.log("\n╔═══ ikaOrchestrator.planBundle tests ═══╗\n");

(async () => {
  // Case A: balanced buy pair — every leg should be present.
  {
    console.log("Case A: balanced pair ($60 YES_BUY + $40 NO_BUY @ P=0.60)");
    const P = 600_000n;
    const orders: Order[] = [
      { side: OrderSide.YES_BUY, amount: 60_000_000n, limitPrice: 700_000n, salt: 1n },
      { side: OrderSide.NO_BUY,  amount: 40_000_000n, limitPrice: 500_000n, salt: 2n },
    ];
    const matching = computePairMatching(P, 60_000_000n, 40_000_000n, 0n, 0n);
    const routing = await routeResiduals(orders, P, matching);
    const bundle = planBundle({
      batchId: "1",
      marketId: "market-a",
      clearingPrice: P,
      pairMatching: matching,
      clobRouting: routing,
      lpQuote: routing.lpQuote,
    });
    // No residuals → no LP, but unlock/polymarket/distribute should exist
    assertEq("status = planned", bundle.status, "planned");
    assertEq("batchId", bundle.batchId, "1");
    // No LP fund leg since no residuals
    const kinds = bundle.legs.map((l) => l.kind);
    assertTrue("has unlock-solana", kinds.includes("unlock-solana"));
    assertTrue("has polymarket-exec", kinds.includes("polymarket-exec"));
    assertTrue("has distribute", kinds.includes("distribute"));
    assertTrue("NO lp-fund (balanced, no residuals)", !kinds.includes("lp-fund-polygon"));
    assertEq("all digests are 32 bytes", bundle.legs.every((l) => l.messageDigest.length === 32), true);

    // Unlock leg carries matched USDC = $100
    const unlock = bundle.legs.find((l) => l.kind === "unlock-solana");
    assertEq("unlock usdc = $100", unlock?.usdcValue, 100_000_000n);
  }

  // Case B: buy-side overshoot → LP fund leg appears, paired to best LP.
  {
    console.log("\nCase B: YES_BUY overshoot ($120 + $40) → CLOB residual + LP");
    const P = 600_000n;
    const orders: Order[] = [
      { side: OrderSide.YES_BUY, amount: 120_000_000n, limitPrice: 700_000n, salt: 1n },
      { side: OrderSide.NO_BUY,  amount: 40_000_000n, limitPrice: 500_000n, salt: 2n },
    ];
    const matching = computePairMatching(P, 120_000_000n, 40_000_000n, 0n, 0n);
    const routing = await routeResiduals(orders, P, matching);
    const bundle = planBundle({
      batchId: "2",
      marketId: "market-a",
      clearingPrice: P,
      pairMatching: matching,
      clobRouting: routing,
      lpQuote: routing.lpQuote,
    });
    const kinds = bundle.legs.map((l) => l.kind);
    assertTrue("has lp-fund-polygon", kinds.includes("lp-fund-polygon"));
    // Unlock value = matched + buy residual = $100 + $60 = $160
    const unlock = bundle.legs.find((l) => l.kind === "unlock-solana");
    assertEq("unlock usdc = $160 (matched $100 + residual $60)", unlock?.usdcValue, 160_000_000n);
    // LP was assigned
    assertTrue("bundle.lpId assigned", bundle.lpId !== null);
  }

  // Case C: digests are deterministic & unique per batchId.
  {
    console.log("\nCase C: digests deterministic & per-batch unique");
    const matching = computePairMatching(500_000n, 50_000_000n, 50_000_000n, 0n, 0n);
    const routing = await routeResiduals([], 500_000n, matching);
    const b1 = planBundle({ batchId: "99", marketId: "m", clearingPrice: 500_000n, pairMatching: matching, clobRouting: routing, lpQuote: null });
    const b2 = planBundle({ batchId: "99", marketId: "m", clearingPrice: 500_000n, pairMatching: matching, clobRouting: routing, lpQuote: null });
    const b3 = planBundle({ batchId: "100", marketId: "m", clearingPrice: 500_000n, pairMatching: matching, clobRouting: routing, lpQuote: null });
    const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
    // Same batchId → same digests
    assertEq("digest deterministic for same batch", b1.legs.map(l => hex(l.messageDigest)), b2.legs.map(l => hex(l.messageDigest)));
    // Different batchId → different digests (at least for unlock leg — since batchId is in the preimage)
    const b1Unlock = b1.legs.find((l) => l.kind === "unlock-solana");
    const b3Unlock = b3.legs.find((l) => l.kind === "unlock-solana");
    assertTrue(
      "different batchIds produce different digests",
      !!b1Unlock && !!b3Unlock && hex(b1Unlock.messageDigest) !== hex(b3Unlock.messageDigest),
    );
  }

  // Case D: serialize for JSON transport — bigints become strings, digests hex.
  {
    console.log("\nCase D: serializeBundle produces JSON-safe output");
    const matching = computePairMatching(500_000n, 10_000_000n, 10_000_000n, 0n, 0n);
    const routing = await routeResiduals([], 500_000n, matching);
    const bundle = planBundle({ batchId: "5", marketId: "m", clearingPrice: 500_000n, pairMatching: matching, clobRouting: routing, lpQuote: null });
    const json = serializeBundle(bundle);
    const jsonStr = JSON.stringify(json);
    assertTrue("JSON.stringify round-trips", jsonStr.length > 0);
    assertTrue("digests are hex strings", /^[0-9a-f]{64}$/.test((json as any).legs[0].messageDigest));
  }

  // Case E2: executeBundle with stubbed signer — all legs become "signed"
  {
    console.log("\nCase E2: executeBundle all-legs-signed happy path");
    const { executeBundle } = await import("../src/ikaOrchestrator");
    const matching = computePairMatching(600_000n, 120_000_000n, 40_000_000n, 0n, 0n);
    const routing = await routeResiduals([
      { side: OrderSide.YES_BUY, amount: 120_000_000n, limitPrice: 700_000n, salt: 1n },
      { side: OrderSide.NO_BUY, amount: 40_000_000n, limitPrice: 500_000n, salt: 2n },
    ], 600_000n, matching);
    const bundle = planBundle({
      batchId: "exec-1",
      marketId: "m",
      clearingPrice: 600_000n,
      pairMatching: matching,
      clobRouting: routing,
      lpQuote: routing.lpQuote,
    });
    let calls = 0;
    const stubSigner = async (_uw: string, _d: Uint8Array) => {
      calls++;
      return { signature: "0x" + "11".repeat(64), approveTxSignature: "stub" };
    };
    const executed = await executeBundle(bundle, stubSigner, "user1");
    assertEq("status=executed", executed.status, "executed");
    assertTrue("executedAt set", typeof executed.executedAt === "number");
    // Only non-polymarket legs get signed (unlock, lp-fund, distribute = 3)
    // polymarket-exec leg should still have status=signed but via the
    // shortcut branch (no call to stubSigner)
    assertEq("stub signer called for non-polymarket legs only", calls, 3);
    assertTrue("every leg ended signed", executed.legs.every(l => l.status === "signed"));
  }

  // Case E3: executeBundle marks bundle reverted if any leg throws
  {
    console.log("\nCase E3: executeBundle reverts on leg failure");
    const { executeBundle } = await import("../src/ikaOrchestrator");
    const matching = computePairMatching(500_000n, 10_000_000n, 10_000_000n, 0n, 0n);
    const routing = await routeResiduals([], 500_000n, matching);
    const bundle = planBundle({ batchId: "exec-2", marketId: "m", clearingPrice: 500_000n, pairMatching: matching, clobRouting: routing, lpQuote: null });
    const badSigner = async () => { throw new Error("Ika unavailable"); };
    const executed = await executeBundle(bundle, badSigner, "user1");
    assertEq("status=reverted", executed.status, "reverted");
    assertTrue("revertedReason set", typeof executed.revertedReason === "string");
    assertTrue("at least one leg failed", executed.legs.some(l => l.status === "failed"));
  }

  // Case E: BundleStore save/get/list
  {
    console.log("\nCase E: BundleStore save/get/list");
    const store = getBundleStore();
    const matching = computePairMatching(500_000n, 5_000_000n, 5_000_000n, 0n, 0n);
    const routing = await routeResiduals([], 500_000n, matching);
    const bundle = planBundle({ batchId: "test-e", marketId: "m", clearingPrice: 500_000n, pairMatching: matching, clobRouting: routing, lpQuote: null });
    store.save(bundle);
    assertTrue("get returns saved", store.get("test-e")?.batchId === "test-e");
    assertTrue("list contains it", store.list().some(b => b.batchId === "test-e"));
  }

  console.log(`\n═════════════════════════════════════`);
  console.log(` ${passed} passed, ${failed} failed`);
  console.log(`═════════════════════════════════════\n`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
