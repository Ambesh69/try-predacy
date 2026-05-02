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
 * Implementation note (2026-04-26):
 * We tried `@triton-one/yellowstone-grpc` (the official client). Its napi-rs
 * Rust binding fails to connect to RPC Fast's Yellowstone endpoint with a
 * generic "failed to connect to gRPC endpoint" — likely because tonic's
 * default TLS/HTTP2 settings don't match what RPC Fast's edge expects.
 * Pure-JS `@grpc/grpc-js` connects fine against the same URL+token, so we
 * load `geyser.proto` ourselves and call `Subscribe` directly.
 *
 * Docs: https://docs.rpcfast.com/solana-dedicated-nodes/yellowstone-grpc
 */

import { EventEmitter } from "events";
import * as path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { Config } from "./config";

// CommitmentLevel values map directly to the geyser.proto enum. Hardcoded
// here so we don't have to import from the napi-only @triton-one package.
enum CommitmentLevel {
  PROCESSED = 0,
  CONFIRMED = 1,
  FINALIZED = 2,
}

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
  // Set true once the *first* Subscribe round-trip completes. Distinguishes
  // "endpoint genuinely unreachable" (auth, allowlist, wrong URL) from
  // transient drops on a previously-healthy stream — only the former should
  // hit the give-up path.
  private everConnected = false;
  // Dedupe flag: gRPC fires both `error` and `end` on a dropped stream, often
  // in the same tick. Without this, each drop double-counts the attempt
  // counter and schedules two parallel reconnects (fan-out grows
  // exponentially). Cleared after the backoff timer fires.
  private reconnectScheduled = false;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  get enabled(): boolean {
    // gRPC uses its own key — a separate RPC Fast app from the HTTP RPC.
    return this.config.rpcFastGrpcEnabled && !!this.config.rpcFastGrpcApiKey;
  }

  /** True only when the napi client + subscribe-stream are both live. Useful
   *  for /health to distinguish "config says on, TLS handshake actually works". */
  get connected(): boolean {
    return this.running && !!this.client && !!this.stream;
  }

  get reconnects(): number {
    return this.reconnectAttempts;
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
    this.cleanupConnection();
  }

  /** Tear down the current stream + client. Called on every disconnect
   *  (before scheduling a reconnect) and on stop(). Removing listeners
   *  before cancel() ensures the cancel-induced final `end` doesn't
   *  re-trigger handleEnd on the stale connection. */
  private cleanupConnection(): void {
    if (this.stream) {
      try { this.stream.removeAllListeners(); } catch { /* noop */ }
      try { this.stream.cancel(); } catch { /* noop */ }
      this.stream = null;
    }
    if (this.client) {
      try { this.client.close(); } catch { /* noop */ }
      this.client = null;
    }
  }

  private async connect(): Promise<void> {
    // Defensive: if a previous stream/client lingered (e.g., connect() was
    // re-entered without going through scheduleReconnect), drop it now so
    // we never have two parallel subscriptions racing.
    this.cleanupConnection();
    try {
      // Locate geyser.proto next to the compiled relayer (we copy the .proto
      // files into /app/proto/ at Docker build time). __dirname resolves to
      // /app/dist when compiled, so ../proto = /app/proto.
      const protoPath = path.resolve(__dirname, "..", "proto", "geyser.proto");
      const includeDirs = [path.resolve(__dirname, "..", "proto")];
      const packageDef = protoLoader.loadSync(protoPath, {
        keepCase: false,
        longs: Number,      // slots/timestamps as JS numbers
        enums: Number,
        defaults: true,
        oneofs: true,
        includeDirs,
      });
      const geyser: any = grpc.loadPackageDefinition(packageDef).geyser;

      // Auth: send the API key as `x-token` metadata on every call. Combine
      // with TLS channel creds so the metadata generator runs per-RPC.
      const apiKey = this.config.rpcFastGrpcApiKey!;
      const callCreds = grpc.credentials.createFromMetadataGenerator((_, cb) => {
        const meta = new grpc.Metadata();
        meta.add("x-token", apiKey);
        cb(null, meta);
      });
      const channelCreds = grpc.credentials.combineChannelCredentials(
        grpc.credentials.createSsl(),
        callCreds,
      );

      const url = this.config.rpcFastYellowstoneUrl;
      console.log(`[grpcStreamer] Connecting to ${url}... (pure-JS @grpc/grpc-js)`);
      this.client = new geyser.Geyser(url, channelCreds, {
        "grpc.keepalive_time_ms": 30_000,
        "grpc.keepalive_timeout_ms": 10_000,
        "grpc.keepalive_permit_without_calls": 1,
      });

      // waitForReady so we know the channel is up before opening Subscribe.
      await new Promise<void>((resolve, reject) => {
        const deadline = new Date();
        deadline.setSeconds(deadline.getSeconds() + 10);
        this.client.waitForReady(deadline, (err: Error | null) => {
          if (err) reject(err); else resolve();
        });
      });

      // Subscribe is bidi-streaming. The first message we write is the
      // SubscribeRequest filter; subsequent server messages are SubscribeUpdate.
      this.stream = this.client.subscribe();

      const request = {
        accounts: {},
        slots: {},
        transactions: {
          predacy: {
            vote: false,
            failed: false,
            accountInclude: [this.config.programId],
            accountExclude: [],
            accountRequired: [],
          },
        },
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        commitment: CommitmentLevel.CONFIRMED,
      };

      this.stream.on("data", (update: any) => this.handleUpdate(update));
      this.stream.on("error", (err: Error) => this.handleError(err));
      this.stream.on("end", () => this.handleEnd());

      await new Promise<void>((resolve, reject) => {
        this.stream.write(request, (err: Error | null) => {
          if (err) reject(err); else resolve();
        });
      });

      console.log(`[grpcStreamer] Subscribed to program ${this.config.programId}`);
      this.reconnectAttempts = 0;
      this.everConnected = true;
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
    // Dedupe: gRPC normally fires `error` then `end` on a dropped stream.
    // Both call this method; the second call is a no-op.
    if (this.reconnectScheduled) return;
    this.reconnectScheduled = true;

    // Drop the dead client/stream now so /health (grpcConnected) reflects
    // reality and we don't leak the underlying HTTP/2 channel.
    this.cleanupConnection();

    this.reconnectAttempts += 1;
    // Circuit-breaker scope: only for the *initial* connect path. If we
    // never managed to subscribe once, the endpoint is misconfigured (auth,
    // allowlist, wrong URL) and reconnect spam pollutes logs without value.
    // Once we've successfully subscribed, every drop is treated as
    // transient (idle timeout, edge restart) and we keep retrying — that's
    // the entire point of having a streamer.
    if (!this.everConnected && this.reconnectAttempts > 5) {
      console.warn("[grpcStreamer] Giving up after 5 failed initial connects — gRPC endpoint unreachable, falling back to WSS log streamer (primary path)");
      this.running = false;
      this.reconnectScheduled = false;
      return;
    }
    // Exponential backoff. Cap at 60s for transient drops on a previously
    // healthy stream so we resume quickly; 30s for initial failures since
    // we're going to give up after 5 anyway.
    const cap = this.everConnected ? 60_000 : 30_000;
    const delay = Math.min(cap, 1_000 * Math.pow(2, this.reconnectAttempts));
    console.log(`[grpcStreamer] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    setTimeout(() => {
      this.reconnectScheduled = false;
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
