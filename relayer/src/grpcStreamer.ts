/**
 * RPC Fast Yellowstone gRPC integration.
 *
 * Subscribes to Predacy program transactions in real time and emits events
 * for batch settlement, order commitments, and claims. Replaces the need
 * for frontend polling of /batch-status.
 *
 * Activates only when RPC_FAST_API_KEY is set. Falls back to a no-op streamer
 * when the API key is absent — existing polling-based flow continues to work.
 *
 * Docs: https://docs.rpcfast.com/rpc-fast-saas-solana/data-streaming
 */

import { EventEmitter } from "events";
import { Config } from "./config";

// Event names emitted by the streamer. Consumers (HTTP SSE, batch processor,
// etc) subscribe to these to react to on-chain state changes.
export type GrpcEvent =
  | { kind: "commitOrder"; signature: string; slot: number; timestamp: number }
  | { kind: "settleBatch"; signature: string; slot: number; timestamp: number }
  | { kind: "claimProcessed"; signature: string; slot: number; timestamp: number }
  | { kind: "raw"; signature: string; slot: number; timestamp: number };

export class GrpcStreamer extends EventEmitter {
  private config: Config;
  private client: any = null;
  private stream: any = null;
  private running = false;
  private reconnectAttempts = 0;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  get enabled(): boolean {
    // gRPC uses its own key — a separate RPC Fast app from the HTTP RPC.
    return this.config.rpcFastGrpcEnabled && !!this.config.rpcFastGrpcApiKey;
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      console.log("[grpcStreamer] RPC_FAST_API_KEY not set — streaming disabled, falling back to polling");
      return;
    }
    if (this.running) return;
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.stream) {
      try {
        this.stream.end();
      } catch { /* noop */ }
      this.stream = null;
    }
  }

  private async connect(): Promise<void> {
    try {
      // Lazy import — only require the gRPC client when actually using it,
      // so the relayer starts fine without the dependency resolved for
      // users who don't have RPC Fast configured.
      const { default: Client, CommitmentLevel } = await import("@triton-one/yellowstone-grpc") as any;

      const channelOptions = {
        grpcHttp2KeepAliveInterval: 30_000,
        grpcKeepAliveTimeout: 10_000,
        grpcKeepAliveWhileIdle: true,
        grpcTcpKeepalive: 1,
      };

      this.client = new Client(
        this.config.rpcFastYellowstoneUrl,
        this.config.rpcFastGrpcApiKey!,
        channelOptions,
      );

      console.log(`[grpcStreamer] Connecting to ${this.config.rpcFastYellowstoneUrl}...`);
      this.stream = await this.client.subscribe();

      // Subscribe to all transactions that reference the Predacy program.
      // Yellowstone filters server-side, so we only receive relevant txs.
      const request = {
        transactions: {
          predacy: {
            vote: false,
            failed: false,
            accountInclude: [this.config.programId],
            accountExclude: [],
            accountRequired: [],
          },
        },
        slots: {},
        accounts: {},
        commitment: CommitmentLevel.CONFIRMED,
      };

      this.stream.on("data", (update: any) => this.handleUpdate(update));
      this.stream.on("error", (err: Error) => this.handleError(err));
      this.stream.on("end", () => this.handleEnd());

      await new Promise<void>((resolve, reject) => {
        this.stream.write(request, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      console.log(`[grpcStreamer] Subscribed to program ${this.config.programId}`);
      this.reconnectAttempts = 0;
    } catch (err: any) {
      console.error("[grpcStreamer] Connection failed:", err.message);
      this.scheduleReconnect();
    }
  }

  private handleUpdate(update: any): void {
    try {
      const txUpdate = update?.transaction;
      if (!txUpdate) return;

      const slot = Number(txUpdate.slot ?? 0);
      const sig = txUpdate.transaction?.transaction?.signatures?.[0];
      const signature = sig ? Buffer.from(sig).toString("base64") : "unknown";
      const timestamp = Date.now();

      // Inspect the tx for Predacy instruction discriminators so we can
      // classify the event. We emit a generic "raw" for anything else.
      //
      // TODO: parse the instruction data against our IDL to distinguish
      // commit_order / settle_batch / claim_with_proof. For now we emit
      // "raw" and let HTTP /events consumers correlate via polling.
      const event: GrpcEvent = { kind: "raw", signature, slot, timestamp };
      this.emit("event", event);
    } catch (err) {
      console.error("[grpcStreamer] Error processing update:", err);
    }
  }

  private handleError(err: Error): void {
    console.error("[grpcStreamer] Stream error:", err.message);
    this.scheduleReconnect();
  }

  private handleEnd(): void {
    console.warn("[grpcStreamer] Stream ended");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectAttempts += 1;
    // Exponential backoff, cap at 30s
    const delay = Math.min(30_000, 1_000 * Math.pow(2, this.reconnectAttempts));
    console.log(`[grpcStreamer] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    setTimeout(() => {
      if (this.running) this.connect();
    }, delay);
  }
}

// Singleton instance — created when relayer boots, connected when API key is set.
let instance: GrpcStreamer | null = null;

export function getStreamer(config: Config): GrpcStreamer {
  if (!instance) instance = new GrpcStreamer(config);
  return instance;
}
