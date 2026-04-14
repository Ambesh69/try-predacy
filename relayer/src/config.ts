import { Keypair, Connection, clusterApiUrl } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

export interface Config {
  solanaRpcUrl: string;
  relayerKeypair: Keypair;
  programId: string;
  idlPath: string;
  circuitsPath: string;
  port: number;
  useRealZk: boolean;
}

export function loadConfig(): Config {
  const rpcUrl = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const port = parseInt(process.env.PORT || "3001");
  const useRealZk = process.env.USE_REAL_ZK === "true";

  // Load relayer keypair — supports JSON env var (Railway) or file path (local)
  let relayerKeypair: Keypair;
  if (process.env.RELAYER_KEYPAIR_JSON) {
    const keypairData = JSON.parse(process.env.RELAYER_KEYPAIR_JSON);
    relayerKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  } else {
    const keypairPath = process.env.RELAYER_KEYPAIR_PATH || path.join(
      process.env.HOME || "~", ".config/solana/id.json"
    );
    try {
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      relayerKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    } catch {
      console.warn("No keypair found, generating ephemeral keypair");
      relayerKeypair = Keypair.generate();
    }
  }

  // Load program ID from IDL — check local copy first (Railway), then project root (local dev)
  const projectRoot = path.resolve(__dirname, "../..");
  const localIdl = path.join(__dirname, "../predacy-idl.json");
  const rootIdl = path.join(projectRoot, "target/idl/predacy.json");
  const idlPath = fs.existsSync(localIdl) ? localIdl : rootIdl;
  let programId = process.env.PROGRAM_ID || "";
  if (!programId) {
    try {
      const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
      programId = idl.address || idl.metadata?.address || "";
    } catch {
      programId = "Bb3zRkLip445BQ1S44PC115aws8CCyag4KFkch9ZcKjp";
    }
  }

  const circuitsPath = path.join(projectRoot, "circuits");

  return {
    solanaRpcUrl: rpcUrl,
    relayerKeypair,
    programId,
    idlPath,
    circuitsPath,
    port,
    useRealZk,
  };
}
