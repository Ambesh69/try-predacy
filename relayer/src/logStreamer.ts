/**
 * WebSocket log subscription for Predacy program events.
 *
 * Uses Solana's standard `onLogs` subscription over WebSocket — works with
 * any RPC provider that supports WSS (RPC Fast, Helius, Triton, even public
 * RPC). No Yellowstone gRPC required.
 *
 * This is the WSS-friendly path for entry-tier RPC plans. On RPC Fast's
 * Stream/Aperture tier, the gRPC streamer (grpcStreamer.ts) is enabled for
 * sub-ms latency instead. Both paths emit the same event shape to consumers.
 *
 * Predacy instruction discriminators (from the IDL) are used to classify
 * the events we care about: commit_order, commit_sell_order, settle_batch,
 * claim_with_proof.
 */

import { EventEmitter } from "events";
import { Connection, PublicKey, Logs } from "@solana/web3.js";
import { Config } from "./config";

export type StreamEvent =
  | { kind: "commitOrder"; signature: string; slot: number; timestamp: number }
  | { kind: "commitSellOrder"; signature: string; slot: number; timestamp: number }
  | { kind: "settleBatch"; signature: string; slot: number; timestamp: number }
  | { kind: "claimProcessed"; signature: string; slot: number; timestamp: number }
  | { kind: "raw"; signature: string; slot: number; timestamp: number; logs: string[] };

/**
 * Parse Solana logs to determine which Predacy instruction ran. We look for
 * the Anchor program log pattern: `Program log: Instruction: <Name>`.
 * This is simpler than matching instruction discriminator bytes and works
 * reliably because Anchor emits these logs by default.
 */
function classifyLogs(logs: string[]): StreamEvent["kind"] {
  for (const log of logs) {
    if (log.includes("Instruction: CommitOrder")) return "commitOrder";
    if (log.includes("Instruction: CommitSellOrder")) return "commitSellOrder";
    if (log.includes("Instruction: SettleBatch")) return "settleBatch";
    if (log.includes("Instruction: ClaimWithProof")) return "claimProcessed";
  }
  return "raw";
}

export class LogStreamer extends EventEmitter {
  private connection: Connection;
  private config: Config;
  private subscriptionId: number | null = null;

  constructor(connection: Connection, config: Config) {
    super();
    this.connection = connection;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.subscriptionId !== null) return;
    try {
      const programId = new PublicKey(this.config.programId);
      this.subscriptionId = this.connection.onLogs(
        programId,
        (logs: Logs, ctx: { slot: number }) => this.handleLogs(logs, ctx),
        "confirmed",
      );
      const provider = this.config.rpcFastEnabled ? "RPC Fast" : "standard RPC";
      console.log(`[logStreamer] Subscribed to program ${this.config.programId} via ${provider} WSS`);
    } catch (err: any) {
      console.error("[logStreamer] Failed to subscribe:", err.message);
    }
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch { /* noop */ }
      this.subscriptionId = null;
    }
  }

  private handleLogs(logs: Logs, ctx: { slot: number }): void {
    if (logs.err) return; // skip failed txs
    const kind = classifyLogs(logs.logs);
    const base = {
      signature: logs.signature,
      slot: ctx.slot,
      timestamp: Date.now(),
    };
    const event: StreamEvent =
      kind === "raw"
        ? { kind, ...base, logs: logs.logs }
        : { kind, ...base };
    this.emit("event", event);
  }
}

let instance: LogStreamer | null = null;

export function getLogStreamer(connection: Connection, config: Config): LogStreamer {
  if (!instance) instance = new LogStreamer(connection, config);
  return instance;
}
