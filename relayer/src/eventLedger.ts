/**
 * Event ledger — relayer's authoritative client-side state for the
 * Liquidity Stack (docs/LIQUIDITY.md). Tracks each active EventHandle's
 * graduation state, cumulative volume across batches, and which markets
 * fall under it.
 *
 * Why client-side?  The on-chain `EventHandle` has the immutable params
 * (fee bps, graduation threshold, closes_at). The ledger here is the
 * mutable counterpart that tracks transient counters between batches —
 * cumulative graduation-window volume, list of markets, last batch
 * settlement time. The relayer reads this to decide:
 *
 *   pre-graduation (Tier 0 LMSR fills residual)
 *     ↕ — flips when ≥`graduationBatches` consecutive batches
 *         clear ≥`graduationThresholdUsdc` volume
 *   post-graduation (Tier 1 LP vault absorbs residual)
 *
 * On restart, the ledger reconstructs from on-chain state + pulling the
 * recent batch settlement events from gRPC streamer. Persistence is
 * write-through to a JSON file for v1; backed by Postgres in v2.
 */

import * as path from "path";
import * as fs from "fs";
import { PublicKey } from "@solana/web3.js";

export type EventCategory = "LiveStream" | "Sports" | "Crypto" | "Politics" | "Custom";

export interface EventHandleEntry {
  /** 32-byte handle ID, hex-encoded for the ledger file. */
  handleId: string;
  /** Original human-readable label that was hashed to produce handleId.
   *  Off-chain only — not stored on-chain (handleId is canonical there).
   *  Optional because pre-label entries from older deploys may lack it. */
  label?: string;
  category: EventCategory;
  /** On-chain EventHandle PDA. */
  eventHandlePda: string;
  /** Whoever can mutate (relayer in v1). */
  authority: string;
  closesAt: number;          // unix seconds
  /** Per-EventHandle config (mirrors the on-chain account). */
  graduationThresholdUsdc: bigint;
  graduationBatches: number;
  feeBpsTaker: number;
  feeBpsTreasury: number;
  feeBpsRebates: number;
  bootstrapSeedUsdc: bigint;
  /** Mutable graduation state. */
  graduated: boolean;
  /** Tracks the last `graduationBatches` batches' volumes for the
   *  graduation gate. Index 0 = oldest, push to end. */
  recentBatchVolumes: bigint[];
  /** Cumulative volume across all batches under this event. */
  cumulativeVolumeUsdc: bigint;
  /** Markets created under this event. */
  marketIds: string[];
  /** Optional human-readable label per attached market, keyed by marketId hex.
   *  Set by `POST /events/:id/markets` when a label is provided. */
  marketLabels?: Record<string, string>;
  /** Final resolution per market once SettlementEngine has called
   *  resolve_market on-chain. "YES" / "NO" matches the on-chain
   *  Market.outcome (1 = YES, 2 = NO). Used by the UI to render
   *  resolved badges + the redeem button without fetching every
   *  Market account on every event-detail page load. */
  resolutions?: Record<string, "YES" | "NO">;
  /** When this event was first registered (ledger-side). */
  registeredAt: number;
  closed: boolean;
}

export interface EventLedgerSnapshot {
  events: EventHandleEntry[];
  lastSavedAt: number;
}

// Persistence path resolution:
//   1. explicit constructor arg (test override)
//   2. LEDGER_PATH env (Railway volume — survives redeploys)
//   3. fallback next to compiled relayer (dev convenience; ephemeral on Railway)
const FALLBACK_LEDGER_PATH = path.join(__dirname, "..", "event-ledger.json");

export class EventLedger {
  private events: Map<string, EventHandleEntry> = new Map();
  private storePath: string;

  constructor(storePath?: string) {
    this.storePath = storePath
      || process.env.LEDGER_PATH
      || FALLBACK_LEDGER_PATH;
    // Railway volumes mount at the configured path but the parent dir may
    // not exist on first run. Create it before any writes happen so persist()
    // doesn't crash on a fresh volume.
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error("[EventLedger] Could not ensure storage dir:", err);
    }
    console.log(`[EventLedger] Using store at ${this.storePath}`);
    this.loadFromDisk();
  }

  /** Register a newly-created event. Idempotent on handle_id. If the entry
   *  already exists, optionally backfills the label (everything else is
   *  preserved) — lets operators rename or attach a label after the fact
   *  without losing graduation/volume state. */
  register(entry: Omit<EventHandleEntry, "graduated" | "recentBatchVolumes" | "cumulativeVolumeUsdc" | "marketIds" | "registeredAt" | "closed">): EventHandleEntry {
    const existing = this.events.get(entry.handleId);
    if (existing) {
      if (entry.label && existing.label !== entry.label) {
        existing.label = entry.label;
        this.persist();
      }
      return existing;
    }
    const full: EventHandleEntry = {
      ...entry,
      graduated: false,
      recentBatchVolumes: [],
      cumulativeVolumeUsdc: 0n,
      marketIds: [],
      registeredAt: Math.floor(Date.now() / 1000),
      closed: false,
    };
    this.events.set(entry.handleId, full);
    this.persist();
    return full;
  }

  get(handleId: string): EventHandleEntry | undefined {
    return this.events.get(handleId);
  }

  list(): EventHandleEntry[] {
    return Array.from(this.events.values());
  }

  /** Bind a market to an event. Called at create_market time. Optional
   *  `label` lets the operator (or stream-monitor agent) attach a human
   *  description that the UI surfaces on the market card. */
  attachMarket(handleId: string, marketIdHex: string, label?: string): void {
    const ev = this.events.get(handleId);
    if (!ev) throw new Error(`EventLedger: unknown handle ${handleId}`);
    if (!ev.marketIds.includes(marketIdHex)) ev.marketIds.push(marketIdHex);
    if (label) {
      ev.marketLabels = { ...(ev.marketLabels ?? {}), [marketIdHex]: label };
    }
    this.persist();
  }

  /** Clear all market bindings for an event. Used when the operator wants
   *  to swap the market set under an existing event (e.g., demo reset)
   *  without losing the EventHandle's graduation/volume history. */
  detachAllMarkets(handleId: string): void {
    const ev = this.events.get(handleId);
    if (!ev) throw new Error(`EventLedger: unknown handle ${handleId}`);
    ev.marketIds = [];
    ev.marketLabels = {};
    this.persist();
  }

  /** Record a market's final resolution. Called by SettlementEngine
   *  immediately after resolve_market lands on-chain. The /events
   *  endpoint surfaces this so the UI can render "RESOLVED · YES/NO"
   *  badges + the redeem button without re-fetching every Market
   *  account every render. Idempotent — second call with the same
   *  outcome is a no-op; with a different outcome warns and ignores
   *  (the on-chain account is the source of truth, but we shouldn't
   *  see this case unless someone resolved manually via CLI). */
  setMarketResolution(handleId: string, marketIdHex: string, outcome: "YES" | "NO"): void {
    const ev = this.events.get(handleId);
    if (!ev) throw new Error(`EventLedger: unknown handle ${handleId}`);
    const key = marketIdHex.toLowerCase().replace(/^0x/, "");
    const prior = ev.resolutions?.[key];
    if (prior === outcome) return;
    if (prior && prior !== outcome) {
      console.warn(
        `[EventLedger] Resolution conflict for ${key.slice(0, 8)}…: prior=${prior} new=${outcome} — keeping new (on-chain wins)`,
      );
    }
    ev.resolutions = { ...(ev.resolutions ?? {}), [key]: outcome };
    this.persist();
  }

  /** Drop a specific list of marketIds from an event. The on-chain
   *  market accounts stay rent-funded (Solana accounts can't be cheaply
   *  closed, and dangling fills against them remain valid) — this only
   *  removes the off-chain binding so the UI stops surfacing those
   *  markets under this event card. Used by the replace-lineup refresh
   *  mode to drop ghost-player markets when a session's player set
   *  turns over but the EventHandle is preserved. */
  detachMarkets(handleId: string, marketIdsToDrop: string[]): { dropped: number } {
    const ev = this.events.get(handleId);
    if (!ev) throw new Error(`EventLedger: unknown handle ${handleId}`);
    const drop = new Set(marketIdsToDrop.map((m) => m.toLowerCase()));
    let dropped = 0;
    ev.marketIds = ev.marketIds.filter((m) => {
      if (drop.has(m.toLowerCase())) { dropped++; return false; }
      return true;
    });
    if (ev.marketLabels) {
      const remaining: Record<string, string> = {};
      for (const [mid, lbl] of Object.entries(ev.marketLabels)) {
        if (!drop.has(mid.toLowerCase())) remaining[mid] = lbl;
      }
      ev.marketLabels = remaining;
    }
    this.persist();
    return { dropped };
  }

  /** Drop an event from the off-chain ledger. The on-chain EventHandle
   *  PDA is unaffected — it stays rent-funded and could be re-registered
   *  later via register() (idempotent on handleId). Use to nuke stale
   *  demo data. */
  remove(handleId: string): boolean {
    if (!this.events.has(handleId)) return false;
    this.events.delete(handleId);
    this.persist();
    return true;
  }

  /**
   * Find the event handle a given market belongs to. Linear scan — fine
   * for v1 with O(few hundred) events; index by marketId in v2 if needed.
   */
  findEventForMarket(marketIdHex: string): EventHandleEntry | undefined {
    for (const ev of this.events.values()) {
      if (ev.marketIds.includes(marketIdHex)) return ev;
    }
    return undefined;
  }

  /**
   * Record a batch's settled volume against its parent event. Returns the
   * (possibly updated) graduation state. Called at settle_batch time.
   *
   * Graduation rule: the last `graduationBatches` batches must each have
   * at least `graduationThresholdUsdc / graduationBatches` volume. Once
   * graduated, stays graduated for the rest of the event lifetime.
   */
  recordBatchVolume(marketIdHex: string, volumeUsdc: bigint): {
    event: EventHandleEntry;
    graduatedNow: boolean;
  } {
    const ev = this.findEventForMarket(marketIdHex);
    if (!ev) {
      throw new Error(`EventLedger: no event for market ${marketIdHex}`);
    }
    ev.cumulativeVolumeUsdc += volumeUsdc;

    // Only track recent volumes pre-graduation; post-graduation it's a no-op.
    if (!ev.graduated) {
      ev.recentBatchVolumes.push(volumeUsdc);
      while (ev.recentBatchVolumes.length > ev.graduationBatches) {
        ev.recentBatchVolumes.shift();
      }

      const minPerBatch = ev.graduationThresholdUsdc / BigInt(ev.graduationBatches || 1);
      const allMet = ev.recentBatchVolumes.length >= ev.graduationBatches
        && ev.recentBatchVolumes.every((v) => v >= minPerBatch);
      if (allMet) {
        ev.graduated = true;
      }
    }

    const graduatedNow = ev.graduated && ev.recentBatchVolumes.length === ev.graduationBatches;
    this.persist();
    return { event: ev, graduatedNow };
  }

  setGraduated(handleId: string, graduated: boolean): void {
    const ev = this.events.get(handleId);
    if (!ev) throw new Error(`EventLedger: unknown handle ${handleId}`);
    ev.graduated = graduated;
    this.persist();
  }

  markClosed(handleId: string): void {
    const ev = this.events.get(handleId);
    if (!ev) throw new Error(`EventLedger: unknown handle ${handleId}`);
    ev.closed = true;
    this.persist();
  }

  /** Reopen a previously-closed event + optionally extend its closesAt
   *  to a future timestamp. Used by /admin/events/:handle/reopen when
   *  operator wants to undo a manual close, or when a session's window
   *  expired but the event should remain visible / tradeable. */
  markOpen(handleId: string, newClosesAt?: number): void {
    const ev = this.events.get(handleId);
    if (!ev) throw new Error(`EventLedger: unknown handle ${handleId}`);
    ev.closed = false;
    if (newClosesAt !== undefined) ev.closesAt = newClosesAt;
    this.persist();
  }

  /** Rename the human-readable label of an event. Off-chain only — the
   *  on-chain handleId stays canonical. Useful when an auto-generated
   *  session label (e.g. "TRITON-SESSION-2026-05-04-…") needs a cleaner
   *  display name. */
  setLabel(handleId: string, newLabel: string): void {
    const ev = this.events.get(handleId);
    if (!ev) throw new Error(`EventLedger: unknown handle ${handleId}`);
    ev.label = newLabel;
    this.persist();
  }

  /** ── Persistence ── */

  private persist(): void {
    try {
      const snap: EventLedgerSnapshot = {
        events: Array.from(this.events.values()),
        lastSavedAt: Math.floor(Date.now() / 1000),
      };
      fs.writeFileSync(this.storePath, JSON.stringify(snap, replacer, 2));
    } catch (err) {
      console.error("[EventLedger] Persist failed:", err);
    }
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.storePath)) return;
    try {
      const raw = fs.readFileSync(this.storePath, "utf-8");
      const snap = JSON.parse(raw, reviver) as EventLedgerSnapshot;
      for (const ev of snap.events) this.events.set(ev.handleId, ev);
      console.log(`[EventLedger] Loaded ${snap.events.length} events from ${this.storePath}`);
    } catch (err) {
      console.error("[EventLedger] Load failed:", err);
    }
  }
}

// JSON serialisation must round-trip BigInt — the ledger has many.
function replacer(_k: string, v: any): any {
  if (typeof v === "bigint") return { __bigint: v.toString() };
  return v;
}
function reviver(_k: string, v: any): any {
  if (v && typeof v === "object" && "__bigint" in v) return BigInt(v.__bigint);
  return v;
}

let instance: EventLedger | null = null;
export function getEventLedger(): EventLedger {
  if (!instance) instance = new EventLedger();
  return instance;
}

/** Helper to derive a deterministic 32-byte handle_id from a label. */
export function deriveHandleId(label: string): Buffer {
  // Use SHA256 (built-in to Node) — keeps it deterministic + collision-safe.
  // Same algorithm + label used by the frontend before signing creates same id.
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(label).digest();
}

/** Key the ledger uses (hex-encoded handle_id). */
export function handleIdToHex(handleId: Buffer | Uint8Array): string {
  return Buffer.from(handleId).toString("hex");
}

/** Derive a PublicKey for the EventHandle PDA — caller passes program id. */
export function eventHandlePda(handleId: Buffer, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("event"), handleId],
    programId,
  );
  return pda;
}
