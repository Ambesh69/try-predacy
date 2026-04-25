/**
 * Sanity tests for fheBackend + encryptedClearing.
 * Run: `cd relayer && npx ts-node scripts/test-encrypted-clearing.ts`
 *
 * The key correctness check: strict-mode FHE clearing MUST produce the
 * same clearingPrice + filled volumes as plaintext `computeClearingPrice`
 * for the same inputs. If they diverge, we've introduced an algorithm
 * bug in encryptedClearing.ts (which needs to match the plaintext semantics
 * exactly, because Groth16 proofs are generated off the plaintext result
 * on the other side).
 */

import { MockFheBackend, selectFheBackend } from "../src/fheBackend";
import {
  encryptOrder,
  computeEncryptedClearing,
  candidatePricesFromPlaintext,
} from "../src/encryptedClearing";
import { computeClearingPrice } from "../src/clearingPrice";
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

console.log("\n╔═══ MockFheBackend ops tests ═══╗\n");

// Case A: encrypt/decrypt round-trip.
{
  console.log("Case A: encrypt/decrypt round-trip");
  const b = new MockFheBackend();
  const ct = b.encrypt(42n);
  assertEq("decrypt(encrypt(42)) = 42", b.decrypt(ct), 42n);
  // Ciphertext is 16 bytes + magic header
  assertEq("ct size = 16", ct.length, 16);
  assertEq("magic byte 0", ct[0], 0xfe);
}

// Case B: arithmetic ops — add/sub/mul.
{
  console.log("\nCase B: add/sub/mul homomorphism");
  const b = new MockFheBackend();
  const a = b.encrypt(30n);
  const c = b.encrypt(12n);
  assertEq("add(30,12) = 42", b.decrypt(b.add(a, c)), 42n);
  assertEq("sub(30,12) = 18", b.decrypt(b.sub(a, c)), 18n);
  assertEq("mul(30,12) = 360", b.decrypt(b.mul(a, c)), 360n);
  // opCount tracks ops
  assertEq("opCount bumped 3x", b.getOpCount(), 3);
}

// Case C: comparison ops return 0/1 ciphertexts.
{
  console.log("\nCase C: eq/lte/gte return 0/1 cts");
  const b = new MockFheBackend();
  assertEq("eq(5,5) = 1", b.decrypt(b.eq(b.encrypt(5n), b.encrypt(5n))), 1n);
  assertEq("eq(5,6) = 0", b.decrypt(b.eq(b.encrypt(5n), b.encrypt(6n))), 0n);
  assertEq("lte(3,5) = 1", b.decrypt(b.lte(b.encrypt(3n), b.encrypt(5n))), 1n);
  assertEq("gte(3,5) = 0", b.decrypt(b.gte(b.encrypt(3n), b.encrypt(5n))), 0n);
}

// Case D: select — homomorphic ternary.
{
  console.log("\nCase D: select(cond, a, b)");
  const b = new MockFheBackend();
  assertEq("select(1, 99, 42) = 99", b.decrypt(b.select(b.encrypt(1n), b.encrypt(99n), b.encrypt(42n))), 99n);
  assertEq("select(0, 99, 42) = 42", b.decrypt(b.select(b.encrypt(0n), b.encrypt(99n), b.encrypt(42n))), 42n);
}

// Case E: selectFheBackend factory
{
  console.log("\nCase E: selectFheBackend factory");
  const b1 = selectFheBackend("mock");
  assertEq("mock backend name", b1.name, "mock-encrypt-devnet");
  const b2 = selectFheBackend(undefined);
  assertEq("default is mock", b2.name, "mock-encrypt-devnet");
  let threw = false;
  try { selectFheBackend("refhe"); } catch { threw = true; }
  assertTrue("throws on unknown backend", threw);
}

// ───────────────────────────────────────────────────────────────────────
// The critical correctness check: encrypted clearing must match plaintext.
// ───────────────────────────────────────────────────────────────────────
console.log("\n╔═══ encryptedClearing ≡ plaintext clearing ═══╗\n");

function compareFheToPlaintext(label: string, orders: Order[]) {
  console.log(`  — ${label}`);
  const plaintext = computeClearingPrice(orders);
  const backend = new MockFheBackend();
  const encOrders = orders.map((o) => encryptOrder(backend, o));
  const candidates = candidatePricesFromPlaintext(orders);
  const strict = computeEncryptedClearing(backend, encOrders, candidates);
  assertEq(
    `${label}: clearingPrice matches`,
    strict.clearingPrice,
    plaintext.clearingPrice,
  );
  assertEq(`${label}: filledYesBuyVol matches`, strict.filledYesBuyVol, plaintext.filledYesBuyVol);
  assertEq(`${label}: filledNoBuyVol matches`, strict.filledNoBuyVol, plaintext.filledNoBuyVol);
  assertEq(`${label}: filledYesSellQty matches`, strict.filledYesSellQty, plaintext.filledYesSellQty);
  assertEq(`${label}: filledNoSellQty matches`, strict.filledNoSellQty, plaintext.filledNoSellQty);
  console.log(`    ops=${strict.opCount} elapsed=${strict.elapsedMs}ms`);
}

// Four representative scenarios from the pair-matcher test suite — FHE
// path should produce identical results.
compareFheToPlaintext("balanced YES_BUY + NO_BUY @ 60c", [
  { side: OrderSide.YES_BUY, amount: 60_000_000n, limitPrice: 700_000n, salt: 1n },
  { side: OrderSide.NO_BUY,  amount: 40_000_000n, limitPrice: 500_000n, salt: 2n },
]);
compareFheToPlaintext("YES_BUY overshoot", [
  { side: OrderSide.YES_BUY, amount: 120_000_000n, limitPrice: 700_000n, salt: 1n },
  { side: OrderSide.NO_BUY,  amount: 40_000_000n, limitPrice: 500_000n, salt: 2n },
]);
compareFheToPlaintext("YES_SELL absorbs YES_BUY", [
  { side: OrderSide.YES_BUY,  amount: 60_000_000n,  limitPrice: 700_000n, salt: 1n },
  { side: OrderSide.NO_BUY,   amount: 40_000_000n,  limitPrice: 500_000n, salt: 2n },
  { side: OrderSide.YES_SELL, amount: 100_000_000n, limitPrice: 400_000n, salt: 3n },
]);
compareFheToPlaintext("pure SELL batch", [
  { side: OrderSide.YES_SELL, amount: 50_000_000n, limitPrice: 400_000n, salt: 1n },
  { side: OrderSide.NO_SELL,  amount: 30_000_000n, limitPrice: 400_000n, salt: 2n },
]);
compareFheToPlaintext("single order", [
  { side: OrderSide.YES_BUY, amount: 10_000_000n, limitPrice: 650_000n, salt: 1n },
]);

console.log(`\n═════════════════════════════════════`);
console.log(` ${passed} passed, ${failed} failed`);
console.log(`═════════════════════════════════════\n`);
if (failed > 0) process.exit(1);
