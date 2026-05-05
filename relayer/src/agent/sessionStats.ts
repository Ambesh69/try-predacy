/**
 * Session Stats — running per-player counters, populated from a
 * stream of GameState snapshots. This is the substrate the settlement
 * engine reads to decide which markets settle YES vs NO.
 *
 * The stats track:
 *   - bluffsByPlayer: bluff events attributed (cross-confirmed; details
 *     filled in by the audio/transcript pipeline once that lands)
 *   - biggestPotByPlayer: max pot won per player
 *   - bustsByPlayer: timestamp of bust per player
 *   - handsWonByPlayer: number of hands won
 *   - maxPotSoFar: overall session high-water-mark pot
 *   - quadsHit, royalFlushHit: any-hand-of-this-strength flag for
 *     session generic markets
 *   - allInsCount: total all-ins observed
 *
 * State persists per-session (keyed by session label) to /data/agent-stats.json
 * so a relayer redeploy mid-session keeps history.
 *
 * Cross-confirmation note: this module DOES NOT decide what's a real
 * event — it just accumulates. The aggregator (called by streamMonitor)
 * cross-checks vision frames + audio + chat before calling
 * `recordEvent()`. Single-signal events should not call into this.
 */

import * as fs from "fs";
import * as path from "path";
import type { GameState } from "./gameStateExtractor";

export interface PerPlayerStats {
  /** Confirmed bluffs (set by aggregator after multi-signal confirmation). */
  bluffs: number;
  /** Largest pot this player has won this session, USD. 0 if none. */
  biggestPotWonUsd: number;
  /** Number of hands won this session. */
  handsWon: number;
  /** Unix-seconds when this player busted, or null if still active. */
  bustedAt: number | null;
  /** Total all-ins this player went on. */
  allInsBy: number;
}

export interface SessionStatsRecord {
  sessionLabel: string;
  /** Hex EventHandle id — convenience for cross-referencing. */
  handleIdHex: string;
  startedAt: number;
  /** Last GameState snapshot timestamp processed. */
  lastSnapshotAt: number;
  /** Number of valid frames processed (helps gauge data confidence). */
  framesProcessed: number;

  /** Per-player stats, keyed by lowercase name for dedupe. */
  players: Record<string, PerPlayerStats>;

  /** Session-level high-water marks. */
  maxPotSoFar: number;
  /** Player who won the current max-pot pot. null until first hand resolves. */
  maxPotWinnerName: string | null;

  /** Any-hand session flags — for the corresponding generic markets. */
  quadsHit: boolean;
  royalFlushHit: boolean;

  /** Aggregate counters. */
  allInsCount: number;
  bustsCount: number;
  /** Unix-seconds when the FIRST bust happened, or null if none yet.
   *  Used to settle "first player busts within 90 minutes?" market. */
  firstBustAt: number | null;

  /** Hand-state tracking — for hand-boundary detection. */
  currentBoardCardCount: number;
  /** Approximate hand count this session — increments when board count
   *  drops back to 0 after being >0 (i.e., new hand dealt after prior
   *  hand resolved). Also surfaced on the live stats panel. */
  handsSeen: number;
  /** Hand idx most recently observed entering the flop. Used by the
   *  hand-level real-time markets — each new hand gets fresh markets
   *  keyed by this idx. Starts at 0 (no hands seen yet). */
  currentHandIdx: number;
  /** Players whose markets are currently open for the in-progress hand.
   *  Set when the flop is observed; cleared the moment a winner is
   *  declared (and the hand-winner markets settle). Empty between hands. */
  currentHandPlayers: string[];
}

/** Side-effect description returned from recordSnapshot so the caller
 *  can react to hand-level transitions (seed new markets, settle
 *  resolved hands) without needing to diff state itself. */
export interface SnapshotResult {
  /** Fired when the OCR transitions from pre-flop (boardCardCount=0)
   *  to a flop (boardCardCount>=3) and we capture the in-hand players
   *  for the new hand. Marks the start of a new hand-level market
   *  trading window. */
  handStart?: {
    handIdx: number;
    /** Players we'll seed hand-winner markets for. Capped at 5 by
     *  the caller (handLevelMarketsFor) so a full table doesn't blow
     *  up the market count. */
    players: string[];
  };
  /** Fired when the snap declares winners (winnerPlayers non-empty)
   *  while there's an open hand. Marks the end of the trading window
   *  — caller should settle hand-winner markets for handIdx with
   *  winners=YES, others=NO. */
  handResolved?: {
    handIdx: number;
    winners: string[];
    /** All players the open-hand markets were seeded for, including
     *  losers — caller settles the whole batch at once. */
    players: string[];
  };
}

interface StatsStore {
  schemaVersion: 1;
  /** Keyed by session label. */
  sessions: Record<string, SessionStatsRecord>;
}

const DEFAULT_STATS_PATH = "/data/agent-stats.json";
const FALLBACK_STATS_PATH = path.join(__dirname, "..", "..", "agent-stats.json");

export class SessionStats {
  private storePath: string;
  private state: StatsStore;
  /** Track `tableView=true` window edge transitions and prior boardCardCount
   *  per session for hand-counter increments. */
  private lastBoardByLabel: Map<string, number> = new Map();
  /** Track which (label, handStrength) pairs we've already counted, so
   *  the same callout staying on screen for several frames doesn't double-
   *  flag quadsHit / royalFlushHit. */
  private seenStrengths: Map<string, Set<string>> = new Map();

  constructor(storePath?: string) {
    this.storePath = storePath
      || process.env.AGENT_STATS_PATH
      || (process.env.LEDGER_PATH ? DEFAULT_STATS_PATH : FALLBACK_STATS_PATH);
    this.state = this.load();
  }

  ensureSession(sessionLabel: string, handleIdHex: string): SessionStatsRecord {
    let s = this.state.sessions[sessionLabel];
    if (s) return s;
    s = {
      sessionLabel,
      handleIdHex,
      startedAt: Math.floor(Date.now() / 1000),
      lastSnapshotAt: 0,
      framesProcessed: 0,
      players: {},
      maxPotSoFar: 0,
      maxPotWinnerName: null,
      quadsHit: false,
      royalFlushHit: false,
      allInsCount: 0,
      bustsCount: 0,
      firstBustAt: null,
      currentBoardCardCount: 0,
      handsSeen: 0,
      currentHandIdx: 0,
      currentHandPlayers: [],
    };
    this.state.sessions[sessionLabel] = s;
    this.persist();
    return s;
  }

  get(sessionLabel: string): SessionStatsRecord | undefined {
    return this.state.sessions[sessionLabel];
  }

  /** Process one GameState snapshot for a session. Updates counters and
   *  flags. Idempotent in the sense that re-processing the same frame
   *  doesn't double-count anything (we use seenStrengths and board-edge
   *  detection to avoid duplicate increments). */
  recordSnapshot(sessionLabel: string, handleIdHex: string, snap: GameState): SnapshotResult {
    if (!snap.tableView) return {}; // ignore intermissions / sponsor reels
    const s = this.ensureSession(sessionLabel, handleIdHex);
    s.lastSnapshotAt = snap.capturedAt;
    s.framesProcessed += 1;
    const result: SnapshotResult = {};

    // ─── Pot tracking ───────────────────────────────────────────────
    if (snap.potUsd !== null && snap.potUsd > s.maxPotSoFar) {
      s.maxPotSoFar = snap.potUsd;
      // We update maxPotWinnerName when a winner is announced, not when
      // the pot grows. Winner attribution is more reliable than guessing
      // from pot-growth sequences.
    }

    // ─── Hand strength flags (any-hand session markets) ─────────────
    const strengthsForSession = this.seenStrengths.get(sessionLabel) ?? new Set<string>();
    for (const hs of snap.handStrengths) {
      if (strengthsForSession.has(hs)) continue;
      strengthsForSession.add(hs);
      if (hs === "QUADS") s.quadsHit = true;
      if (hs === "ROYAL FLUSH") s.royalFlushHit = true;
    }
    this.seenStrengths.set(sessionLabel, strengthsForSession);

    // ─── All-in counter ────────────────────────────────────────────
    // The all-in overlay typically stays up for 5-15s, so we'd double-
    // count if we naively incremented on every all-in frame. Use a
    // simple "edge" detector: only count when the prior frame for this
    // session was NOT all-in.
    const lastBoard = this.lastBoardByLabel.get(sessionLabel);
    const transitioningIntoAllIn = snap.allInActive && !this.allInActiveLastFrame(sessionLabel);
    if (transitioningIntoAllIn) {
      s.allInsCount += 1;
      // Attribute to in-hand players (heuristic — best we can do without
      // dedicated per-player overlays for who pushed). Audio confirmation
      // can refine this later.
      for (const name of snap.inHandPlayers) {
        const p = this.ensurePlayer(s, name);
        p.allInsBy += 1;
      }
    }
    this.lastAllInByLabel.set(sessionLabel, snap.allInActive);

    // ─── Winner / hands-won ─────────────────────────────────────────
    if (snap.winnerPlayers.length > 0) {
      for (const name of snap.winnerPlayers) {
        const p = this.ensurePlayer(s, name);
        p.handsWon += 1;
        // If the just-resolved pot is the new session high-water mark,
        // attribute it to this winner. Pot is committed at hand resolution.
        if (s.maxPotSoFar > 0 && p.biggestPotWonUsd < s.maxPotSoFar) {
          p.biggestPotWonUsd = s.maxPotSoFar;
          if (p.biggestPotWonUsd >= s.maxPotSoFar) {
            s.maxPotWinnerName = name;
          }
        }
      }
    }

    // ─── Busts ─────────────────────────────────────────────────────
    for (const name of snap.bustedPlayers) {
      const p = this.ensurePlayer(s, name);
      if (p.bustedAt !== null) continue; // already counted
      p.bustedAt = snap.capturedAt;
      s.bustsCount += 1;
      if (s.firstBustAt === null) s.firstBustAt = snap.capturedAt;
    }

    // ─── Hand-boundary detection (board count edge) ────────────────
    // When boardCardCount drops to 0 after being >0, that's the prior
    // hand wrapping. Increment handsSeen.
    if (lastBoard !== undefined && lastBoard > 0 && snap.boardCardCount === 0) {
      s.handsSeen += 1;
    }

    // ─── Hand-level market lifecycle ────────────────────────────────
    //
    // We use the FLOP transition (preflop=0 → flop>=3) to mark a new
    // hand starting because:
    //   1. inHandPlayers is most reliable at this moment — broadcast
    //      has just rendered nameplates for everyone in the pot
    //   2. Avoids double-firing on brief OCR jitter where boardCount
    //      flickers between 0 and 1
    //
    // The hand resolves the moment winnerPlayers is populated. We
    // emit the transition deltas in `result` so the streamMonitor can
    // seed/settle hand-winner markets without re-implementing this
    // edge detection.
    const becamePostflop = (lastBoard ?? 0) === 0 && snap.boardCardCount >= 3;
    if (becamePostflop && s.currentHandPlayers.length === 0) {
      s.currentHandIdx += 1;
      s.currentHandPlayers = snap.inHandPlayers.slice(0, 5);
      result.handStart = {
        handIdx: s.currentHandIdx,
        players: [...s.currentHandPlayers],
      };
    }
    if (snap.winnerPlayers.length > 0 && s.currentHandPlayers.length > 0) {
      result.handResolved = {
        handIdx: s.currentHandIdx,
        winners: [...snap.winnerPlayers],
        players: [...s.currentHandPlayers],
      };
      // Reset so the next flop transition picks up a fresh hand.
      s.currentHandPlayers = [];
    }

    this.lastBoardByLabel.set(sessionLabel, snap.boardCardCount);
    s.currentBoardCardCount = snap.boardCardCount;

    this.persist();
    return result;
  }

  /** Manual record path used by the audio/cross-confirm aggregator
   *  (will be wired in day-4b). Bumps a player's bluff count once a
   *  bluff has been confirmed across signals. Keeps the GameState-driven
   *  recordSnapshot() path purely vision-only. */
  recordConfirmedBluff(sessionLabel: string, handleIdHex: string, playerName: string): void {
    const s = this.ensureSession(sessionLabel, handleIdHex);
    const p = this.ensurePlayer(s, playerName);
    p.bluffs += 1;
    this.persist();
  }

  list(): SessionStatsRecord[] {
    return Object.values(this.state.sessions);
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private lastAllInByLabel: Map<string, boolean> = new Map();

  private allInActiveLastFrame(sessionLabel: string): boolean {
    return this.lastAllInByLabel.get(sessionLabel) ?? false;
  }

  private ensurePlayer(s: SessionStatsRecord, name: string): PerPlayerStats {
    const key = name.toLowerCase();
    let p = s.players[key];
    if (!p) {
      p = { bluffs: 0, biggestPotWonUsd: 0, handsWon: 0, bustedAt: null, allInsBy: 0 };
      s.players[key] = p;
    }
    return p;
  }

  private load(): StatsStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<StatsStore>;
        if (parsed.schemaVersion === 1 && parsed.sessions) {
          return parsed as StatsStore;
        }
      }
    } catch (err) {
      console.warn("[SessionStats] Load failed:", err);
    }
    return { schemaVersion: 1, sessions: {} };
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error("[SessionStats] Persist failed:", err);
    }
  }
}

let instance: SessionStats | null = null;
export function getSessionStats(): SessionStats {
  if (!instance) instance = new SessionStats();
  return instance;
}
