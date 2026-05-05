import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Commitment,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionConfirmationStrategy,
  RpcResponseAndContext,
  SignatureResult,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import { Config } from "./config";

/**
 * Patch a Connection so confirmTransaction uses HTTP polling instead
 * of WSS signatureSubscribe. Solana RPC providers cap concurrent WSS
 * subscriptions at 50; under burst writes (e.g., 50+ markets seeded
 * back-to-back, each with multiple init txs) the default sub-based
 * confirmation path floods the JSON-RPC log with -32000 "Concurrent
 * websocket subscription limit reached" errors, and Railway then
 * starts dropping log lines under its rate limiter.
 *
 * getSignatureStatuses scales with normal RPC rate limits — far more
 * headroom than WSS sub slots. We poll at 500ms with a 60s overall
 * deadline (matches the original confirmTransaction expiry behavior).
 *
 * The patch preserves the original return shape so Anchor's
 * sendAndConfirm sees `{ value: { err } }` and behaves identically.
 */
function patchConnectionForHttpConfirmation(conn: Connection): void {
  const original = conn.confirmTransaction.bind(conn);
  (conn as any).confirmTransaction = async function patched(
    strategy: TransactionConfirmationStrategy | string,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    const sig = typeof strategy === "string" ? strategy : strategy?.signature;
    if (!sig) {
      // Unknown shape — defer to the native path. Should never happen
      // for our outbound writes (Anchor passes either a string or
      // BlockhashWithExpiryBlockHeight, both of which expose `signature`).
      return original(strategy as any, commitment);
    }
    return pollForSignatureStatus(conn, sig, commitment ?? "confirmed");
  };
}

async function pollForSignatureStatus(
  conn: Connection,
  signature: string,
  commitment: Commitment,
): Promise<RpcResponseAndContext<SignatureResult>> {
  const TIMEOUT_MS = 60_000;
  const POLL_INTERVAL_MS = 500;
  const reachedTarget = (cs?: string | null): boolean => {
    if (commitment === "finalized") return cs === "finalized";
    return cs === "confirmed" || cs === "finalized";
  };

  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const status = await conn.getSignatureStatuses([signature], {
        searchTransactionHistory: false,
      });
      const v = status.value?.[0] as
        | (SignatureResult & { confirmationStatus?: string | null })
        | null;
      if (v) {
        if (v.err) {
          return { context: status.context, value: { err: v.err } };
        }
        if (reachedTarget(v.confirmationStatus)) {
          return { context: status.context, value: { err: null } };
        }
      }
    } catch {
      // Transient RPC blip — fall through to sleep+retry.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  // Match the original error message shape so callers that key off
  // "was not confirmed" / "It is unknown if it succeeded" keep working.
  throw new Error(
    `Transaction was not confirmed in ${(TIMEOUT_MS / 1000).toFixed(2)} seconds. ` +
    `It is unknown if it succeeded or failed. Check signature ${signature} ` +
    `using the Solana Explorer or CLI tools.`,
  );
}

// PDA seed constants (must match Rust program)
const PROTOCOL_SEED = Buffer.from("protocol");
const MARKET_SEED = Buffer.from("market");
const BATCH_SEED = Buffer.from("batch");
const COMMITMENTS_SEED = Buffer.from("commitments");
const NULLIFIER_SEED = Buffer.from("nullifier");
const YES_MINT_SEED = Buffer.from("yes_mint");
const NO_MINT_SEED = Buffer.from("no_mint");
const USDC_VAULT_SEED = Buffer.from("usdc_vault");
const YES_VAULT_SEED = Buffer.from("yes_vault");
const NO_VAULT_SEED = Buffer.from("no_vault");
// Liquidity Stack PDAs (Sprint 1.1–1.4 — see docs/LIQUIDITY.md §5)
const EVENT_HANDLE_SEED = Buffer.from("event");
const BOOTSTRAP_POOL_SEED = Buffer.from("bootstrap");
const LP_VAULT_SEED = Buffer.from("lpvault");
const LP_POSITION_SEED = Buffer.from("lppos");
const MAKER_REBATE_POOL_SEED = Buffer.from("rebate");
const MAKER_CREDIT_SEED = Buffer.from("credit");

export class SolanaClient {
  connection: Connection;
  program: anchor.Program;
  relayer: Keypair;
  programId: PublicKey;

  constructor(config: Config) {
    // Pass X-Token auth header when using RPC Fast. Falls back to plain
    // connection for local/public RPC.
    // RPC Fast auth: the API key already lives in the URLs (config.ts'
    // appendApiKey adds it to both http + wss endpoints). The previous
    // version of this file double-appended `/?api_key=...` to wsEndpoint
    // which produced `wss://host?api_key=K/?api_key=K` and triggered 401
    // ws errors at handshake. The X-Token header was also a no-op since
    // RPC Fast keys come in via query string only — drop both.
    this.connection = new Connection(config.solanaRpcUrl, {
      commitment: "confirmed",
      wsEndpoint: config.solanaWssUrl,
    });
    // Re-route every confirmTransaction through HTTP polling so burst
    // .rpc() writes don't blow past the 50-concurrent WSS subscription
    // cap and flood logs with subscribe errors. wsEndpoint stays set —
    // logStreamer still uses onLogs, which is bounded to 1-2 subs.
    patchConnectionForHttpConfirmation(this.connection);
    this.relayer = config.relayerKeypair;
    this.programId = new PublicKey(config.programId);

    // Load IDL and create program
    const idl = JSON.parse(fs.readFileSync(config.idlPath, "utf-8"));
    const wallet = new anchor.Wallet(this.relayer);
    const provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    this.program = new anchor.Program(idl, provider);
  }

  // ─── PDA Derivation ───

  protocolConfigPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([PROTOCOL_SEED], this.programId);
  }

  marketPda(marketId: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [MARKET_SEED, marketId],
      this.programId
    );
  }

  batchPda(marketId: Buffer, batchIndex: bigint): [PublicKey, number] {
    const indexBuf = Buffer.alloc(8);
    indexBuf.writeBigUInt64LE(batchIndex);
    return PublicKey.findProgramAddressSync(
      [BATCH_SEED, marketId, indexBuf],
      this.programId
    );
  }

  commitmentStorePda(marketId: Buffer, batchIndex: bigint): [PublicKey, number] {
    const indexBuf = Buffer.alloc(8);
    indexBuf.writeBigUInt64LE(batchIndex);
    return PublicKey.findProgramAddressSync(
      [COMMITMENTS_SEED, marketId, indexBuf],
      this.programId
    );
  }

  nullifierPda(nullifierHash: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [NULLIFIER_SEED, nullifierHash],
      this.programId
    );
  }

  yesMintPda(marketId: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [YES_MINT_SEED, marketId],
      this.programId
    );
  }

  noMintPda(marketId: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [NO_MINT_SEED, marketId],
      this.programId
    );
  }

  usdcVaultPda(marketId: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [USDC_VAULT_SEED, marketId],
      this.programId
    );
  }

  yesVaultPda(marketId: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [YES_VAULT_SEED, marketId],
      this.programId
    );
  }

  noVaultPda(marketId: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [NO_VAULT_SEED, marketId],
      this.programId
    );
  }

  // ─── Liquidity Stack PDAs ───

  eventHandlePda(handleId: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [EVENT_HANDLE_SEED, handleId],
      this.programId,
    );
  }

  bootstrapPoolPda(marketId: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [BOOTSTRAP_POOL_SEED, marketId],
      this.programId,
    );
  }

  lpVaultPda(eventHandle: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [LP_VAULT_SEED, eventHandle.toBuffer()],
      this.programId,
    );
  }

  lpPositionPda(vault: PublicKey, depositor: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [LP_POSITION_SEED, vault.toBuffer(), depositor.toBuffer()],
      this.programId,
    );
  }

  makerRebatePoolPda(eventHandle: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [MAKER_REBATE_POOL_SEED, eventHandle.toBuffer()],
      this.programId,
    );
  }

  makerCreditPda(pool: PublicKey, maker: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [MAKER_CREDIT_SEED, pool.toBuffer(), maker.toBuffer()],
      this.programId,
    );
  }

  // ─── Instruction Helpers ───

  async createMarket(marketId: Buffer): Promise<string> {
    const [protocolConfig] = this.protocolConfigPda();
    const [market] = this.marketPda(marketId);
    const [yesMint] = this.yesMintPda(marketId);
    const [noMint] = this.noMintPda(marketId);
    const [usdcVault] = this.usdcVaultPda(marketId);
    const [yesVault] = this.yesVaultPda(marketId);
    const [noVault] = this.noVaultPda(marketId);

    // Get USDC mint from protocol config
    const config = await this.fetchProtocolConfig();
    const usdcMint = (config as any).usdcMint as PublicKey;

    const tx = await this.program.methods
      .createMarket(Array.from(marketId))
      .accounts({
        protocolConfig,
        market,
        yesMint,
        noMint,
        usdcVault,
        yesVault,
        noVault,
        usdcMint,
        authority: this.relayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`[createMarket] tx: ${tx}`);
    return tx;
  }

  async openBatch(marketId: Buffer): Promise<string> {
    const [protocolConfig] = this.protocolConfigPda();
    const [market] = this.marketPda(marketId);

    // Fetch current batch index from market account
    const marketAccount = await (this.program.account as any).market.fetch(market);
    const batchIndex = BigInt(marketAccount.currentBatchIndex.toString());

    const [batch] = this.batchPda(marketId, batchIndex);
    const [commitmentStore] = this.commitmentStorePda(marketId, batchIndex);

    const tx = await this.program.methods
      .openBatch()
      .accounts({
        protocolConfig,
        market,
        batch,
        commitmentStore,
        authority: this.relayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`[openBatch] batch ${batchIndex} tx: ${tx}`);
    return tx;
  }

  async closeBatch(marketId: Buffer, batchIndex: bigint): Promise<string> {
    const [protocolConfig] = this.protocolConfigPda();
    const [market] = this.marketPda(marketId);
    const [batch] = this.batchPda(marketId, batchIndex);

    const tx = await this.program.methods
      .closeBatch()
      .accounts({
        protocolConfig,
        market,
        batch,
        authority: this.relayer.publicKey,
      })
      .rpc();

    console.log(`[closeBatch] batch ${batchIndex} tx: ${tx}`);
    return tx;
  }

  async lockFunds(
    marketId: Buffer,
    batchIndex: bigint,
    clearingPrice: bigint,
    filledYesBuyVol: bigint,
    filledNoBuyVol: bigint,
    filledYesSellQty: bigint,
    filledNoSellQty: bigint,
    yesGap: bigint,
    noGap: bigint,
    finalExcessYes: bigint,
    finalExcessNo: bigint,
    relayerUsdcAta: PublicKey,
    relayerYesAta: PublicKey,
    relayerNoAta: PublicKey,
    // Poseidon commitment_root — must match the value the ZK batch circuit
    // uses as its public input, since settle_batch verifies the Groth16 proof
    // against it.
    commitmentRoot: number[],
  ): Promise<string> {
    const [market] = this.marketPda(marketId);
    const [batch] = this.batchPda(marketId, batchIndex);
    const [commitmentStore] = this.commitmentStorePda(marketId, batchIndex);
    const [usdcVault] = this.usdcVaultPda(marketId);
    const [yesVault] = this.yesVaultPda(marketId);
    const [noVault] = this.noVaultPda(marketId);
    const [yesMint] = this.yesMintPda(marketId);
    const [noMint] = this.noMintPda(marketId);

    const tx = await this.program.methods
      .lockFunds(
        new anchor.BN(clearingPrice.toString()),
        new anchor.BN(filledYesBuyVol.toString()),
        new anchor.BN(filledNoBuyVol.toString()),
        new anchor.BN(filledYesSellQty.toString()),
        new anchor.BN(filledNoSellQty.toString()),
        new anchor.BN(yesGap.toString()),
        new anchor.BN(noGap.toString()),
        new anchor.BN(finalExcessYes.toString()),
        new anchor.BN(finalExcessNo.toString()),
        commitmentRoot,
      )
      .accounts({
        market,
        batch,
        commitmentStore,
        usdcVault,
        yesVault,
        noVault,
        yesMint,
        noMint,
        relayerUsdc: relayerUsdcAta,
        relayerYes: relayerYesAta,
        relayerNo: relayerNoAta,
        relayer: this.relayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc();

    console.log(`[lockFunds] batch ${batchIndex} price=${clearingPrice} tx: ${tx}`);
    return tx;
  }

  async settleBatch(
    marketId: Buffer,
    batchIndex: bigint,
    claimMerkleRoot: number[],
    proofA: number[],
    proofB: number[],
    proofC: number[],
    relayerUsdcAta: PublicKey,
    relayerYesAta: PublicKey,
    relayerNoAta: PublicKey,
    orderCount: number,
  ): Promise<string> {
    const [market] = this.marketPda(marketId);
    const [batch] = this.batchPda(marketId, batchIndex);
    const [usdcVault] = this.usdcVaultPda(marketId);
    const [yesVault] = this.yesVaultPda(marketId);
    const [noVault] = this.noVaultPda(marketId);

    const tx = await this.program.methods
      .settleBatch(
        claimMerkleRoot,
        proofA,
        proofB,
        proofC,
        orderCount,
      )
      .accounts({
        market,
        batch,
        usdcVault,
        yesVault,
        noVault,
        relayerUsdc: relayerUsdcAta,
        relayerYes: relayerYesAta,
        relayerNo: relayerNoAta,
        relayer: this.relayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc();

    console.log(`[settleBatch] batch ${batchIndex} tx: ${tx}`);
    return tx;
  }

  async claimWithProof(
    marketId: Buffer,
    batchIndex: bigint,
    nullifierHash: number[],
    side: number,
    filledAmount: bigint,
    refundAmount: bigint,
    proofA: number[],
    proofB: number[],
    proofC: number[],
    recipientAccount: PublicKey,
    // Field-element-encoded recipient owner pubkey (BE 32 bytes, < BN254 scalar).
    // Must match the `recipient` public input used when generating the proof.
    recipientField: number[],
  ): Promise<string> {
    const [market] = this.marketPda(marketId);
    const [batch] = this.batchPda(marketId, batchIndex);
    const nullifierBuf = Buffer.from(nullifierHash);
    const [nullifier] = this.nullifierPda(nullifierBuf);
    const [usdcVault] = this.usdcVaultPda(marketId);
    const [yesVault] = this.yesVaultPda(marketId);
    const [noVault] = this.noVaultPda(marketId);

    const tx = await this.program.methods
      .claimWithProof(
        nullifierHash,
        side,
        new anchor.BN(filledAmount.toString()),
        new anchor.BN(refundAmount.toString()),
        proofA,
        proofB,
        proofC,
        recipientField,
      )
      .accounts({
        market,
        batch,
        nullifier,
        usdcVault,
        yesVault,
        noVault,
        recipientAccount,
        relayer: this.relayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc();

    console.log(`[claimWithProof] batch ${batchIndex} tx: ${tx}`);
    return tx;
  }

  /**
   * Resolve a market's final outcome (1 = YES wins, 2 = NO wins).
   * Operator-only. Sets market.resolved = true and the winning side
   * so users can call redeem_outcome to swap winning tokens 1:1 for
   * USDC. Idempotent at the program level — repeats throw
   * MarketAlreadyResolved.
   */
  async resolveMarket(marketId: Buffer, outcome: 1 | 2): Promise<string> {
    const [market] = this.marketPda(marketId);
    const tx = await this.program.methods
      .resolveMarket(outcome)
      .accounts({
        market,
        authority: this.relayer.publicKey,
      })
      .rpc();
    console.log(`[resolveMarket] ${marketId.toString("hex").slice(0, 8)}… outcome=${outcome === 1 ? "YES" : "NO"} tx: ${tx}`);
    return tx;
  }

  // ─── Account Fetchers ───

  async fetchBatch(marketId: Buffer, batchIndex: bigint) {
    const [batch] = this.batchPda(marketId, batchIndex);
    return (this.program.account as any).batch.fetch(batch);
  }

  async fetchMarket(marketId: Buffer) {
    const [market] = this.marketPda(marketId);
    return (this.program.account as any).market.fetch(market);
  }

  async fetchProtocolConfig() {
    const [config] = this.protocolConfigPda();
    return (this.program.account as any).protocolConfig.fetch(config);
  }

  getConnection() {
    return this.connection;
  }

  // ─── Liquidity Stack — Instruction Wrappers (docs/LIQUIDITY.md) ───

  /**
   * Create an EventHandle PDA — the unit of LP commitment that markets
   * inherit fee + graduation parameters from. Operator-only.
   */
  async createEventHandle(args: {
    handleId: Buffer;
    category: number;            // EventCategory: 0=LiveStream 1=Sports 2=Crypto 3=Politics 4=Custom
    closesAt: bigint;            // unix seconds
    graduationThresholdUsdc: bigint;
    graduationBatches: number;
    feeBpsTaker: number;         // 30
    feeBpsTreasury: number;      // 10
    feeBpsRebates: number;       // 20
    bootstrapSeedUsdc: bigint;   // 100_000_000n = $100
  }): Promise<string> {
    const [eventHandle] = this.eventHandlePda(args.handleId);
    const tx = await this.program.methods
      .createEventHandle(
        Array.from(args.handleId),
        args.category,
        new anchor.BN(args.closesAt.toString()),
        new anchor.BN(args.graduationThresholdUsdc.toString()),
        args.graduationBatches,
        args.feeBpsTaker,
        args.feeBpsTreasury,
        args.feeBpsRebates,
        new anchor.BN(args.bootstrapSeedUsdc.toString()),
      )
      .accounts({
        eventHandle,
        authority: this.relayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`[createEventHandle] tx: ${tx}`);
    return tx;
  }

  /**
   * Initialise a Tier 0 LMSR Bootstrap Pool for a market under an event.
   * Operator-only. Reads `bootstrap_seed_usdc` from the EventHandle.
   */
  async initBootstrapPool(marketId: Buffer, eventHandleKey: PublicKey): Promise<string> {
    const [market] = this.marketPda(marketId);
    const [bootstrapPool] = this.bootstrapPoolPda(marketId);
    const tx = await this.program.methods
      .initBootstrapPool()
      .accounts({
        market,
        eventHandle: eventHandleKey,
        bootstrapPool,
        authority: this.relayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`[initBootstrapPool] tx: ${tx}`);
    return tx;
  }

  /**
   * Relayer-attested fill against the Tier 0 curve. Updates curve state;
   * actual token settlement still flows through `lock_funds`.
   */
  async bootstrapFill(args: {
    marketId: Buffer;
    eventHandleKey: PublicKey;
    side: number;            // 0=YES_BUY 1=YES_SELL 2=NO_BUY 3=NO_SELL
    qtyShares: bigint;       // 6-decimal
    usdcPaid: bigint;        // 6-decimal
    isBuy: boolean;
  }): Promise<string> {
    const [bootstrapPool] = this.bootstrapPoolPda(args.marketId);
    const tx = await this.program.methods
      .bootstrapFill(
        args.side,
        new anchor.BN(args.qtyShares.toString()),
        new anchor.BN(args.usdcPaid.toString()),
        args.isBuy,
      )
      .accounts({
        eventHandle: args.eventHandleKey,
        bootstrapPool,
        authority: this.relayer.publicKey,
      })
      .rpc();
    console.log(`[bootstrapFill] tx: ${tx}`);
    return tx;
  }

  async setBootstrapGraduated(args: {
    marketId: Buffer;
    eventHandleKey: PublicKey;
    graduated: boolean;
  }): Promise<string> {
    const [bootstrapPool] = this.bootstrapPoolPda(args.marketId);
    const tx = await this.program.methods
      .setBootstrapGraduated(args.graduated)
      .accounts({
        eventHandle: args.eventHandleKey,
        bootstrapPool,
        authority: this.relayer.publicKey,
      })
      .rpc();
    console.log(`[setBootstrapGraduated] tx: ${tx}`);
    return tx;
  }

  /**
   * LP deposits USDC under an EventHandle, receiving virtual shares against
   * the per-event Tier 1 vault. User-facing — depositor signs, NOT relayer.
   *
   * `signer` is the LP keypair; for the demo we'd typically build the tx
   * server-side and have the user sign on the frontend.
   */
  async commitLpCapital(args: {
    eventHandleKey: PublicKey;
    depositor: PublicKey;
    depositorUsdc: PublicKey;
    vaultUsdc: PublicKey;
    amount: bigint;
    commitmentExpiresAt: bigint;
  }): Promise<Transaction> {
    const [vault] = this.lpVaultPda(args.eventHandleKey);
    const [position] = this.lpPositionPda(vault, args.depositor);
    const ix = await this.program.methods
      .commitLpCapital(
        new anchor.BN(args.amount.toString()),
        new anchor.BN(args.commitmentExpiresAt.toString()),
      )
      .accounts({
        eventHandle: args.eventHandleKey,
        vault,
        position,
        vaultUsdc: args.vaultUsdc,
        depositorUsdc: args.depositorUsdc,
        depositor: args.depositor,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = args.depositor;
    return tx;
  }

  /**
   * Tier 1 Blind LP deposit — encrypts deposit amount under Encrypt's
   * network key + persists the resulting ciphertext id in
   * LPPosition.fhe_shares_ct on-chain. The plaintext USDC transfer is
   * still public (it's an SPL transfer); what becomes private is the
   * per-LP encrypted balance representation that future FHE-share-math
   * ix will operate on.
   */
  async commitLpCapitalBlind(args: {
    eventHandleKey: PublicKey;
    depositor: PublicKey;
    depositorUsdc: PublicKey;
    vaultUsdc: PublicKey;
    amount: bigint;
    commitmentExpiresAt: bigint;
    fheCiphertextId: Buffer;  // 32 bytes — produced by blindLp.encryptDepositAmount
  }): Promise<Transaction> {
    if (args.fheCiphertextId.length !== 32) {
      throw new Error(`commitLpCapitalBlind: ciphertext id must be 32 bytes, got ${args.fheCiphertextId.length}`);
    }
    const [vault] = this.lpVaultPda(args.eventHandleKey);
    const [position] = this.lpPositionPda(vault, args.depositor);
    const ix = await this.program.methods
      .commitLpCapitalBlind(
        new anchor.BN(args.amount.toString()),
        new anchor.BN(args.commitmentExpiresAt.toString()),
        Array.from(args.fheCiphertextId),
      )
      .accounts({
        eventHandle: args.eventHandleKey,
        vault,
        position,
        vaultUsdc: args.vaultUsdc,
        depositorUsdc: args.depositorUsdc,
        depositor: args.depositor,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = args.depositor;
    return tx;
  }

  /**
   * Per-batch state mutation for Tier 1 vault. Operator-driven — called
   * once per settled batch under an event when the vault absorbed residual.
   */
  async lpSettleBatch(args: {
    eventHandleKey: PublicKey;
    deltaYesPosition: bigint;     // signed
    deltaNoPosition: bigint;
    rebateShareUsdc: bigint;
  }): Promise<string> {
    const [vault] = this.lpVaultPda(args.eventHandleKey);
    const tx = await this.program.methods
      .lpSettleBatch(
        new anchor.BN(args.deltaYesPosition.toString()),
        new anchor.BN(args.deltaNoPosition.toString()),
        new anchor.BN(args.rebateShareUsdc.toString()),
      )
      .accounts({
        eventHandle: args.eventHandleKey,
        vault,
        authority: this.relayer.publicKey,
      })
      .rpc();
    console.log(`[lpSettleBatch] tx: ${tx}`);
    return tx;
  }

  /**
   * LP withdraws position post-expiry. Anyone can crank, payout always
   * goes to the original depositor. Build tx for user/crank to sign.
   */
  async withdrawLpCapital(args: {
    eventHandleKey: PublicKey;
    depositor: PublicKey;
    depositorUsdc: PublicKey;
    vaultUsdc: PublicKey;
    cranker: PublicKey;
  }): Promise<Transaction> {
    const [vault] = this.lpVaultPda(args.eventHandleKey);
    const [position] = this.lpPositionPda(vault, args.depositor);
    const ix = await this.program.methods
      .withdrawLpCapital()
      .accounts({
        eventHandle: args.eventHandleKey,
        vault,
        position,
        vaultUsdc: args.vaultUsdc,
        depositorUsdc: args.depositorUsdc,
        cranker: args.cranker,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = args.cranker;
    return tx;
  }

  /**
   * Stand up the Tier 2 rebate pool for an EventHandle. Operator-only.
   */
  async initRebatePool(eventHandleKey: PublicKey): Promise<string> {
    const [rebatePool] = this.makerRebatePoolPda(eventHandleKey);
    const tx = await this.program.methods
      .initRebatePool()
      .accounts({
        eventHandle: eventHandleKey,
        rebatePool,
        authority: this.relayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`[initRebatePool] tx: ${tx}`);
    return tx;
  }

  /**
   * Credit a maker for absorbing taker volume in a settled batch.
   * Relayer-driven (event authority signed). Tops up an existing credit
   * or creates a fresh one.
   */
  async accrueMakerCredit(args: {
    eventHandleKey: PublicKey;
    maker: PublicKey;
    credit: bigint;
  }): Promise<string> {
    const [rebatePool] = this.makerRebatePoolPda(args.eventHandleKey);
    const [makerCredit] = this.makerCreditPda(rebatePool, args.maker);
    const tx = await this.program.methods
      .accrueMakerCredit(args.maker, new anchor.BN(args.credit.toString()))
      .accounts({
        eventHandle: args.eventHandleKey,
        rebatePool,
        makerCredit,
        authority: this.relayer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`[accrueMakerCredit] tx: ${tx}`);
    return tx;
  }

  async closeRebatePool(eventHandleKey: PublicKey): Promise<string> {
    const [rebatePool] = this.makerRebatePoolPda(eventHandleKey);
    const tx = await this.program.methods
      .closeRebatePool()
      .accounts({
        eventHandle: eventHandleKey,
        rebatePool,
        authority: this.relayer.publicKey,
      })
      .rpc();
    console.log(`[closeRebatePool] tx: ${tx}`);
    return tx;
  }

  /**
   * Maker claims their pro-rata share of the rebate pool. User-facing —
   * builds the tx for the maker to sign.
   */
  async claimMakerRebate(args: {
    eventHandleKey: PublicKey;
    maker: PublicKey;
    makerUsdc: PublicKey;
    poolUsdc: PublicKey;
  }): Promise<Transaction> {
    const [rebatePool] = this.makerRebatePoolPda(args.eventHandleKey);
    const [makerCredit] = this.makerCreditPda(rebatePool, args.maker);
    const ix = await this.program.methods
      .claimMakerRebate()
      .accounts({
        eventHandle: args.eventHandleKey,
        rebatePool,
        makerCredit,
        poolUsdc: args.poolUsdc,
        makerUsdc: args.makerUsdc,
        maker: args.maker,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = args.maker;
    return tx;
  }

  // ─── Liquidity Stack — Account Fetchers ───

  async fetchEventHandle(handleId: Buffer) {
    const [pda] = this.eventHandlePda(handleId);
    return (this.program.account as any).eventHandle.fetch(pda);
  }

  async fetchBootstrapPool(marketId: Buffer) {
    const [pda] = this.bootstrapPoolPda(marketId);
    return (this.program.account as any).bootstrapPool.fetch(pda);
  }

  async fetchLpVault(eventHandleKey: PublicKey) {
    const [pda] = this.lpVaultPda(eventHandleKey);
    return (this.program.account as any).lPVault.fetch(pda);
  }

  async fetchLpPosition(vault: PublicKey, depositor: PublicKey) {
    const [pda] = this.lpPositionPda(vault, depositor);
    return (this.program.account as any).lPPosition.fetch(pda);
  }

  async fetchMakerRebatePool(eventHandleKey: PublicKey) {
    const [pda] = this.makerRebatePoolPda(eventHandleKey);
    return (this.program.account as any).makerRebatePool.fetch(pda);
  }

  async fetchMakerCredit(pool: PublicKey, maker: PublicKey) {
    const [pda] = this.makerCreditPda(pool, maker);
    return (this.program.account as any).makerCredit.fetch(pda);
  }
}
