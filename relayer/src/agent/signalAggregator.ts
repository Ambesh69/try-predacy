/**
 * Signal Aggregator — cross-confirmation gate for settlement-relevant
 * agent observations.
 *
 * Why this exists:
 *   The settlement engine fires irreversible on-chain `resolve_market`
 *   txs. A single false-positive OCR frame ("QUADS" misread, ghost
 *   "BUSTED" overlay, winner attribution to the wrong nameplate) would
 *   resolve a real market with real money on the wrong outcome — and
 *   there is no rollback. So we never settle on a single signal.
 *
 *   Per docs/ARCHITECTURE.md and the agent design memo, the rule is:
 *   "lock an event with high confidence only when ≥2 independent
 *   signals report it within ±10s. Single-signal events held pending;
 *   expire if not confirmed within 60s."
 *
 * What counts as an independent signal:
 *   - Vision OCR frames (each `frameId` is independent)
 *   - Audio (Whisper transcript event extraction)
 *   - Live chat sentiment (tripwire only)
 *   - Manual operator confirmation (admin endpoint)
 *
 * Confirmation rule (current implementation):
 *   ≥2 distinct vision frames within ±10s
 *     — OR —
 *   ≥1 vision frame + ≥1 non-vision source within ±10s
 *
 *   The second branch lets a single vision observation settle the
 *   moment audio/chat/manual cross-confirms. The first branch is the
 *   common path while audio is offline: a deterministic broadcast
 *   graphic stays on screen for 5-15s, so it observes across multiple
 *   GameState frames (5s cadence). Single-frame OCR flickers fail to
 *   reach 2 frames before the 10s window slides off.
 *
 * Expiry:
 *   Pending entries (observed once, never confirmed) are dropped 60s
 *   after first observation. Confirmed entries persist (with their
 *   `confirmedAt` stamp) so settlement is idempotent across snapshots.
 *
 * Persistence:
 *   In-memory only. The 60s expiry is short relative to relayer
 *   redeploys, and confirmation flips are eventually persisted in
 *   SessionStats / EventLedger anyway. A redeploy mid-window costs
 *   us at most one extra 10s of waiting for re-confirmation, which
 *   is fine.
 */

export type SignalSource = "vision" | "audio" | "chat" | "manual";

export interface SignalObservation {
  source: SignalSource;
  /** Unix-seconds when the signal was observed. */
  at: number;
  /** Stable identifier for the underlying frame / audio chunk / manual
   *  event. Used to dedupe observations of the same event from the same
   *  source. For vision, use the GameState frame's capturedAt as a
   *  string. */
  signalId?: string;
}

export interface AggregateState {
  key: string;
  observations: SignalObservation[];
  /** Unix-seconds when this key first satisfied the confirmation rule.
   *  null while still pending. */
  confirmedAt: number | null;
  /** Unix-seconds when the first observation arrived. Used for expiry. */
  firstSeenAt: number;
}

export interface AggregatorConfig {
  /** Window during which observations cluster as "this event". Default 10s. */
  windowSec: number;
  /** Time after first observation that pending (unconfirmed) entries are
   *  evicted. Default 60s. */
  expirySec: number;
}

const DEFAULT_CONFIG: AggregatorConfig = {
  windowSec: 10,
  expirySec: 60,
};

export class SignalAggregator {
  private state: Map<string, AggregateState> = new Map();
  readonly config: AggregatorConfig;

  constructor(config: Partial<AggregatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record a single observation of `key` from `source`. Returns true
   *  if `key` is now (or was already) confirmed. The caller should only
   *  fire downstream side-effects (settlement tx, ledger writes) when
   *  this returns true and `wasConfirmed(key)` was false beforehand. */
  observe(
    key: string,
    source: SignalSource,
    at: number,
    signalId?: string,
  ): boolean {
    let st = this.state.get(key);
    if (!st) {
      st = { key, observations: [], confirmedAt: null, firstSeenAt: at };
      this.state.set(key, st);
    }

    // Already confirmed — record the observation for completeness but
    // don't recompute. Idempotent for repeat snapshots.
    if (st.confirmedAt !== null) {
      st.observations.push({ source, at, signalId });
      return true;
    }

    // Dedupe: same source + same signalId is a single observation.
    if (signalId) {
      const dup = st.observations.find(
        (o) => o.source === source && o.signalId === signalId,
      );
      if (dup) return false;
    }

    // Slide the rolling window: drop observations older than `windowSec`
    // before deciding confirmation. Keeps the buffer bounded and lets
    // a stale single observation expire naturally rather than confirming
    // on a much later co-incident frame.
    const cutoff = at - this.config.windowSec;
    st.observations = st.observations.filter((o) => o.at >= cutoff);
    st.observations.push({ source, at, signalId });

    if (this.evaluate(st)) {
      st.confirmedAt = at;
      return true;
    }
    return false;
  }

  /** Pure check — does this key currently satisfy the confirmation
   *  rule? Same logic as `observe` but without recording a new
   *  observation. Used by SettlementEngine before firing on-chain. */
  isConfirmed(key: string): boolean {
    const st = this.state.get(key);
    return st?.confirmedAt !== null;
  }

  /** Convenience for the common pattern: "I'm about to fire settlement
   *  for event K — has it been cross-confirmed yet?" Returns the
   *  AggregateState (with full observation list, useful for logging the
   *  reason) if confirmed, otherwise null. */
  confirmation(key: string): AggregateState | null {
    const st = this.state.get(key);
    if (!st || st.confirmedAt === null) return null;
    return st;
  }

  /** Drop pending (unconfirmed) entries older than `expirySec`. Confirmed
   *  entries are kept indefinitely so repeated settlement attempts remain
   *  idempotent. Caller should run this periodically. Returns the keys
   *  that were dropped. */
  prune(now: number): string[] {
    const dropped: string[] = [];
    for (const [key, st] of this.state.entries()) {
      if (st.confirmedAt !== null) continue;
      if (now - st.firstSeenAt > this.config.expirySec) {
        this.state.delete(key);
        dropped.push(key);
      }
    }
    return dropped;
  }

  /** Snapshot of the aggregator state. Used by the debug endpoint and
   *  by the live-standings UI to show "X events pending confirmation". */
  snapshot(): { confirmed: AggregateState[]; pending: AggregateState[] } {
    const confirmed: AggregateState[] = [];
    const pending: AggregateState[] = [];
    for (const st of this.state.values()) {
      if (st.confirmedAt !== null) confirmed.push(st);
      else pending.push(st);
    }
    return { confirmed, pending };
  }

  /** Test/admin hook — clear all state. */
  reset(): void {
    this.state.clear();
  }

  /** Confirmation rule. Exported as a method so subclasses or future
   *  variants (e.g., a "high-stakes" aggregator that requires 3 sources)
   *  can override. */
  protected evaluate(st: AggregateState): boolean {
    // Distinct vision frames count as independent signals.
    const visionFrames = new Set<string>();
    const otherSources = new Set<SignalSource>();
    for (const o of st.observations) {
      if (o.source === "vision") {
        visionFrames.add(o.signalId ?? `${o.at}`);
      } else {
        otherSources.add(o.source);
      }
    }
    if (visionFrames.size >= 2) return true;
    if (visionFrames.size >= 1 && otherSources.size >= 1) return true;
    return false;
  }
}

// ─── Canonical key constructors ──────────────────────────────────────
//
// Key format is `<event-kind>:<param>` so the same event observed
// across multiple snapshots maps to the same aggregator slot. Players
// are normalised via the same `canon()` helper used in settlementEngine
// to handle OCR shortform / casing variation.

const canon = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");

export const SignalKeys = {
  /** Session-level: any-hand strength callout. */
  quads: (handleHex: string) => `quads:${handleHex}`,
  royal: (handleHex: string) => `royal:${handleHex}`,
  /** Whale-pot threshold tripped. The threshold is part of the key so
   *  $250K and $500K confirmations are tracked independently. */
  whalePot: (handleHex: string, thresholdUsd: number) =>
    `whale-pot:${handleHex}:>=${thresholdUsd}`,
  /** All-in count threshold tripped. */
  allInThreshold: (handleHex: string, threshold: number) =>
    `all-ins:${handleHex}:>=${threshold}`,
  /** First bust attribution — "this player busted first". */
  firstBust: (handleHex: string, player: string) =>
    `first-bust:${handleHex}:${canon(player)}`,
  /** Hand-level winner attribution. */
  handWinner: (handleHex: string, handIdx: number, player: string) =>
    `hand-winner:${handleHex}:${handIdx}:${canon(player)}`,
  /** Early-bust window tripped. The minutes are part of the key. */
  earlyBust: (handleHex: string, minutes: number) =>
    `early-bust:${handleHex}:${minutes}m`,
};

let instance: SignalAggregator | null = null;
export function getSignalAggregator(): SignalAggregator {
  if (!instance) instance = new SignalAggregator();
  return instance;
}
