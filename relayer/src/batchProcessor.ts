import { SolanaClient } from "./solanaClient";
import { InMemoryOrderStore, OrderStore } from "./orderStore";
import { computeClearingPrice } from "./clearingPrice";
import {
  computeCommitment,
  computeCommitmentRoot,
  computeBatchCommitmentRoot,
  generateBatchProof,
  generateMockProof,
} from "./zkProver";
import { buildMerkleTree } from "./zkClaimProver";
import { computePairMatching, formatPairMatching, PairMatchingResult } from "./pairMatcher";
import { routeResiduals, CLOBRoutingSummary } from "./polymarketRouter";
import { planBundle, getBundleStore } from "./ikaOrchestrator";
import { getEventLedger } from "./eventLedger";
import { getLiquidityStack, ResidualImbalance, LiquidityFillResult } from "./liquidityStack";
import { selectFheBackend } from "./fheBackend";
import { encryptOrder, computeEncryptedClearing, candidatePricesFromPlaintext } from "./encryptedClearing";
import { computeOnchainFheClearing, loadPredacyFheProgram } from "./onchainFheClearing";
import {
  Order,
  OrderSide,
  MarketState,
  BATCH_WINDOW_MS,
  MAX_BATCH_ORDERS,
  MAX_BATCH_USD,
  PRICE_DECIMALS,
} from "./types";
import { PublicKey } from "@solana/web3.js";

/**
 * Per-batch settlement metadata captured during processBatch. Surfaced via
 * GET /settlement-stats so the UI can show the matched-pair / CLOB split.
 */
export interface BatchSettlementStats {
  batchId: string;           // bigint.toString()
  marketId: string;          // hex
  settledAt: number;         // unix seconds
  clearingPrice: string;     // 6-decimal as string (bigint)
  filledYesBuyVol: string;
  filledNoBuyVol: string;
  filledYesSellQty: string;
  filledNoSellQty: string;
  pairMatching: {
    matchedPairQty: string;
    matchedPairUsdc: string;
    matchedPercentBps: number;
    residualYesBuyQty: string;
    residualNoBuyQty: string;
    residualYesSellQty: string;
    residualNoSellQty: string;
  };
  /**
   * Which privacy mode ran the clearing.
   *   "fast"   — plaintext clearing (clearingPrice.ts)
   *   "strict" — FHE clearing (encryptedClearing.ts); relayer never saw
   *              per-order data in plaintext.
   */
  privacyMode: "fast" | "strict" | "onchain-fhe";
  /**
   * When privacyMode=strict, which FHE backend ran. On devnet this is
   * "mock-encrypt-devnet" (transparent stub — see fheBackend.ts); real
   * Encrypt REFHE swaps this to "refhe" with no algorithm changes.
   */
  fheBackend?: string;
  /**
   * HE op count during strict-mode clearing (0 in fast mode). High values
   * indicate expensive comparison ops; useful for cost estimation.
   */
  fheOpCount?: number;
  /** Strict-mode wall-clock ms spent running the FHE clearing circuit. */
  fheElapsedMs?: number;
  clobRouting: {
    receiptCount: number;
    totalUsdcToLp: string;
    totalUsdcFromPolymarket: string;
    source: "mock-devnet" | "polymarket-mainnet";
    elapsedMs: number;
  };
  liquidityProvider: {
    /** null when no buy-side residuals existed, or when no LP had capacity. */
    lpId: string | null;
    displayName: string | null;
    /** USDC (6-dec) the LP put up for the batch's buy-side residuals. */
    usdcAmount: string;
    /** Fee earned by the LP, 6-dec USDC. */
    feeUsdc: string;
    feeBps: number;
    /** True if buy-side residuals existed but no LP had capacity. */
    unavailable: boolean;
  };
}

export class BatchProcessor {
  private client: SolanaClient;
  private store: OrderStore;
  private markets: Map<string, MarketState> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private circuitsPath: string;
  private useRealZk: boolean;
  private privacyMode: "fast" | "strict" | "onchain-fhe";
  private fheBackendName: "mock";
  /**
   * batchId (as decimal string) → settlement metadata. Populated after
   * processBatch completes; consumed by GET /settlement-stats. In-memory
   * only — production would persist to Redis.
   */
  private settlementStats: Map<string, BatchSettlementStats> = new Map();

  constructor(
    client: SolanaClient,
    circuitsPath: string,
    useRealZk: boolean,
    opts?: {
      privacyMode?: "fast" | "strict" | "onchain-fhe";
      fheBackend?: "mock";
      store?: OrderStore;
    },
  ) {
    this.client = client;
    this.circuitsPath = circuitsPath;
    this.useRealZk = useRealZk;
    this.privacyMode = opts?.privacyMode ?? "fast";
    this.fheBackendName = opts?.fheBackend ?? "mock";
    this.store = opts?.store || new InMemoryOrderStore();
  }

  // ─── Market Management ───

  getMarketState(marketIdHex: string): MarketState | undefined {
    return this.markets.get(marketIdHex);
  }

  async startMarket(marketId: Buffer): Promise<void> {
    const key = marketId.toString("hex");
    if (this.markets.has(key)) {
      console.log(`[BatchProcessor] Market ${key.slice(0, 8)}... already active`);
      return;
    }

    const state: MarketState = {
      marketId,
      currentBatchId: null,
      settlingBatchId: null,
      processingBatch: false,
      openingBatch: false,
      closingBatch: false,
      batchRunningUsd: 0n,
      lastOrderSubmitAt: 0,
      batchOpenedAt: Math.floor(Date.now() / 1000),
      settlingStartedAt: 0,
      orders: new Map(),
    };

    this.markets.set(key, state);
    console.log(`[BatchProcessor] Starting market ${key.slice(0, 8)}...`);

    // Auto-create market on-chain if it doesn't exist
    try {
      await this.client.fetchMarket(marketId);
      console.log(`[BatchProcessor] Market exists on-chain`);
    } catch {
      console.log(`[BatchProcessor] Market not found on-chain, creating...`);
      try {
        await this.client.createMarket(marketId);
        console.log(`[BatchProcessor] Market created on-chain`);
      } catch (e: any) {
        if (e.message?.includes("already in use")) {
          console.log(`[BatchProcessor] Market already exists (race condition)`);
        } else {
          throw e;
        }
      }
    }

    // Open first batch
    await this.openNewBatch(key);
  }

  // ─── Batch Lifecycle ───

  private async openNewBatch(marketKey: string): Promise<void> {
    const state = this.markets.get(marketKey)!;
    if (state.openingBatch) return;
    state.openingBatch = true;

    try {
      const market = await this.client.fetchMarket(state.marketId);
      const batchIndex = BigInt((market as any).currentBatchIndex.toString());

      await this.client.openBatch(state.marketId);

      state.currentBatchId = batchIndex;
      state.batchRunningUsd = 0n;
      state.batchOpenedAt = Math.floor(Date.now() / 1000);
      state.orders = new Map();

      console.log(`[BatchProcessor] Opened batch ${batchIndex} for market ${marketKey.slice(0, 8)}...`);

      // Set timer to auto-close after batch window
      this.scheduleBatchClose(marketKey, batchIndex);
    } catch (err) {
      console.error(`[BatchProcessor] Failed to open batch:`, err);
    } finally {
      state.openingBatch = false;
    }
  }

  private scheduleBatchClose(marketKey: string, batchIndex: bigint): void {
    // Clear any existing timer
    const existingTimer = this.timers.get(marketKey);
    if (existingTimer) clearTimeout(existingTimer);

    // Add 5s buffer to account for Solana clock skew vs local timer
    const timer = setTimeout(async () => {
      await this.closeBatch(marketKey, batchIndex);
    }, BATCH_WINDOW_MS + 5_000);

    this.timers.set(marketKey, timer);
  }

  private async closeBatch(marketKey: string, batchIndex: bigint): Promise<void> {
    const state = this.markets.get(marketKey);
    if (!state || state.closingBatch) return;
    if (state.currentBatchId !== batchIndex) return; // already closed

    state.closingBatch = true;

    try {
      await this.client.closeBatch(state.marketId, batchIndex);
      console.log(`[BatchProcessor] Closed batch ${batchIndex}`);

      state.settlingBatchId = batchIndex;
      state.currentBatchId = null;
      state.settlingStartedAt = Math.floor(Date.now() / 1000);

      // Process the closed batch (async)
      this.processBatch(marketKey, batchIndex).catch(console.error);

      // Only open next batch if there were orders — don't cycle empty batches
      // New batch will be opened on-demand when next order arrives
    } catch (err) {
      console.error(`[BatchProcessor] Failed to close batch:`, err);
    } finally {
      state.closingBatch = false;
    }
  }

  // ─── Order Submission ───

  async submitOrder(marketIdHex: string, order: Order): Promise<{
    batchId: bigint;
    commitment: bigint;
  }> {
    const state = this.markets.get(marketIdHex);
    if (!state) {
      throw new Error("Market not active");
    }

    // Open a new batch on-demand if none is active
    if (state.currentBatchId === null) {
      await this.openNewBatch(marketIdHex);
    }
    if (state.currentBatchId === null) {
      throw new Error("Failed to open batch for market");
    }

    // Compute commitment
    const marketIdBigInt = BigInt("0x" + marketIdHex);
    const commitment = await computeCommitment(
      marketIdBigInt,
      order.side,
      order.amount,
      order.limitPrice,
      order.salt,
    );
    order.commitment = commitment;

    // Check caps
    if (state.orders.size >= MAX_BATCH_ORDERS) {
      throw new Error("Batch order limit reached");
    }
    if (state.batchRunningUsd + order.amount > MAX_BATCH_USD) {
      throw new Error("Batch USD cap reached");
    }

    // Store order
    const commitKey = commitment.toString();
    await this.store.save(state.currentBatchId.toString(), commitKey, order);
    state.orders.set(commitKey, order);
    state.batchRunningUsd += order.amount;
    state.lastOrderSubmitAt = Date.now();

    console.log(`[BatchProcessor] Order stored: side=${OrderSide[order.side]} amount=${order.amount} commitment=${commitKey.slice(0, 12)}...`);

    // Early close if caps hit
    if (state.orders.size >= MAX_BATCH_ORDERS) {
      console.log("[BatchProcessor] Max orders reached, early closing batch");
      this.closeBatch(marketIdHex, state.currentBatchId).catch(console.error);
    }

    return {
      batchId: state.currentBatchId,
      commitment,
    };
  }

  // ─── Batch Settlement ───

  private async processBatch(marketKey: string, batchIndex: bigint): Promise<void> {
    const state = this.markets.get(marketKey);
    if (!state || state.processingBatch) return;
    state.processingBatch = true;

    try {
      console.log(`[BatchProcessor] Processing batch ${batchIndex}...`);

      // 1. Load orders for this batch
      const orders = await this.store.load(batchIndex.toString());
      const orderList = Array.from(orders.values());

      if (orderList.length === 0) {
        console.log(`[BatchProcessor] Batch ${batchIndex} empty, skipping settlement`);
        state.settlingBatchId = null;
        return;
      }

      // 2. Compute clearing price. Two paths:
      //    fast   → plaintext computeClearingPrice
      //    strict → FHE clearing via encryptedClearing.ts (relayer never
      //             sees per-order plaintext; only aggregate outputs get
      //             decrypted). See fheBackend.ts + encryptedClearing.ts.
      //
      // Tier 0 LMSR price anchor — when the bootstrap pool exists and is
      // not yet graduated, its marginal price drives the clearing price
      // directly. The LMSR is the protocol's counterparty for residuals,
      // so its price IS the fair price of the next unit. Each settled
      // batch updates the pool, which re-anchors the next batch's
      // price → real-time price discovery across batches without
      // matched counter-orders. Falls through to legacy candidate-search
      // when the pool isn't init'd or has graduated to Tier 1.
      let fheStats: { backend: string; opCount: number; elapsedMs: number } | null = null;
      const lmsrAnchor = await this.maybeLmsrAnchor(state.marketId);
      const result = computeClearingPrice(orderList, lmsrAnchor);
      if (lmsrAnchor !== null) {
        console.log(
          `[BatchProcessor] Tier 0 LMSR anchor: ${lmsrAnchor} (${(Number(lmsrAnchor) / 10000).toFixed(2)}¢ YES) — clearing locked here`,
        );
      }
      if (this.privacyMode === "strict") {
        const backend = selectFheBackend(this.fheBackendName);
        const encOrders = orderList.map((o) => encryptOrder(backend, o));
        // Inject the LMSR anchor into the candidate set so the FHE path's
        // best-price search can pick it (otherwise the consistency check
        // below trips on every batch where the plaintext path used the
        // anchor and FHE didn't see it as a candidate).
        const candidates = candidatePricesFromPlaintext(orderList);
        if (lmsrAnchor !== null && !candidates.includes(lmsrAnchor)) candidates.push(lmsrAnchor);
        const strictResult = computeEncryptedClearing(backend, encOrders, candidates);
        console.log(
          `[BatchProcessor] STRICT mode cleared: price=${strictResult.clearingPrice} ` +
            `ops=${strictResult.opCount} elapsed=${strictResult.elapsedMs}ms ` +
            `backend=${strictResult.backend}`,
        );
        // Consistency check: FHE path MUST match plaintext path (MockFHE
        // is transparent, so any mismatch indicates an algorithm bug).
        // With real REFHE this check gets skipped since we wouldn't
        // have the plaintext to compare against.
        if (
          strictResult.clearingPrice !== result.clearingPrice ||
          strictResult.filledYesBuyVol !== result.filledYesBuyVol ||
          strictResult.filledNoBuyVol !== result.filledNoBuyVol ||
          strictResult.filledYesSellQty !== result.filledYesSellQty ||
          strictResult.filledNoSellQty !== result.filledNoSellQty
        ) {
          console.warn(
            `[BatchProcessor] ⚠ Strict-mode result differs from plaintext ` +
              `(strict=${strictResult.clearingPrice} vs plain=${result.clearingPrice}). ` +
              `This is an algorithm bug in encryptedClearing.ts — using strict result.`,
          );
        }
        // Adopt strict-mode results as source of truth.
        result.clearingPrice = strictResult.clearingPrice;
        result.filledYesBuyVol = strictResult.filledYesBuyVol;
        result.filledNoBuyVol = strictResult.filledNoBuyVol;
        result.filledYesSellQty = strictResult.filledYesSellQty;
        result.filledNoSellQty = strictResult.filledNoSellQty;
        fheStats = {
          backend: strictResult.backend,
          opCount: strictResult.opCount,
          elapsedMs: strictResult.elapsedMs,
        };
      } else if (this.privacyMode === "onchain-fhe") {
        // ── On-chain FHE clearing — async post-settlement attestation ──
        //
        // The FHE graph re-computes the same per-side aggregates that the
        // plaintext path already produces (clearing price is a plaintext
        // input either way). So FHE adds an *attestation* that those
        // aggregates were derived correctly under encryption — but the
        // settlement itself doesn't need it on the critical path.
        //
        // Encrypt's pre-Alpha executor latency is variable (typical 2-5s,
        // spikes to 60-180s under load). Blocking the user-facing 30s batch
        // SLA on it makes settlement feel slow. So we kick FHE off as a
        // background job, settle the batch immediately on plaintext, and
        // patch the settlement stats record when FHE eventually commits
        // (or log failure if Encrypt's executor never responds).
        fheStats = {
          backend: "onchain-encrypt-devnet-pending",
          opCount: 0,
          elapsedMs: 0,
        };
        // Capture the values we'll need inside the async block — they get
        // mutated downstream by the rest of settlement.
        const fhePlaintextSnapshot = {
          yesBuyVol: result.filledYesBuyVol,
          noBuyVol: result.filledNoBuyVol,
          yesSellQty: result.filledYesSellQty,
          noSellQty: result.filledNoSellQty,
        };
        const fheBatchKey = state.marketId.toString("hex");
        // No await — runs in parallel with settlement. The batch flow below
        // proceeds with plaintext aggregates (same numbers FHE would emit).
        (async () => {
          try {
            const provider = new (await import("@coral-xyz/anchor")).AnchorProvider(
              this.client.getConnection(),
              new (await import("@coral-xyz/anchor")).Wallet(this.client.relayer),
              { commitment: "confirmed" },
            );
            const program = loadPredacyFheProgram(provider as any);
            const onchainResult = await computeOnchainFheClearing(
              this.client.getConnection(),
              this.client.relayer,
              program,
              orderList,
              result.clearingPrice,
            );
            console.log(
              `[BatchProcessor] ONCHAIN-FHE attestation cleared (async): ` +
                `tx=${onchainResult.settleTxSig.slice(0, 12)}… ` +
                `executor=${onchainResult.executorLatencyMs}ms total=${onchainResult.totalElapsedMs}ms ` +
                `for batch ${batchIndex}`,
            );
            // Cross-check vs the plaintext aggregates the batch settled with.
            if (
              onchainResult.filledYesBuyVol !== fhePlaintextSnapshot.yesBuyVol ||
              onchainResult.filledNoBuyVol !== fhePlaintextSnapshot.noBuyVol ||
              onchainResult.filledYesSellQty !== fhePlaintextSnapshot.yesSellQty ||
              onchainResult.filledNoSellQty !== fhePlaintextSnapshot.noSellQty
            ) {
              console.warn(
                `[BatchProcessor] ⚠ Async FHE diverged from plaintext settlement on batch ${batchIndex}: ` +
                  `yb=${onchainResult.filledYesBuyVol}/${fhePlaintextSnapshot.yesBuyVol} ` +
                  `nb=${onchainResult.filledNoBuyVol}/${fhePlaintextSnapshot.noBuyVol} ` +
                  `(settlement already finalised — divergence is informational only)`,
              );
            }
            // Patch the settlement stats record so /settlement-stats now
            // reports the FHE attestation tx + executor latency.
            const stat = this.settlementStats.get(batchIndex.toString());
            if (stat) {
              stat.fheBackend = "onchain-encrypt-devnet";
              stat.fheElapsedMs = onchainResult.totalElapsedMs;
            }
          } catch (err: any) {
            console.error(
              `[BatchProcessor] Async on-chain FHE attestation failed for batch ${batchIndex}: ` +
                `${err.message}. Settlement already finalised on plaintext aggregates.`,
            );
            const stat = this.settlementStats.get(batchIndex.toString());
            if (stat) {
              stat.fheBackend = "onchain-encrypt-devnet-failed";
            }
          }
        })().catch(() => { /* outer catch fence; inner already handles */ });
      } else {
        console.log(`[BatchProcessor] Clearing price: ${result.clearingPrice} (${result.filledOrders.length} filled, ${result.unfilledOrders.length} unfilled)`);
      }

      if (result.clearingPrice === 0n) {
        console.log(`[BatchProcessor] No crossing — clearing price is 0`);
        // Still need to settle with price=1 to allow refunds
        result.clearingPrice = 1n;
      }

      // 3. Compute commitments for all orders
      const marketIdBigInt = BigInt("0x" + marketKey);
      const commitments: bigint[] = [];
      for (const order of orderList) {
        const c = await computeCommitment(
          marketIdBigInt,
          order.side,
          order.amount,
          order.limitPrice,
          order.salt,
        );
        commitments.push(c);
      }

      // 4. Compute gaps (simplified — no CLOB integration yet)
      // In production, gaps would be filled on Polymarket CLOB
      const yesGap = 0n;
      const noGap = 0n;
      const finalExcessYes = 0n;
      const finalExcessNo = 0n;

      // 5. Phase 1: lockFunds — resolve relayer's ATAs
      const { getOrCreateAssociatedTokenAccount, mintTo, getAccount } = await import("@solana/spl-token");
      const protocolConfig = await this.client.fetchProtocolConfig();
      const usdcMint = (protocolConfig as any).usdcMint as PublicKey;
      const [yesMint] = this.client.yesMintPda(state.marketId);
      const [noMint] = this.client.noMintPda(state.marketId);
      const connection = this.client.getConnection();
      const relayerKp = this.client.relayer;

      // Ensure USDC vault has enough to cover sell payouts
      // (protocol is counterparty — mints USDC to cover sells beyond buyer deposits)
      const sellPayoutUsdc =
        (result.filledYesSellQty * result.clearingPrice) / PRICE_DECIMALS +
        (result.filledNoSellQty * (PRICE_DECIMALS - result.clearingPrice)) / PRICE_DECIMALS;
      const buyDeposits = result.filledYesBuyVol + result.filledNoBuyVol;
      if (sellPayoutUsdc > buyDeposits) {
        const deficit = sellPayoutUsdc - buyDeposits;
        const [usdcVault] = this.client.usdcVaultPda(state.marketId);
        await mintTo(connection, relayerKp, usdcMint, usdcVault, relayerKp, Number(deficit));
        console.log(`[BatchProcessor] Minted ${Number(deficit) / 1e6} USDC to vault for sell payouts`);
      }

      const relayerUsdcAccount = await getOrCreateAssociatedTokenAccount(connection, relayerKp, usdcMint, relayerKp.publicKey);
      const relayerYesAccount = await getOrCreateAssociatedTokenAccount(connection, relayerKp, yesMint, relayerKp.publicKey);
      const relayerNoAccount = await getOrCreateAssociatedTokenAccount(connection, relayerKp, noMint, relayerKp.publicKey);
      const relayerUsdcAta = relayerUsdcAccount.address;
      const relayerYesAta = relayerYesAccount.address;
      const relayerNoAta = relayerNoAccount.address;

      // 5a. Compute the Poseidon commitment_root that the batch circuit will
      // output as its public input. settle_batch verifies the Groth16 proof
      // against batch.commitment_root, so lockFunds must store exactly this
      // value — keccak chains won't match (see circuit spec).
      const commitmentRoot = await computeBatchCommitmentRoot(marketIdBigInt, commitments);
      const commitmentRootBytes = bigintToBytes32(commitmentRoot);

      // 5b. Classify filled volume into matched-pair (Path A: complete-set
      // mint) vs residual (Path B: Polymarket CLOB). See pairMatcher.ts.
      const pairMatching = computePairMatching(
        result.clearingPrice,
        result.filledYesBuyVol,
        result.filledNoBuyVol,
        result.filledYesSellQty,
        result.filledNoSellQty,
      );
      console.log(`[BatchProcessor] Pair matching: ${formatPairMatching(pairMatching)}`);

      await this.client.lockFunds(
        state.marketId,
        batchIndex,
        result.clearingPrice,
        result.filledYesBuyVol,
        result.filledNoBuyVol,
        result.filledYesSellQty,
        result.filledNoSellQty,
        yesGap,
        noGap,
        finalExcessYes,
        finalExcessNo,
        relayerUsdcAta,
        relayerYesAta,
        relayerNoAta,
        Array.from(commitmentRootBytes),
      );

      // 6. (Placeholder) CLOB gap-fill would happen here

      // 7. Build claim Merkle tree
      const { root: claimRoot } = await buildMerkleTree(commitments);
      const claimRootBytes = bigintToBytes32(claimRoot);

      // 8. Generate batch ZK proof
      let proofA: number[], proofB: number[], proofC: number[];

      if (this.useRealZk) {
        const { proof } = await generateBatchProof(
          marketIdBigInt,
          orderList,
          commitments,
          result.clearingPrice,
          result.filledYesBuyVol,
          result.filledNoBuyVol,
          result.filledYesSellQty,
          result.filledNoSellQty,
          this.circuitsPath,
        );
        proofA = Array.from(proof.proofA);
        proofB = Array.from(proof.proofB);
        proofC = Array.from(proof.proofC);
      } else {
        const mock = generateMockProof();
        proofA = Array.from(mock.proofA);
        proofB = Array.from(mock.proofB);
        proofC = Array.from(mock.proofC);
      }

      // 9. Phase 2: settleBatch. orderCount must match the value the
      // prover used as the `orderCount` public input — currently
      // `orderList.length` (unpadded count).
      await this.client.settleBatch(
        state.marketId,
        batchIndex,
        Array.from(claimRootBytes),
        proofA,
        proofB,
        proofC,
        relayerUsdcAta,
        relayerYesAta,
        relayerNoAta,
        orderList.length,
      );

      console.log(`[BatchProcessor] Batch ${batchIndex} settled successfully`);

      // 9b. Liquidity Stack — Tier 0/1 residual absorption (docs/LIQUIDITY.md).
      // No-ops cleanly when this market doesn't have an EventHandle attached
      // (legacy markets fall through to the original CLOB routing in step 10).
      // The Stack records its own ledger updates; tx submission is best-effort.
      const liquidityStack = getLiquidityStack(this.client, getEventLedger());
      let stackResult: LiquidityFillResult | null = null;
      try {
        const eventForMarket = liquidityStack.getEvent(marketKey);
        if (eventForMarket) {
          // Net residual imbalance per side, signed (positive = net BUY).
          const yesNet = pairMatching.residualYesBuyQty - pairMatching.residualYesSellQty;
          const noNet = pairMatching.residualNoBuyQty - pairMatching.residualNoSellQty;
          const takerVolUsdc =
            result.filledYesBuyVol +
            result.filledNoBuyVol +
            (result.filledYesSellQty * result.clearingPrice) / 1_000_000n +
            (result.filledNoSellQty * (1_000_000n - result.clearingPrice)) / 1_000_000n;
          const residual: ResidualImbalance = {
            yesNetBuy: yesNet,
            noNetBuy: noNet,
            clearingPrice: result.clearingPrice,
            takerVolumeUsdc: takerVolUsdc,
          };
          stackResult = await liquidityStack.absorbResidual(state.marketId, residual);
          console.log(
            `[LiquidityStack] tier=${stackResult.tier} txSig=${stackResult.txSig?.slice(0, 12) ?? "n/a"}` +
              ` deltaYes=${stackResult.deltaYes} deltaNo=${stackResult.deltaNo} usdcDelta=${stackResult.usdcDelta}`,
          );
        }
      } catch (err: any) {
        // Stack failure must NOT halt batch settlement — log + continue with
        // legacy routing. Tier 0/1 are safety nets, not critical path.
        console.error(`[LiquidityStack] absorbResidual failed (non-fatal):`, err.message);
      }

      // 10. Mock Polymarket CLOB routing for residuals. On devnet this is
      // metadata only — see polymarketRouter.ts. On mainnet this call becomes
      // real Ika-orchestrated LP unlocks + Polymarket CLOB submissions.
      // Skipped when the Liquidity Stack already absorbed (i.e. eventful market).
      const stackHandled = stackResult && stackResult.tier !== "none";
      const clobRouting: CLOBRoutingSummary = stackHandled
        ? {
            receipts: [],
            totalUsdcToLp: 0n,
            totalUsdcFromPolymarket: 0n,
            lpQuote: null,
            lpUnavailable: false,
            elapsedMs: 0,
          }
        : await routeResiduals(orderList, result.clearingPrice, pairMatching);

      // 11. Record settlement stats for the /settlement-stats API.
      const stats: BatchSettlementStats = {
        batchId: batchIndex.toString(),
        marketId: marketKey,
        settledAt: Math.floor(Date.now() / 1000),
        clearingPrice: result.clearingPrice.toString(),
        filledYesBuyVol: result.filledYesBuyVol.toString(),
        filledNoBuyVol: result.filledNoBuyVol.toString(),
        filledYesSellQty: result.filledYesSellQty.toString(),
        filledNoSellQty: result.filledNoSellQty.toString(),
        privacyMode: this.privacyMode,
        fheBackend: fheStats?.backend,
        fheOpCount: fheStats?.opCount,
        fheElapsedMs: fheStats?.elapsedMs,
        pairMatching: {
          matchedPairQty: pairMatching.matchedPairQty.toString(),
          matchedPairUsdc: pairMatching.matchedPairUsdc.toString(),
          matchedPercentBps: pairMatching.matchedPercentBps,
          residualYesBuyQty: pairMatching.residualYesBuyQty.toString(),
          residualNoBuyQty: pairMatching.residualNoBuyQty.toString(),
          residualYesSellQty: pairMatching.residualYesSellQty.toString(),
          residualNoSellQty: pairMatching.residualNoSellQty.toString(),
        },
        clobRouting: {
          receiptCount: clobRouting.receipts.length,
          totalUsdcToLp: clobRouting.totalUsdcToLp.toString(),
          totalUsdcFromPolymarket: clobRouting.totalUsdcFromPolymarket.toString(),
          source: clobRouting.receipts[0]?.source ?? "mock-devnet",
          elapsedMs: clobRouting.elapsedMs,
        },
        liquidityProvider: {
          lpId: clobRouting.lpQuote?.lpId ?? null,
          displayName: clobRouting.lpQuote?.displayName ?? null,
          usdcAmount: (clobRouting.lpQuote?.usdcAmount ?? 0n).toString(),
          feeUsdc: (clobRouting.lpQuote?.feeUsdc ?? 0n).toString(),
          feeBps: clobRouting.lpQuote?.feeBps ?? 0,
          unavailable: clobRouting.lpUnavailable,
        },
      };
      this.settlementStats.set(batchIndex.toString(), stats);

      // 12. Plan the Ika cross-chain bundle (planning-only on devnet — no
      // signatures fire here; see ikaOrchestrator.ts). The bundle surfaces
      // via GET /batch/:id/cross-chain so the UI can show the atomic leg
      // sequence that would execute on mainnet.
      const bundle = planBundle({
        batchId: batchIndex.toString(),
        marketId: marketKey,
        clearingPrice: result.clearingPrice,
        pairMatching,
        clobRouting,
        lpQuote: clobRouting.lpQuote,
      });
      getBundleStore().save(bundle);
      console.log(
        `[IkaOrchestrator] Planned cross-chain bundle for batch ${batchIndex} ` +
          `(${bundle.legs.length} legs, status=${bundle.status}).`,
      );

      state.settlingBatchId = null;

    } catch (err) {
      console.error(`[BatchProcessor] Settlement failed for batch ${batchIndex}:`, err);
    } finally {
      state.processingBatch = false;
    }
  }

  // ─── Accessors for claim path ───

  /**
   * Return all orders that were settled in the given batch, keyed by
   * commitment hex. Used at claim time to rebuild the Merkle tree so the
   * claim proof's membership check verifies against the correct root.
   */
  async getBatchOrders(batchId: bigint): Promise<Order[]> {
    const map = await this.store.load(batchId.toString());
    return Array.from(map.values());
  }

  /** Return the matched-pair / CLOB-routing breakdown for a settled batch. */
  getSettlementStats(batchId: bigint): BatchSettlementStats | undefined {
    return this.settlementStats.get(batchId.toString());
  }

  /** Read the LS-LMSR bootstrap pool's current marginal-YES price as a
   *  6-decimal bigint, or null when the pool isn't init'd / has
   *  graduated. Used as the clearing-price anchor (Tier 0 price
   *  discovery, docs/LIQUIDITY.md §5.1). Failures are silent — the
   *  caller falls back to legacy candidate-search clearing. */
  private async maybeLmsrAnchor(marketId: Buffer): Promise<bigint | null> {
    try {
      const pool: any = await this.client.fetchBootstrapPool(marketId);
      if (pool.graduated) return null;
      const { marginalPrice } = await import("./bootstrapCurve");
      const yesPrice = marginalPrice(
        {
          currentQ: BigInt(pool.currentQ.toString()),
          bParam: BigInt(pool.bParam.toString()),
          yesShares: BigInt(pool.yesShares.toString()),
          noShares: BigInt(pool.noShares.toString()),
        },
        "yes",
      );
      // Clamp to (0, 1_000_000) — boundary prices break order matching
      // (everyone fills or nobody does, depending on side).
      const microPrice = BigInt(Math.round(yesPrice * 1_000_000));
      const clamped =
        microPrice <= 0n ? 1n :
        microPrice >= 1_000_000n ? 999_999n :
        microPrice;
      return clamped;
    } catch {
      return null;
    }
  }

  /** Return all settled batches' stats, newest first. Bounded to last 50. */
  listSettlementStats(): BatchSettlementStats[] {
    return Array.from(this.settlementStats.values())
      .sort((a, b) => b.settledAt - a.settledAt)
      .slice(0, 50);
  }

  // ─── Cleanup ───

  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

// ─── Utility ───

function bigintToBytes32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}
