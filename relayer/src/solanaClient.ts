import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import { Config } from "./config";

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
}
