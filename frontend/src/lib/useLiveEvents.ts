/**
 * useLiveEvents — subscribes to the relayer's SSE event stream for live
 * on-chain events (commit_order, settle_batch, claim_processed).
 *
 * When RPC Fast gRPC streaming is active on the relayer, events arrive in
 * <1s via Yellowstone subscription. When not active, the stream stays open
 * but emits no events — callers should keep their existing polling as a
 * fallback.
 */

"use client";

import { useEffect, useRef, useState } from "react";

const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3001";

export type LiveEvent =
  | { kind: "commitOrder"; signature: string; slot: number; timestamp: number }
  | { kind: "settleBatch"; signature: string; slot: number; timestamp: number }
  | { kind: "claimProcessed"; signature: string; slot: number; timestamp: number }
  | { kind: "raw"; signature: string; slot: number; timestamp: number };

export interface LiveEventsState {
  /** true if the relayer has gRPC streaming actually active (RPC_FAST_API_KEY set) */
  streaming: boolean;
  /** true if the EventSource is currently connected */
  connected: boolean;
  /** the most recent event received, or null */
  lastEvent: LiveEvent | null;
  /** subscribe to a specific event kind; returns unsubscribe fn */
  subscribe: (
    kind: LiveEvent["kind"] | "*",
    handler: (e: LiveEvent) => void,
  ) => () => void;
}

export function useLiveEvents(): LiveEventsState {
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const handlersRef = useRef<Map<string, Set<(e: LiveEvent) => void>>>(new Map());

  useEffect(() => {
    const es = new EventSource(`${RELAYER_URL}/stream`);

    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => setConnected(false));

    es.addEventListener("ready", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        setStreaming(!!data.grpcStreaming);
      } catch { /* ignore malformed */ }
    });

    es.addEventListener("message", (ev: MessageEvent) => {
      try {
        const event = JSON.parse(ev.data) as LiveEvent;
        setLastEvent(event);
        // Fan out to kind-specific and wildcard subscribers
        const kindHandlers = handlersRef.current.get(event.kind);
        const allHandlers = handlersRef.current.get("*");
        kindHandlers?.forEach((h) => h(event));
        allHandlers?.forEach((h) => h(event));
      } catch { /* ignore malformed */ }
    });

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  const subscribe = (
    kind: LiveEvent["kind"] | "*",
    handler: (e: LiveEvent) => void,
  ): (() => void) => {
    const map = handlersRef.current;
    if (!map.has(kind)) map.set(kind, new Set());
    map.get(kind)!.add(handler);
    return () => {
      map.get(kind)?.delete(handler);
    };
  };

  return { streaming, connected, lastEvent, subscribe };
}
