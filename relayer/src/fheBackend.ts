/**
 * FHE backend interface — the homomorphic operations Predacy's strict-mode
 * batch clearing needs. See ARCHITECTURE.md §5 + §6.3 for the big picture.
 *
 * In fast mode the relayer sees plaintext orders during the 30s batch
 * window. That's a privacy compromise — the relayer itself could, in
 * principle, use batch-window knowledge to front-run (even though it
 * doesn't). Strict mode eliminates that threat: orders arrive
 * REFHE-encrypted, the clearing algorithm runs entirely on ciphertexts,
 * and only the final aggregate (clearing price + filled volumes) is
 * decrypted. Neither the relayer nor any observer learns individual
 * order contents until the batch settles.
 *
 * This module defines the minimal homomorphic operations we need (integer
 * add/sub/mul, equality, comparison, indicator → multiply). Real REFHE
 * exposes a superset of this. The MockFheBackend below wraps plaintext
 * bigints with the same API so the rest of the codebase can run strict
 * mode on devnet without an SDK — swap to the real backend and nothing
 * else changes.
 *
 * When the Encrypt REFHE SDK ships Alpha 1, the swap is a single file
 * change: implement `FheBackend` in `refheBackend.ts` and route
 * `PRIVACY_MODE=strict` through it instead of the placeholder.
 */

export type FheCiphertext = Uint8Array;

/**
 * Operations our encrypted-clearing circuit needs. All inputs stay
 * encrypted; only decrypt() produces plaintext (and only the aggregator's
 * key should be able to call it in production).
 *
 * Complexity notes (relative to plaintext bigint ops). Real REFHE on u64,
 * benchmarking numbers from Fhenix TFHE-rs / Zama TFHE:
 *   - add/sub:   ~1-5ms per op
 *   - mul:       ~10ms per op
 *   - eq/lt/gt:  ~30-50ms per op
 * The encrypted clearing circuit does ~125 ops per order (4 side-eq, 4
 * fill-compare, 8 mul masks + final sum). An 8-order batch hits ~1000 ops.
 * With a 60/40 mul/compare mix that's ~18-20 seconds of HE compute.
 *
 * Strict-mode end-to-end settlement latency is therefore ~30s batch window
 * + ~15-30s FHE clearing ≈ **45-60 seconds**, not minutes. Still slower
 * than fast mode's ~30s but well within acceptable bounds for positions
 * users explicitly chose to trade off against relayer-blindness.
 *
 * Earlier revision of these docs said "2-5 minutes" — that was overly
 * pessimistic and assumed naive TFHE without batching/amortization.
 * Corrected 2026-04-24.
 */
export interface FheBackend {
  /** Name of the backend — shown in logs + settlement stats. */
  readonly name: string;

  /** Encrypt a plaintext u64-range integer under the aggregator's key. */
  encrypt(value: bigint): FheCiphertext;

  /**
   * Decrypt a ciphertext. In production this requires the aggregator key;
   * called ONLY on the final aggregate outputs (clearing price, filled
   * volumes), never on per-order ciphertexts.
   */
  decrypt(ct: FheCiphertext): bigint;

  /** ct_a + ct_b → ct of sum. */
  add(a: FheCiphertext, b: FheCiphertext): FheCiphertext;

  /**
   * ct_a - ct_b → ct of difference. Underflow produces well-defined
   * wrap-around in the plaintext space (u64 semantics); callers must
   * guard against negative results at circuit-design time.
   */
  sub(a: FheCiphertext, b: FheCiphertext): FheCiphertext;

  /** ct_a * ct_b → ct of product. */
  mul(a: FheCiphertext, b: FheCiphertext): FheCiphertext;

  /** ct of a scalar constant, then use as any other ct (cheap — no HE op). */
  constant(value: bigint): FheCiphertext;

  /** ct(1 if a == b else 0). Comparison is the expensive op in FHE. */
  eq(a: FheCiphertext, b: FheCiphertext): FheCiphertext;

  /** ct(1 if a <= b else 0). */
  lte(a: FheCiphertext, b: FheCiphertext): FheCiphertext;

  /** ct(1 if a >= b else 0). */
  gte(a: FheCiphertext, b: FheCiphertext): FheCiphertext;

  /**
   * Select — equivalent to plaintext ternary (cond ? ifTrue : ifFalse),
   * implemented homomorphically as (cond * ifTrue) + ((1-cond) * ifFalse).
   * `cond` must be a ct of 0 or 1.
   */
  select(cond: FheCiphertext, ifTrue: FheCiphertext, ifFalse: FheCiphertext): FheCiphertext;
}

/**
 * MockFheBackend — a transparent implementation that stores the plaintext
 * inside the "ciphertext" byte array. Lets the strict-mode path run on
 * devnet without a real FHE library. Obviously provides ZERO privacy —
 * the whole point is to validate the algorithm's structure.
 *
 * Ciphertexts are 16 bytes: 8 bytes of big-endian u64 value followed by a
 * 4-byte magic header + 4 bytes of operation count (bumped on every op,
 * so we can see in tests that HE ops actually happened).
 */
export class MockFheBackend implements FheBackend {
  readonly name = "mock-encrypt-devnet";
  private opCount = 0;

  private pack(value: bigint): FheCiphertext {
    const buf = new Uint8Array(16);
    buf.set([0xfe, 0xed, 0xfa, 0xce], 0); // "FEEDFACE" magic
    const view = new DataView(buf.buffer);
    view.setUint32(4, this.opCount, false);
    // Store value in the last 8 bytes, big-endian
    const v = value & 0xffffffffffffffffn;
    view.setBigUint64(8, v, false);
    return buf;
  }

  private unpack(ct: FheCiphertext): bigint {
    if (ct.length !== 16) {
      throw new Error(`MockFheBackend: expected 16-byte ct, got ${ct.length}`);
    }
    if (ct[0] !== 0xfe || ct[1] !== 0xed || ct[2] !== 0xfa || ct[3] !== 0xce) {
      throw new Error("MockFheBackend: invalid magic header (not a mock ct?)");
    }
    return new DataView(ct.buffer, ct.byteOffset, ct.byteLength).getBigUint64(8, false);
  }

  encrypt(value: bigint): FheCiphertext {
    return this.pack(value);
  }
  constant(value: bigint): FheCiphertext {
    return this.pack(value);
  }
  decrypt(ct: FheCiphertext): bigint {
    return this.unpack(ct);
  }
  add(a: FheCiphertext, b: FheCiphertext): FheCiphertext {
    this.opCount++;
    return this.pack(this.unpack(a) + this.unpack(b));
  }
  sub(a: FheCiphertext, b: FheCiphertext): FheCiphertext {
    this.opCount++;
    const av = this.unpack(a);
    const bv = this.unpack(b);
    return this.pack(av >= bv ? av - bv : (1n << 64n) + av - bv);
  }
  mul(a: FheCiphertext, b: FheCiphertext): FheCiphertext {
    this.opCount++;
    return this.pack(this.unpack(a) * this.unpack(b));
  }
  eq(a: FheCiphertext, b: FheCiphertext): FheCiphertext {
    this.opCount++;
    return this.pack(this.unpack(a) === this.unpack(b) ? 1n : 0n);
  }
  lte(a: FheCiphertext, b: FheCiphertext): FheCiphertext {
    this.opCount++;
    return this.pack(this.unpack(a) <= this.unpack(b) ? 1n : 0n);
  }
  gte(a: FheCiphertext, b: FheCiphertext): FheCiphertext {
    this.opCount++;
    return this.pack(this.unpack(a) >= this.unpack(b) ? 1n : 0n);
  }
  select(cond: FheCiphertext, ifTrue: FheCiphertext, ifFalse: FheCiphertext): FheCiphertext {
    // (cond * ifTrue) + ((1 - cond) * ifFalse) — matches how real FHE does it
    const one = this.constant(1n);
    return this.add(this.mul(cond, ifTrue), this.mul(this.sub(one, cond), ifFalse));
  }

  /** Test helper — how many HE ops ran. */
  getOpCount(): number {
    return this.opCount;
  }
  resetOpCount(): void {
    this.opCount = 0;
  }
}

// ─── Backend selection ────────────────────────────────────────────────────

/**
 * Pick the FHE backend based on env. Currently only "mock" is implemented;
 * real REFHE is a future swap to `RefheBackend` once the SDK ships.
 */
export function selectFheBackend(source: string | undefined): FheBackend {
  const src = (source ?? "mock").toLowerCase();
  switch (src) {
    case "mock":
    case "mock-encrypt-devnet":
      return new MockFheBackend();
    // case "refhe": return new RefheBackend();  // TODO when SDK ships
    default:
      throw new Error(`Unknown FHE backend: ${source}. Supported: mock.`);
  }
}
