/**
 * LP registry — Predacy's Polygon-USDC liquidity market (mock, devnet).
 *
 * ARCHITECTURE.md §5.3 explains the why: users' USDC sits shielded on Solana,
 * but Polymarket mints + CLOB orders need USDC on Polygon. Rather than bridge
 * funds (slow) or hold float (capital-intensive), Predacy taps a market of
 * yield-seeking LPs who provide Polygon USDC instantly in exchange for a
 * small fee per batch. Ika MPC enforces atomicity so LPs bear zero
 * counterparty risk.
 *
 * This module models that market:
 *
 *   - Each LP entry has a Solana receive address, a Polygon payout address,
 *     available Polygon USDC capital, and a fee rate in basis points.
 *   - `reserveCapital(usdcAmount)` picks the cheapest LP that can cover the
 *     batch, deducts available capital, and returns a quote with fee.
 *   - `releaseCapital(lpId, usdcAmount)` credits capital back if something
 *     goes wrong (atomic revert, settlement failure, etc.).
 *   - `recordSettled(lpId, feeEarned)` bumps the LP's earned-fee counter.
 *
 * On devnet:
 *   - Zero real Polygon USDC moves. LPs are bookkeeping entries.
 *   - `polymarketRouter.ts` picks an LP per batch and tags routing receipts
 *     with the LP's id so the settlement API + UI can show provenance.
 *
 * On mainnet (future): same API, but `reserveCapital` additionally issues
 * an Ika signature request locking the LP's Solana USDC receipt address as
 * the destination of the user-side unlock, and the Polygon USDC payout
 * address as the source of the Polymarket mint/CLOB submission. If any leg
 * fails, Ika aborts the 2PC-MPC dance and no funds move.
 */

export interface LPEntry {
  /** Stable identifier. */
  id: string;
  /** Display name (shown in the settlement UI). */
  displayName: string;
  /** Solana address where the LP receives USDC unlocked from user orders. */
  solanaReceiveAddress: string;
  /** Polygon address the LP uses to fund Polymarket mints + CLOB. */
  polygonPayoutAddress: string;
  /** Available Polygon USDC capital (6-decimal bigint). */
  availableUsdc: bigint;
  /** Fee charged per LP'd USDC, in basis points (10000 = 100%). */
  feeBps: number;
  /** Cumulative fees earned, for transparency. 6-decimal USDC. */
  earnedFeesUsdc: bigint;
  /** Cumulative USDC volume served. */
  totalVolumeUsdc: bigint;
  /** Unix seconds when this LP was registered. */
  registeredAt: number;
  /** Whether this LP is accepting new quotes. */
  active: boolean;
}

export interface LPQuote {
  lpId: string;
  displayName: string;
  /** USDC amount the LP agreed to provide (6-decimal). */
  usdcAmount: bigint;
  /** Fee applied, computed as usdcAmount * feeBps / 10000. */
  feeUsdc: bigint;
  /** Rate used at quote time (basis points). Stays stable until release/settle. */
  feeBps: number;
  /** Unix seconds when the quote was issued (reservation timestamp). */
  reservedAt: number;
}

export class LPRegistry {
  private lps: Map<string, LPEntry> = new Map();

  /** Register a new LP. */
  register(entry: Omit<LPEntry, "registeredAt" | "earnedFeesUsdc" | "totalVolumeUsdc" | "active">): LPEntry {
    const full: LPEntry = {
      ...entry,
      earnedFeesUsdc: 0n,
      totalVolumeUsdc: 0n,
      registeredAt: Math.floor(Date.now() / 1000),
      active: true,
    };
    this.lps.set(entry.id, full);
    return full;
  }

  /** List all registered LPs (active + inactive). */
  list(): LPEntry[] {
    return Array.from(this.lps.values());
  }

  get(id: string): LPEntry | undefined {
    return this.lps.get(id);
  }

  /**
   * Pick the cheapest active LP that can cover `usdcAmount` and reserve the
   * capital. Returns the quote, or null if no LP can serve the request.
   *
   * Selection rule: lowest feeBps wins; ties break by highest availableUsdc
   * (prefer a deeper pool so we don't fragment capital).
   */
  reserveCapital(usdcAmount: bigint): LPQuote | null {
    if (usdcAmount <= 0n) {
      throw new Error(`reserveCapital: usdcAmount must be > 0, got ${usdcAmount}`);
    }

    let best: LPEntry | null = null;
    for (const lp of this.lps.values()) {
      if (!lp.active) continue;
      if (lp.availableUsdc < usdcAmount) continue;
      if (!best) {
        best = lp;
        continue;
      }
      // Lower fee wins.
      if (lp.feeBps < best.feeBps) {
        best = lp;
        continue;
      }
      // Fee tie → deeper pool wins.
      if (lp.feeBps === best.feeBps && lp.availableUsdc > best.availableUsdc) {
        best = lp;
      }
    }

    if (!best) return null;

    // Reserve by deducting from available capital.
    const feeUsdc = (usdcAmount * BigInt(best.feeBps)) / 10_000n;
    best.availableUsdc -= usdcAmount;

    return {
      lpId: best.id,
      displayName: best.displayName,
      usdcAmount,
      feeUsdc,
      feeBps: best.feeBps,
      reservedAt: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Credit capital back to an LP if a routing step failed. Safe to call even
   * if the LP id no longer exists (logs + skips).
   */
  releaseCapital(lpId: string, usdcAmount: bigint): void {
    const lp = this.lps.get(lpId);
    if (!lp) {
      console.warn(`[LPRegistry] releaseCapital: unknown LP ${lpId}`);
      return;
    }
    lp.availableUsdc += usdcAmount;
  }

  /**
   * Confirm a quote settled successfully. Records the fee and updates volume.
   * Does NOT re-add the reserved capital — that's already been "spent" on
   * the Polymarket round-trip (in the production flow, the LP got paid in
   * Solana USDC from user unlocks, so net Polygon capital is down by the
   * routed amount but up by the Solana equivalent).
   */
  recordSettled(lpId: string, quote: LPQuote): void {
    const lp = this.lps.get(lpId);
    if (!lp) {
      console.warn(`[LPRegistry] recordSettled: unknown LP ${lpId}`);
      return;
    }
    lp.earnedFeesUsdc += quote.feeUsdc;
    lp.totalVolumeUsdc += quote.usdcAmount;
  }

  /** Toggle an LP's active flag. */
  setActive(lpId: string, active: boolean): boolean {
    const lp = this.lps.get(lpId);
    if (!lp) return false;
    lp.active = active;
    return true;
  }
}

/**
 * Module-level singleton so the LP registry persists across HTTP requests.
 */
let singleton: LPRegistry | null = null;

export function getLPRegistry(): LPRegistry {
  if (!singleton) {
    singleton = new LPRegistry();
    seedDefaultLPs(singleton);
  }
  return singleton;
}

/**
 * Seed three demo LPs with different fee points. Shown on the settlement
 * UI to illustrate the fee-market dynamic. Capital is aspirational —
 * devnet doesn't move any real USDC through any of these.
 */
function seedDefaultLPs(registry: LPRegistry): void {
  registry.register({
    id: "lp-genesis",
    displayName: "Genesis LP",
    // Solana address is a deterministic dummy; in production the relayer
    // would derive it from LP-submitted Ika attestations.
    solanaReceiveAddress: "GenesisLP1111111111111111111111111111111111",
    polygonPayoutAddress: "0xGenesisLPPolygonAddressDoesNotExistYet00",
    availableUsdc: 100_000_000_000n, // $100k
    feeBps: 15, // 0.15%
  });
  registry.register({
    id: "lp-swift",
    displayName: "Swift Liquidity",
    solanaReceiveAddress: "SwiftLPSolanaReceive11111111111111111111111",
    polygonPayoutAddress: "0xSwiftLPPolygonPayoutDoesNotExistYet0000",
    availableUsdc: 50_000_000_000n, // $50k
    feeBps: 20, // 0.20%
  });
  registry.register({
    id: "lp-boutique",
    displayName: "Boutique Capital",
    solanaReceiveAddress: "BoutiqueLP1111111111111111111111111111111111",
    polygonPayoutAddress: "0xBoutiqueLPPolygonPayoutDoesNotExistYet",
    availableUsdc: 10_000_000_000n, // $10k
    feeBps: 10, // 0.10% — cheapest but smallest pool
  });
  console.log("[LPRegistry] Seeded 3 demo LPs (total $160k aspirational capital, mock-devnet)");
}
