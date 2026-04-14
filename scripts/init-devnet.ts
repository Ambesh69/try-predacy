/**
 * Initialize Predacy on devnet:
 * 1. Create mock USDC mint
 * 2. Initialize protocol
 * 3. Create a demo market
 *
 * Run: npx ts-node --project tests/tsconfig.json scripts/init-devnet.ts
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
const relayer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")))
);

const idlPath = path.join(__dirname, "../target/idl/predacy.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
const programId = new PublicKey(idl.address);

const wallet = new anchor.Wallet(relayer);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const PROTOCOL_SEED = Buffer.from("protocol");
const MARKET_SEED = Buffer.from("market");
const YES_MINT_SEED = Buffer.from("yes_mint");
const NO_MINT_SEED = Buffer.from("no_mint");
const USDC_VAULT_SEED = Buffer.from("usdc_vault");
const YES_VAULT_SEED = Buffer.from("yes_vault");
const NO_VAULT_SEED = Buffer.from("no_vault");

function findPda(seeds: (Buffer | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function main() {
  console.log("═══════════════════════════════════════");
  console.log(" Predacy Devnet Initialization");
  console.log("═══════════════════════════════════════\n");
  console.log(`Program ID: ${programId.toBase58()}`);
  console.log(`Authority:  ${relayer.publicKey.toBase58()}`);
  console.log(`Balance:    ${await connection.getBalance(relayer.publicKey) / 1e9} SOL\n`);

  // 1. Create mock USDC
  console.log("1. Creating mock USDC mint...");
  const usdcMint = await createMint(
    connection, relayer, relayer.publicKey, null, 6
  );
  console.log(`   Mock USDC: ${usdcMint.toBase58()}\n`);

  // 2. Initialize protocol
  console.log("2. Initializing protocol...");
  const [protocolConfig] = findPda([PROTOCOL_SEED]);
  try {
    await program.methods
      .initializeProtocol()
      .accounts({
        protocolConfig,
        authority: relayer.publicKey,
        usdcMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("   ✓ Protocol initialized\n");
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("   Already initialized\n");
    } else throw e;
  }

  // 3. Create demo market
  console.log("3. Creating demo market...");
  const marketId = Buffer.alloc(32);
  Buffer.from("predacy-demo-v1").copy(marketId);

  const [market] = findPda([MARKET_SEED, marketId]);
  const [yesMint] = findPda([YES_MINT_SEED, marketId]);
  const [noMint] = findPda([NO_MINT_SEED, marketId]);
  const [usdcVault] = findPda([USDC_VAULT_SEED, marketId]);
  const [yesVault] = findPda([YES_VAULT_SEED, marketId]);
  const [noVault] = findPda([NO_VAULT_SEED, marketId]);

  try {
    await program.methods
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
        authority: relayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("   ✓ Demo market created\n");
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("   Already exists\n");
    } else throw e;
  }

  // Summary
  console.log("═══════════════════════════════════════");
  console.log(" ✓ DEVNET INITIALIZATION COMPLETE");
  console.log("═══════════════════════════════════════\n");
  console.log("Save these for frontend/.env.local:\n");
  console.log(`NEXT_PUBLIC_PROGRAM_ID=${programId.toBase58()}`);
  console.log(`NEXT_PUBLIC_SOLANA_RPC_URL=${RPC_URL}`);
  console.log(`NEXT_PUBLIC_USDC_MINT=${usdcMint.toBase58()}`);
  console.log(`NEXT_PUBLIC_MARKET_ID=${marketId.toString("hex")}`);
  console.log(`\nMarket PDA:  ${market.toBase58()}`);
  console.log(`YES Mint:    ${yesMint.toBase58()}`);
  console.log(`NO Mint:     ${noMint.toBase58()}`);
  console.log(`USDC Vault:  ${usdcVault.toBase58()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error("FAILED:", err); process.exit(1); });
