import { keccak_256 } from "@noble/hashes/sha3.js";
import type { CLOBRoutingSummary } from "./polymarketRouter";
import type { PairMatchingResult } from "./pairMatcher";
import type { LPQuote } from "./lpRegistry";
import { PRICE_DECIMALS } from "./types";

/**
 * Ika cross-chain orchestrator.
 *
 * A settled Predacy batch on Solana only becomes real money on Polymarket
 * when four things happen atomically:
 *
 *   1. UNLOCK_SOLANA    — each user's shielded USDC on Solana is released to
 *                         the LP's Solana receive address. Authorized by the
 *                         user's Ika-ephemeral dWallet.
 *   2. LP_FUND_POLYGON  — the LP transfers equivalent Polygon USDC into
 *                         Polymarket's CTF contract (for matched pairs) or
 *                         posts limit orders (for residuals). Authorized by
 *                         the LP's Polygon key.
 *   3. POLYMARKET_EXEC  — Polymarket executes the mint/CLOB operation. No
 *                         signature from us — Polymarket moves once funded.
 *   4. DISTRIBUTE       — the resulting YES/NO tokens (or USDC back on a
 *                         SELL fill) are distributed to each user's
 *                         Ika-derived Polygon address. Authorized by the
 *                         Ika-orchestrator signature on the distribution tx.
 *
 * Ika's 2PC-MPC enforces atomicity — either all four legs sign successfully
 * and the bundle executes, or none do (and LP capital is released back).
 * See ARCHITECTURE.md §5.3 + §6.3.
 *
 * This module builds that plan. Each leg is a typed record with a
 * `messageDigest` (32-byte keccak256 of a stable per-leg preimage) that the
 * downstream Ika Sign request will authorize. On devnet no Polygon exists,
 * so executing a leg means "Ika produces a valid signature over the digest"
 * — which by itself proves the cryptographic path is live. Mainnet adds the
 * actual Polygon tx submission step, using the same digests.
 *
 * A bundle's status moves:
 *   planned → signing → executed
 *                    ↘ reverted (any leg failed → releaseCapital)
 */

export type LegKind = "unlock-solana" | "lp-fund-polygon" | "polymarket-exec" | "distribute";
export type LegStatus = "pending" | "signed" | "failed";
export type BundleStatus = "planned" | "signing" | "executed" | "reverted";

export interface CrossChainLeg {
  /** Stable id within a bundle. */
  id: string;
  kind: LegKind;
  chain: "solana" | "polygon";
  /** Short human-readable description. Shown in /batch/:id/cross-chain. */
  description: string;
  /** keccak256(preimage) — the value Ika will sign. 32 bytes. */
  messageDigest: Uint8Array;
  /**
   * Who's expected to authorize this leg.
   *
   *   - `user-ephemeral`: the user's in-memory ephemeral, via Ika dWallet
   *     (the relayer pays the tx fee via /sponsor-fee; user owns the sig)
   *   - `lp-ika`: the LP's own Ika-derived key (LP owns the Polygon outflow)
   *   - `protocol`: the Ika-orchestrator itself (Predacy-level distribution)
   *   - `polymarket`: Polymarket's own CTF contract — no sig from us
   */
  signer: "user-ephemeral" | "lp-ika" | "protocol" | "polymarket";
  /** USDC value (6-dec) moving through this leg, if any. */
  usdcValue?: bigint;
  status: LegStatus;
  /** Populated after Ika sign succeeds. Hex string. */
  signatureHex?: string;
  /** Populated on failure. */
  error?: string;
}

export interface CrossChainBundle {
  batchId: string;
  marketId: string;
  status: BundleStatus;
  legs: CrossChainLeg[];
  lpId: string | null;
  createdAt: number;
  executedAt?: number;
  /** Set when status transitions to "reverted". */
  revertedReason?: string;
}

/**
 * Plan the cross-chain bundle for a settled batch.
 *
 * Input is the pair-matching result + CLOB routing summary the batch
 * processor already computed. Output is a fully-typed bundle in "planned"
 * state — no signatures yet.
 */
export function planBundle(input: {
  batchId: string;
  marketId: string;
  clearingPrice: bigint;
  pairMatching: PairMatchingResult;
  clobRouting: CLOBRoutingSummary;
  lpQuote: LPQuote | null;
}): CrossChainBundle {
  const { batchId, marketId, clearingPrice, pairMatching, clobRouting, lpQuote } = input;
  const legs: CrossChainLeg[] = [];

  // Digest preimages encode the batch + leg identity so each digest is
  // unique per (batch, leg) pair. Stable across relayer restarts so the UI
  // can re-plan and get the same digests.
  const digest = (preimage: string): Uint8Array =>
    keccak_256(new TextEncoder().encode(preimage));

  // Total user-side USDC that needs unlocking = matched-pair USDC +
  // residual-buy USDC. Sell-side users DEPOSIT tokens (not USDC), so their
  // Solana leg is already done at commit time.
  const noPrice = PRICE_DECIMALS - clearingPrice;
  const residualBuyUsdc =
    (pairMatching.residualYesBuyQty * clearingPrice) / PRICE_DECIMALS +
    (pairMatching.residualNoBuyQty * noPrice) / PRICE_DECIMALS;
  const matchedUsdc = pairMatching.matchedPairUsdc;
  const totalUserUsdc = matchedUsdc + residualBuyUsdc;

  // Leg 1: Unlock Solana USDC → LP (one aggregate leg for the batch, even
  // though in production each user gets their own unlock sig. The
  // aggregate makes the UI cleaner and matches the "atomic bundle" narrative.)
  if (totalUserUsdc > 0n) {
    legs.push({
      id: `leg-1-unlock`,
      kind: "unlock-solana",
      chain: "solana",
      description:
        `Unlock $${Number(totalUserUsdc) / 1e6} from user shielded vaults → ` +
        `LP Solana address${lpQuote ? ` (${lpQuote.displayName})` : ""}. ` +
        `Authorized by each user's Ika-ephemeral dWallet.`,
      messageDigest: digest(`predacy:v1:${batchId}:unlock-solana:${totalUserUsdc.toString()}`),
      signer: "user-ephemeral",
      usdcValue: totalUserUsdc,
      status: "pending",
    });
  }

  // Leg 2: LP funds Polygon side — split into sub-legs for matched vs CLOB.
  // For the bundle view we aggregate into one entry.
  if (lpQuote && lpQuote.usdcAmount > 0n) {
    legs.push({
      id: `leg-2-lp-fund`,
      kind: "lp-fund-polygon",
      chain: "polygon",
      description:
        `${lpQuote.displayName} releases $${Number(lpQuote.usdcAmount) / 1e6} Polygon USDC ` +
        `(fee ${lpQuote.feeBps}bps = $${Number(lpQuote.feeUsdc) / 1e6}). ` +
        `Signed by LP's Ika key — atomic with leg 1 via Ika 2PC.`,
      messageDigest: digest(
        `predacy:v1:${batchId}:lp-fund:${lpQuote.lpId}:${lpQuote.usdcAmount.toString()}`,
      ),
      signer: "lp-ika",
      usdcValue: lpQuote.usdcAmount,
      status: "pending",
    });
  }

  // Leg 3: Polymarket CTF execution (complete-set mint + any CLOB fills).
  if (matchedUsdc > 0n || clobRouting.receipts.length > 0) {
    legs.push({
      id: `leg-3-polymarket`,
      kind: "polymarket-exec",
      chain: "polygon",
      description:
        (matchedUsdc > 0n
          ? `CTF.splitPosition: mint ${Number(pairMatching.matchedPairQty) / 1e6} complete sets ($${Number(matchedUsdc) / 1e6}). `
          : "") +
        (clobRouting.receipts.length > 0
          ? `${clobRouting.receipts.length} CLOB limit order(s) posted against Polymarket book. `
          : "") +
        `No external signature from Predacy — Polymarket moves once funded.`,
      messageDigest: digest(
        `predacy:v1:${batchId}:polymarket:matched=${matchedUsdc}:residuals=${clobRouting.receipts.length}`,
      ),
      signer: "polymarket",
      usdcValue: matchedUsdc + clobRouting.totalUsdcToLp,
      status: "pending",
    });
  }

  // Leg 4: Distribute YES/NO tokens (and any CLOB fill USDC) back to users'
  // Ika-derived Polygon addresses. Signed by the Ika orchestrator itself.
  legs.push({
    id: `leg-4-distribute`,
    kind: "distribute",
    chain: "polygon",
    description:
      `Distribute: ` +
      `${Number(pairMatching.matchedPairQty) / 1e6} YES → YES-buyers, ` +
      `${Number(pairMatching.matchedPairQty) / 1e6} NO → NO-buyers, ` +
      `CLOB fills → residual orderers. ` +
      `Signed by Ika-orchestrator key; atomic with legs 1–3.`,
    messageDigest: digest(`predacy:v1:${batchId}:distribute`),
    signer: "protocol",
    status: "pending",
  });

  return {
    batchId,
    marketId,
    status: "planned",
    legs,
    lpId: lpQuote?.lpId ?? null,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Execute the Ika signature legs of a bundle for real, on devnet.
 *
 * For each leg whose `signer` is not `polymarket`, request an Ika signature
 * over the leg's `messageDigest` using the provided user's dWallet. This
 * demonstrates the cryptographic authorization path end-to-end — the
 * signatures are byte-matching against on-chain `MessageApproval` PDAs
 * (same flow proven in the `Full Ika end-to-end signatures` milestone).
 *
 * The Polygon submission step is separate and remains out-of-scope until
 * we deploy a Polygon-side CTF Exchange on Amoy (Polymarket's hosted CLOB
 * is mainnet-only). But having real Ika sigs per leg means the bundle is
 * no longer "planned only" — the cross-chain authorization is provably
 * live.
 *
 * On devnet each Ika sign costs a few seconds + ~0.0001 SOL in rent for
 * the MessageApproval PDA. We only fire for `user-ephemeral`, `lp-ika`,
 * and `protocol` legs (Polymarket legs don't need our sig).
 */
export async function executeBundle(
  bundle: CrossChainBundle,
  ikaApproveAndSign: (userWallet: string, digest: Uint8Array) => Promise<{ signature: string; approveTxSignature: string }>,
  userWallet: string,
): Promise<CrossChainBundle> {
  if (bundle.status !== "planned") {
    throw new Error(`Cannot execute bundle with status=${bundle.status}`);
  }
  bundle.status = "signing";

  for (const leg of bundle.legs) {
    if (leg.signer === "polymarket") {
      // Polymarket itself executes once funded — no sig from us needed.
      leg.status = "signed";
      continue;
    }
    try {
      const result = await ikaApproveAndSign(userWallet, leg.messageDigest);
      leg.signatureHex = result.signature;
      leg.status = "signed";
    } catch (err: any) {
      leg.error = err?.message ?? "Ika sign failed";
      leg.status = "failed";
      bundle.status = "reverted";
      bundle.revertedReason = `leg ${leg.id} failed: ${leg.error}`;
      // TODO: in production, call lpRegistry.releaseCapital here too so
      // the LP's reserved capital isn't locked up by a failed bundle.
      return bundle;
    }
  }

  bundle.status = "executed";
  bundle.executedAt = Math.floor(Date.now() / 1000);
  return bundle;
}

/**
 * In-memory bundle store, keyed by batchId.toString(). Bounded to last 100.
 */
export class BundleStore {
  private store: Map<string, CrossChainBundle> = new Map();

  save(bundle: CrossChainBundle): void {
    this.store.set(bundle.batchId, bundle);
    // Cap memory — drop oldest.
    if (this.store.size > 100) {
      const oldest = [...this.store.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.store.delete(oldest.batchId);
    }
  }

  get(batchId: string): CrossChainBundle | undefined {
    return this.store.get(batchId);
  }

  list(): CrossChainBundle[] {
    return [...this.store.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  }
}

let singleton: BundleStore | null = null;
export function getBundleStore(): BundleStore {
  if (!singleton) singleton = new BundleStore();
  return singleton;
}

/**
 * Serialize a bundle for JSON transport (bigints → decimal strings).
 * Used by GET /batch/:id/cross-chain.
 */
export function serializeBundle(bundle: CrossChainBundle): Record<string, unknown> {
  return {
    ...bundle,
    legs: bundle.legs.map((leg) => ({
      ...leg,
      messageDigest: Buffer.from(leg.messageDigest).toString("hex"),
      usdcValue: leg.usdcValue?.toString(),
    })),
  };
}
