import { SolanaClient } from "./solanaClient";
import { InMemoryOrderStore, OrderStore } from "./orderStore";
import { computeClearingPrice } from "./clearingPrice";
import {
  computeCommitment,
  computeCommitmentRoot,
  generateBatchProof,
  generateMockProof,
} from "./zkProver";
import { buildMerkleTree } from "./zkClaimProver";
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

export class BatchProcessor {
  private client: SolanaClient;
  private store: OrderStore;
  private markets: Map<string, MarketState> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private circuitsPath: string;
  private useRealZk: boolean;

  constructor(
    client: SolanaClient,
    circuitsPath: string,
    useRealZk: boolean,
    store?: OrderStore,
  ) {
    this.client = client;
    this.circuitsPath = circuitsPath;
    this.useRealZk = useRealZk;
    this.store = store || new InMemoryOrderStore();
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

      // 2. Compute clearing price
      const result = computeClearingPrice(orderList);
      console.log(`[BatchProcessor] Clearing price: ${result.clearingPrice} (${result.filledOrders.length} filled, ${result.unfilledOrders.length} unfilled)`);

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

      // 9. Phase 2: settleBatch
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
      );

      console.log(`[BatchProcessor] Batch ${batchIndex} settled successfully`);
      state.settlingBatchId = null;

    } catch (err) {
      console.error(`[BatchProcessor] Settlement failed for batch ${batchIndex}:`, err);
    } finally {
      state.processingBatch = false;
    }
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
