import { Keypair, Connection, clusterApiUrl } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

export interface Config {
  solanaRpcUrl: string;
  solanaWssUrl?: string;
  relayerKeypair: Keypair;
  programId: string;
  idlPath: string;
  circuitsPath: string;
  port: number;
  useRealZk: boolean;
  // RPC Fast integration (optional — graceful fallback if unset)
  rpcFastApiKey?: string;
  rpcFastHttpUrl: string;
  rpcFastWssUrl: string;
  rpcFastYellowstoneUrl: string;
  rpcFastEnabled: boolean;
  // gRPC streaming is only available on Stream/Aperture plans.
  // Hackathon plan uses WebSocket subscriptions instead.
  rpcFastGrpcEnabled: boolean;
}

export function loadConfig(): Config {
  // RPC Fast integration. If RPC_FAST_API_KEY is set, use their HTTP + WSS
  // endpoints as primary. The specific URLs differ for devnet vs mainnet —
  // the user should configure RPC_FAST_HTTP_URL + RPC_FAST_WSS_URL to match
  // their app's network.
  //
  // Devnet (Hackathon plan):
  //   RPC_FAST_HTTP_URL=https://sol-devnet-rpc.rpcfast.com
  //   RPC_FAST_WSS_URL=wss://sol-devnet-rpc.rpcfast.com
  //
  // Mainnet:
  //   RPC_FAST_HTTP_URL=https://solana-rpc.rpcfast.com/
  //   RPC_FAST_WSS_URL=wss://solana-rpc.rpcfast.com/
  const rpcFastApiKey = process.env.RPC_FAST_API_KEY || undefined;
  const rpcFastHttpUrl = process.env.RPC_FAST_HTTP_URL || "https://sol-devnet-rpc.rpcfast.com";
  const rpcFastWssUrl = process.env.RPC_FAST_WSS_URL || "wss://sol-devnet-rpc.rpcfast.com";
  const rpcFastYellowstoneUrl = process.env.RPC_FAST_YELLOWSTONE_URL || "https://solana-yellowstone-grpc.rpcfast.com:443";
  const rpcFastEnabled = !!rpcFastApiKey;
  // gRPC requires Stream plan ($249/mo) or higher. Opt-in only.
  const rpcFastGrpcEnabled = rpcFastEnabled && process.env.RPC_FAST_GRPC_ENABLED === "true";

  // Primary RPC: RPC Fast if configured, else SOLANA_RPC_URL, else localhost
  const rpcUrl = rpcFastEnabled
    ? rpcFastHttpUrl
    : (process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899");
  const wssUrl = rpcFastEnabled
    ? rpcFastWssUrl
    : (process.env.SOLANA_WSS_URL || undefined);
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
    solanaWssUrl: wssUrl,
    relayerKeypair,
    programId,
    idlPath,
    circuitsPath,
    port,
    useRealZk,
    rpcFastApiKey,
    rpcFastHttpUrl,
    rpcFastWssUrl,
    rpcFastYellowstoneUrl,
    rpcFastEnabled,
    rpcFastGrpcEnabled,
  };
}
