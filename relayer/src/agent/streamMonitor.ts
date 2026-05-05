/**
 * Stream Monitor — discovers live poker broadcasts and drives the
 * EventHandle lifecycle, keying *sessions by lineup* rather than by
 * YouTube videoId.
 *
 * Why lineup-keyed?
 *   Triton and HCL run continuous-stream channels. A single videoId
 *   can carry multiple distinct cash games over hours/days (one ends,
 *   players swap out, a new game starts on the same broadcast). And
 *   a single game can span multiple videoIds if the producer restarts
 *   the stream. The thing we actually care about — for LP commitment,
 *   for market settlement — is "the set of players currently at the
 *   table." That's the session.
 *
 * So a session is identified by `hash(channel + date + lineup)`. The
 * monitor:
 *   1. Polls YouTube every 60s for live videos on each watched channel.
 *   2. For each live video, extracts the table lineup via GPT-4o vision.
 *   3. Looks up the session by lineup hash:
 *        - already active → just update bookkeeping (lastSeenAt)
 *        - new lineup     → start session: create EventHandle, seed
 *                           generic + player-aware markets
 *   4. Re-OCRs the active session every 10 min to detect:
 *        - mid-session entrants  → seed their per-player markets
 *        - full lineup turnover  → end prior session (settle later),
 *                                  start a new one
 *   5. Grace-periods went-offline videos for 5 min before declaring a
 *      session ended (in case the stream is just briefly dropped).
 *
 * Cost guard: lineup OCR is only called when a videoId is first seen,
 * or every 10 min on an active session — not every poll. Roughly $0.08
 * per channel per 4hr session at GPT-4o vision pricing.
 */

import * as fs from "fs";
import * as path from "path";
import { EventLedger, EventCategory } from "../eventLedger";
import {
  LineupExtractor,
  Lineup,
  Player,
  lineupHash,
} from "./lineupExtractor";
import {
  genericMarketsFor,
  playerMarketsFor,
  newEntrantMarketsFor,
  ChannelTag,
  SeededMarket,
} from "./marketTemplates";
import { GameStateExtractor } from "./gameStateExtractor";
import { SessionStats } from "./sessionStats";

const POLL_INTERVAL_MS = 60_000;
const LINEUP_RECHECK_MS = 10 * 60 * 1000;   // re-OCR active session every 10 min
const OFFLINE_GRACE_MS = 5 * 60 * 1000;     // tolerate 5 min of "video gone" before ending session
const GAME_STATE_INTERVAL_MS = 5_000;       // game-state snapshots while session active
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

export interface MonitoredChannel {
  tag: ChannelTag;
  channelId: string;
  name: string;
}

export const DEFAULT_CHANNELS: MonitoredChannel[] = [
  { tag: "TRITON", channelId: "UCpcv404DxfhGYhXgyB9Aoeg", name: "Triton Poker" },
  { tag: "HCL",    channelId: "UCQe7wB0o_cZgv1miyYB9TMA", name: "Hustler Casino Live" },
];

interface ActiveSession {
  sessionLabel: string;
  channelTag: ChannelTag;
  channelId: string;
  channelName: string;
  videoId: string;
  videoTitle: string;
  handleIdHex: string;
  lineup: Player[];
  lineupHash: string;
  startedAt: number;
  lastSeenAt: number;
  lastLineupCheckAt: number;
}

interface SessionStore {
  schemaVersion: 2;
  /** Keyed by handleIdHex — the on-chain EventHandle id, immutable for
   *  the lifetime of a session. Lineup hash mutates as new entrants are
   *  added; keying by it caused the per-session game-state loop to bail
   *  silently every time the lineup grew, leaving stats frozen. The
   *  "same lineup on different videoId" lookup that used to hit
   *  active[hash] now scans values for sessions whose CURRENT
   *  lineupHash matches (see findActiveByLineupHash). */
  active: Record<string, ActiveSession>;
  lastPollAt: number;
}

const DEFAULT_SESSION_STORE = "/data/agent-sessions.json";
const FALLBACK_SESSION_STORE = path.join(__dirname, "..", "..", "agent-sessions.json");

export interface CreateEventArgs {
  label: string;
  category: EventCategory;
  closesAt: number;
}

export interface CreateEventResult {
  handleIdHex: string;
  eventHandlePda: string;
}

export class StreamMonitor {
  private apiKey: string;
  private ledger: EventLedger;
  private extractor: LineupExtractor;
  /** Vision OCR for per-frame game state (pot, hand strengths, busts,
   *  winners). Runs at 5s cadence per active session. */
  private gameState: GameStateExtractor;
  /** Per-session running counters populated from gameState snapshots. */
  private stats: SessionStats;
  private createEvent: (args: CreateEventArgs) => Promise<CreateEventResult>;
  private seedMarket: (eventHandleHex: string, marketIdHex: string, label: string) => Promise<void>;
  private channels: MonitoredChannel[];
  private storePath: string;
  private state: SessionStore;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Per-active-session game-state polling loops, keyed by lineup hash.
   *  Started when a session is created, stopped when it ends. */
  private gameStateTimers: Map<string, NodeJS.Timeout> = new Map();
  /** When the YouTube API returns 403 (quota exhausted), back off
   *  globally until this timestamp. Quota typically resets at midnight
   *  PT, but we don't know the exact reset time, so we sleep an hour
   *  and retry. Keeps the log clean — without this, every poll hits
   *  the API and dumps the multi-line 403 JSON body. */
  private youtubeBackoffUntil: number = 0;

  /** Optional callback fired after every successful gameState
   *  snapshot. Wired to the SettlementEngine's live trigger so
   *  event-driven markets (quads, royal, first bust, etc.) settle
   *  the moment their condition is met without waiting for session
   *  end. Errors here are caught at the call site so a failing
   *  settle never breaks the game-state loop. */
  private onSnapshot?: (handleIdHex: string) => Promise<void>;

  constructor(args: {
    apiKey: string;
    openaiApiKey: string;
    ledger: EventLedger;
    stats: SessionStats;
    createEvent: (args: CreateEventArgs) => Promise<CreateEventResult>;
    seedMarket: (eventHandleHex: string, marketIdHex: string, label: string) => Promise<void>;
    /** Called after each successful recordSnapshot. Use to drive the
     *  SettlementEngine's live trigger. Optional — left undefined the
     *  monitor behaves as before. */
    onSnapshot?: (handleIdHex: string) => Promise<void>;
    channels?: MonitoredChannel[];
    storePath?: string;
  }) {
    this.apiKey = args.apiKey;
    this.ledger = args.ledger;
    this.extractor = new LineupExtractor(args.openaiApiKey);
    this.gameState = new GameStateExtractor(args.openaiApiKey);
    this.stats = args.stats;
    this.createEvent = args.createEvent;
    this.seedMarket = args.seedMarket;
    this.onSnapshot = args.onSnapshot;
    this.channels = args.channels ?? DEFAULT_CHANNELS;
    this.storePath = args.storePath
      || process.env.AGENT_SESSION_STORE
      || (process.env.LEDGER_PATH ? DEFAULT_SESSION_STORE : FALLBACK_SESSION_STORE);
    this.state = this.loadState();
    // Resume game-state loops for any sessions persisted from a prior boot.
    for (const sess of this.listActive()) {
      this.startGameStateLoop(sess);
    }
  }

  get enabled(): boolean { return !!this.apiKey; }

  start(): void {
    if (!this.enabled) {
      console.log("[StreamMonitor] YOUTUBE_API_KEY not set — monitor disabled");
      return;
    }
    if (!this.extractor.enabled) {
      console.warn("[StreamMonitor] OPENAI_API_KEY not set — sessions can't be lineup-keyed; monitor disabled");
      return;
    }
    if (this.running) return;
    this.running = true;
    console.log(`[StreamMonitor] Starting · ${this.channels.length} channels · poll every ${POLL_INTERVAL_MS / 1000}s`);
    // Self-rescheduling loop: each poll's next run is scheduled AFTER it
    // finishes, so a 45-60s lineup extraction can't get a second poll
    // racing on top of it. setInterval would have fired at fixed intervals
    // regardless of completion, causing overlapping OpenAI calls for the
    // same videoId.
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.poll();
      } catch (err: any) {
        console.error("[StreamMonitor] Poll failed:", err.message);
      } finally {
        this.scheduleNext(POLL_INTERVAL_MS);
      }
    }, delayMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const t of this.gameStateTimers.values()) clearTimeout(t);
    this.gameStateTimers.clear();
  }

  // ─── Per-session game-state loop ───────────────────────────────────
  // Each active session runs its own 5s ticker that pulls a frame, OCRs
  // the game-state regions, and feeds the result into SessionStats.
  // Self-rescheduling so a slow OCR can't get a fresh tick stacked on
  // top of it.

  private startGameStateLoop(sess: ActiveSession): void {
    if (!this.gameState.enabled) return;
    if (this.gameStateTimers.has(sess.handleIdHex)) return; // already running
    console.log(`[StreamMonitor] ${sess.channelTag} starting game-state loop for ${sess.sessionLabel}`);
    // Eagerly create the stats record so the UI panel renders immediately
    // for new sessions, even before the first OCR snapshot lands. Without
    // this, /agent/stats?handleId=… returns 404 for the first ~5s and the
    // panel decides "no stats for that session" and stays hidden.
    this.stats.ensureSession(sess.sessionLabel, sess.handleIdHex);
    this.scheduleGameStateTick(sess, 1000); // first tick fast
  }

  private stopGameStateLoop(handleIdHex: string): void {
    const t = this.gameStateTimers.get(handleIdHex);
    if (t) {
      clearTimeout(t);
      this.gameStateTimers.delete(handleIdHex);
    }
  }

  private scheduleGameStateTick(sess: ActiveSession, delayMs: number): void {
    const handle = setTimeout(async () => {
      // Bail if the session was ended while we were sleeping. Keyed by
      // handleIdHex (immutable) so this check stays correct even after
      // the lineup mutates and lineupHash changes.
      if (!this.state.active[sess.handleIdHex]) {
        this.gameStateTimers.delete(sess.handleIdHex);
        return;
      }
      try {
        const snap = await this.gameState.snapshot(sess.videoId);
        if (snap) {
          this.stats.recordSnapshot(sess.sessionLabel, sess.handleIdHex, snap);
          // Fire the live settlement trigger after the stats record
          // updates so event-driven markets (quads, royal, first bust,
          // pot-threshold) resolve the moment their condition is met.
          // Caught locally so a settle failure can't break the loop.
          if (this.onSnapshot) {
            try {
              await this.onSnapshot(sess.handleIdHex);
            } catch (settleErr: any) {
              console.warn(`[StreamMonitor] live settle failed for ${sess.handleIdHex.slice(0, 8)}…: ${settleErr.message?.slice(0, 160)}`);
            }
          }
        }
      } catch (err: any) {
        // Errors are already logged inside the extractor; just keep ticking.
      } finally {
        // Re-read in case another path mutated active map mid-tick.
        if (this.state.active[sess.handleIdHex]) {
          this.scheduleGameStateTick(sess, GAME_STATE_INTERVAL_MS);
        } else {
          this.gameStateTimers.delete(sess.handleIdHex);
        }
      }
    }, delayMs);
    this.gameStateTimers.set(sess.handleIdHex, handle);
  }

  /** Currently-active session for a channel, if any. Used by downstream
   *  agent stages (transcriber, classifier) once they're wired in. */
  getActive(channelTag: ChannelTag): ActiveSession | undefined {
    for (const sess of Object.values(this.state.active)) {
      if (sess.channelTag === channelTag) return sess;
    }
    return undefined;
  }

  listActive(): ActiveSession[] {
    return Object.values(this.state.active);
  }

  /** Force a re-extraction right now, bypassing the 10-min recheck
   *  interval AND the per-videoId failure backoff. Additive: any newly-
   *  seen players get per-player markets seeded under the existing
   *  EventHandle. Existing markets stay untouched.
   *
   *  Two paths:
   *
   *  1) Active session known to the StreamMonitor — pass just the
   *     `identifier` (lineup hash or handle hex). videoId is read off
   *     the active session.
   *
   *  2) Active session lost (e.g. monitor restarted with empty
   *     `agent-sessions.json` after redeploy) but the EventHandle still
   *     lives in the EventLedger — pass `identifier` (handle hex) AND a
   *     `videoId` override. The prior lineup is reconstructed from the
   *     ledger's stored marketLabels (we strip the "Will <NAME> bluff…"
   *     prefix to recover names). The session is also reseeded into
   *     active so future polls recheck it.
   *
   *  Returns a structured result so callers can show the operator what
   *  changed without having to diff state separately. */
  async forceRefresh(
    identifier: string,
    overrideVideoId?: string,
    mode: "additive" | "reseed" | "replace" = "additive",
  ): Promise<{
    sessionLabel: string;
    handleIdHex: string;
    videoId: string;
    capturedPlayers: string[];
    entrantsSeeded: string[];
    /** Set in `reseed` mode — every captured player gets idempotently
     *  reseeded, so this lists everyone whose markets were touched. */
    reseededPlayers?: string[];
    /** Set in `replace` mode — marketIds dropped from the ledger because
     *  they referenced ghost players no longer at the table. */
    droppedMarketIds?: string[];
    lineupSize: number;
    /** True when we had to rebuild the active session from the ledger
     *  (path 2 above). Lets the caller flag a degraded/recovered state. */
    reconstructed: boolean;
    mode: "additive" | "reseed" | "replace";
  }> {
    const idLower = identifier.toLowerCase();
    let session = Object.values(this.state.active).find(
      (s) => s.lineupHash === idLower || s.handleIdHex.toLowerCase() === idLower,
    );
    let reconstructed = false;

    if (!session) {
      // Path 2: try to rehydrate from the EventLedger. Caller must give
      // us a videoId since the ledger doesn't know about YouTube state.
      if (!overrideVideoId) {
        throw new Error(
          `forceRefresh: no active session for ${identifier}; pass ?videoId=… to rehydrate from ledger`,
        );
      }
      const ev = this.ledger.get(idLower);
      if (!ev) {
        throw new Error(`forceRefresh: no EventHandle in ledger for ${identifier}`);
      }
      const channelTag: ChannelTag = (ev.label?.startsWith("HCL") ? "HCL" : "TRITON");
      const channel = this.channels.find((c) => c.tag === channelTag);
      const priorPlayers = playersFromMarketLabels(ev.marketLabels);
      const prior: Player[] = priorPlayers.map((name, i) => ({ seat: i + 1, name }));
      const now = Math.floor(Date.now() / 1000);
      session = {
        sessionLabel: ev.label ?? `event-${idLower.slice(0, 8)}`,
        channelTag,
        channelId: channel?.channelId ?? "",
        channelName: channel?.name ?? channelTag,
        videoId: overrideVideoId,
        videoTitle: "",
        handleIdHex: ev.handleId,
        lineup: prior,
        lineupHash: lineupHash(prior),
        startedAt: ev.registeredAt,
        lastSeenAt: now,
        lastLineupCheckAt: now,
      };
      this.state.active[session.handleIdHex] = session;
      reconstructed = true;
      this.startGameStateLoop(session);
      console.log(
        `[StreamMonitor] forceRefresh: rehydrated ${session.sessionLabel} from ledger (${prior.length} prior players, video ${overrideVideoId})`,
      );
    } else if (overrideVideoId && overrideVideoId !== session.videoId) {
      // Active session exists but caller wants to point it at a different
      // videoId (broadcast restarted on a new id). Update + carry on.
      console.log(
        `[StreamMonitor] forceRefresh: ${session.sessionLabel} videoId ${session.videoId} → ${overrideVideoId}`,
      );
      session.videoId = overrideVideoId;
    }

    // Drop any cached failure for this videoId so a recent transient
    // backoff doesn't silently make extract() return null.
    this.extractor.clearFailures(session.videoId);

    const lineup = await this.extractor.extract(session.videoId);
    if (!lineup) {
      throw new Error(`forceRefresh: extractor returned null for ${session.videoId}`);
    }

    // Punctuation-insensitive dedup so "ST WANG" and "ST. WANG" don't
    // both register as separate players. Used for both session.lineup
    // canonicalisation and entrant detection.
    const canonicalize = (s: string): string =>
      s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");

    // Scrub placeholders AND collapse duplicates in session.lineup —
    // older extraction passes (before the placeholder filter / punct-
    // dedup landed) may have accumulated both "ST WANG" and "ST. WANG"
    // as distinct entries. One refresh cleans the state for free.
    {
      const seen = new Set<string>();
      const cleaned: Player[] = [];
      for (const p of session.lineup) {
        if (isObviousPlaceholder(p.name)) continue;
        const k = canonicalize(p.name);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        cleaned.push(p);
      }
      session.lineup = cleaned;
    }

    const oldKeys = new Set(session.lineup.map((p) => canonicalize(p.name)));
    const entrants = lineup.players.filter((p) => !oldKeys.has(canonicalize(p.name)));

    let reseededPlayers: string[] | undefined;
    let droppedMarketIds: string[] | undefined;

    if (mode === "reseed") {
      // Idempotently re-run newEntrantMarketsFor for every player we've
      // ever associated with this session (cleaned session.lineup ∪
      // freshly captured) — covers cases where recheckLineup detected
      // an entrant historically but their seedMarketUnderEvent calls
      // failed silently (e.g. under WSS-cap pressure before today's
      // HTTP-poll fix), so they're in session.lineup but have no
      // markets attached. safeSeed is idempotent on already-attached
      // markets, so re-running on existing ones is a no-op.
      const union = new Map<string, Player>();
      for (const p of session.lineup) {
        const k = canonicalize(p.name);
        if (k && !union.has(k)) union.set(k, p);
      }
      for (const p of lineup.players) {
        const k = canonicalize(p.name);
        if (k && !union.has(k)) union.set(k, p);
      }
      const seedTargets = Array.from(union.values());
      console.log(
        `[StreamMonitor] forceRefresh(reseed) ${session.sessionLabel}: idempotently seeding ${seedTargets.length} player(s) (cleaned-lineup ∪ fresh-capture)`,
      );
      for (const p of seedTargets) {
        const markets = newEntrantMarketsFor(session.sessionLabel, p);
        for (const m of markets) {
          await this.safeSeed(session.handleIdHex, m);
        }
      }
      reseededPlayers = seedTargets.map((p) => p.name);
      // Fold in any genuine entrants too so session.lineup grows.
      if (entrants.length > 0) {
        session.lineup = [...session.lineup, ...entrants];
        session.lineupHash = lineupHash(session.lineup);
      }
    } else if (mode === "replace") {
      // Drop ghost players (anyone in the prior lineup but NOT in this
      // capture). Their per-player markets get detached from the event
      // ledger so the UI stops surfacing them, but the on-chain accounts
      // stay rent-funded (can't cheaply close Solana accounts).
      const ev = this.ledger.get(session.handleIdHex);
      if (!ev) throw new Error(`forceRefresh(replace): EventHandle ${session.handleIdHex} missing`);
      const keepKeys = new Set(lineup.players.map((p) => canonicalize(p.name)));
      const ghostKeys = new Set<string>();
      for (const p of session.lineup) {
        const k = canonicalize(p.name);
        if (!keepKeys.has(k)) ghostKeys.add(k);
      }
      const toDrop: string[] = [];
      for (const [marketId, label] of Object.entries(ev.marketLabels ?? {})) {
        const refs = playerNamesReferencedByLabel(label);
        if (refs.length === 0) continue; // generic market — keep
        const anyGhost = refs.some((r) => ghostKeys.has(canonicalize(r)));
        if (anyGhost) toDrop.push(marketId);
      }
      if (toDrop.length > 0) {
        const { dropped } = this.ledger.detachMarkets(session.handleIdHex, toDrop);
        console.log(
          `[StreamMonitor] forceRefresh(replace) ${session.sessionLabel}: dropped ${dropped} ghost-player market(s)`,
        );
      }
      droppedMarketIds = toDrop;
      // Now seed any captured players whose markets aren't already
      // present (idempotent — safeSeed tolerates already-exists).
      for (const p of lineup.players) {
        const markets = newEntrantMarketsFor(session.sessionLabel, p);
        for (const m of markets) {
          await this.safeSeed(session.handleIdHex, m);
        }
      }
      // Replace session.lineup outright with the fresh capture.
      session.lineup = [...lineup.players];
      session.lineupHash = lineupHash(session.lineup);
    } else {
      // additive (default) — original behaviour
      if (entrants.length > 0) {
        console.log(
          `[StreamMonitor] forceRefresh ${session.sessionLabel}: ${entrants.length} new player(s): ${entrants.map((p) => p.name).join(", ")}`,
        );
        for (const p of entrants) {
          const markets = newEntrantMarketsFor(session.sessionLabel, p);
          for (const m of markets) {
            await this.safeSeed(session.handleIdHex, m);
          }
        }
        session.lineup = [...session.lineup, ...entrants];
        session.lineupHash = lineupHash(session.lineup);
      } else {
        console.log(
          `[StreamMonitor] forceRefresh ${session.sessionLabel}: no new players (captured ${lineup.players.length}, all known)`,
        );
      }
    }

    session.lastLineupCheckAt = Math.floor(Date.now() / 1000);
    this.persist();

    return {
      sessionLabel: session.sessionLabel,
      handleIdHex: session.handleIdHex,
      videoId: session.videoId,
      capturedPlayers: lineup.players.map((p) => p.name),
      entrantsSeeded: entrants.map((p) => p.name),
      reseededPlayers,
      droppedMarketIds,
      lineupSize: session.lineup.length,
      reconstructed,
      mode,
    };
  }

  // ─── Polling loop ───────────────────────────────────────────────────

  private async poll(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.state.lastPollAt = now;

    // Process channels in parallel so a 45-60s lineup extraction on one
    // channel doesn't block the other. Each channel's per-video work is
    // still sequential (we don't want the same channel double-creating
    // a session for the same lineup).
    await Promise.all(this.channels.map((ch) => this.pollChannel(ch, now)));

    this.persist();
  }

  private async pollChannel(ch: MonitoredChannel, now: number): Promise<void> {
    const activeForChannel = this.listActive().filter((s) => s.channelTag === ch.tag);

    // Quota-conscious flow:
    //   - For each active session, ping videos.list?id=videoId (1 unit)
    //     to check it's still live. Cheap.
    //   - Only call search.list (100 units) for DISCOVERY when this
    //     channel has no active session — i.e., we're hunting for a new
    //     stream to start watching.
    //
    // Default YouTube Data API quota is 10,000 units/day, so the old
    // pattern (search.list every poll for every channel = 200 units/poll
    // × 1440 polls = 288k units/day) blew through it in ~50 min.

    // While in YouTube quota backoff, skip the API entirely. Active
    // sessions stay alive (no liveness check pings → no false offline
    // signals); discovery resumes when the backoff expires. This is
    // why we don't end sessions on isVideoLive() errors — exactly this
    // case lets us soft-fail until quota resets.
    if (Date.now() < this.youtubeBackoffUntil) return;

    // 1. Ping known active videos.
    for (const sess of activeForChannel) {
      let stillLive = false;
      try {
        stillLive = await this.isVideoLive(sess.videoId);
      } catch (err: any) {
        if (this.handleYoutubeError(ch.tag, "videos.list", err)) return;
        console.warn(`[StreamMonitor] ${ch.tag} videos.list ${sess.videoId} failed: ${err.message?.slice(0, 120)}`);
        // Don't end the session on a single API hiccup — let the OFFLINE
        // grace period handle it.
        continue;
      }

      if (stillLive) {
        sess.lastSeenAt = now;
        if (Date.now() - sess.lastLineupCheckAt * 1000 > LINEUP_RECHECK_MS) {
          await this.recheckLineup(sess);
          sess.lastLineupCheckAt = now;
        }
      } else {
        // Video has ended on YouTube's side. Stay in grace period in
        // case the broadcaster restarts on a new videoId — we'd then
        // pick that up via discovery (next branch).
        if (Date.now() - sess.lastSeenAt * 1000 > OFFLINE_GRACE_MS) {
          this.endSession(sess, "video confirmed offline past grace period");
        }
      }
    }

    // 2. Discovery: only if this channel currently has no active session.
    //    The active-session check is re-evaluated post-step-1 in case the
    //    grace period just expired.
    const stillActive = this.listActive().some((s) => s.channelTag === ch.tag);
    if (stillActive) return;

    let discovered: { videoId: string; title: string }[] = [];
    try {
      discovered = await this.fetchLiveBroadcasts(ch.channelId);
    } catch (err: any) {
      if (this.handleYoutubeError(ch.tag, "discovery", err)) return;
      console.warn(`[StreamMonitor] ${ch.tag} discovery failed: ${err.message?.slice(0, 120)}`);
      return;
    }

    for (const v of discovered) {
      await this.handleNewLiveVideo(ch, v, now);
    }
  }

  /** Cheap (1 unit) check via videos.list?id=…&part=liveStreamingDetails.
   *  Returns true if the video is still actively broadcasting (no
   *  actualEndTime set), false if it's ended or not found. */
  private async isVideoLive(videoId: string): Promise<boolean> {
    const url = `${YOUTUBE_API}/videos?part=liveStreamingDetails&id=${videoId}&key=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw await youtubeError(res);
    const data = await res.json() as { items?: any[] };
    const item = data.items?.[0];
    if (!item) return false; // video deleted/private
    const details = item.liveStreamingDetails;
    if (!details) return false; // not a live broadcast (recorded video)
    // actualEndTime is set the moment the broadcaster ends the stream.
    // While live, only actualStartTime is set.
    return !details.actualEndTime;
  }

  /** Detect quota-exhausted errors from YouTube and arm the global
   *  backoff so subsequent polls skip the API. Returns true when the
   *  caller should bail out of the current poll iteration (the error
   *  has already been logged once). Returns false for other errors so
   *  the caller can log them normally. */
  private handleYoutubeError(channelTag: string, op: string, err: any): boolean {
    const code = (err as YoutubeError).youtubeStatus;
    const isQuota = code === 403 && /\bquota\b/i.test((err as YoutubeError).youtubeReason || err.message || "");
    if (!isQuota) return false;
    if (Date.now() < this.youtubeBackoffUntil) {
      // Already backing off — don't re-log the same error every poll.
      return true;
    }
    const BACKOFF_MS = 60 * 60_000; // 1h — quota resets at midnight PT
    this.youtubeBackoffUntil = Date.now() + BACKOFF_MS;
    const resumeAt = new Date(this.youtubeBackoffUntil).toISOString().slice(11, 16);
    console.warn(
      `[StreamMonitor] ${channelTag} ${op}: YouTube quota exhausted, backing off until ${resumeAt}Z (1h)`,
    );
    return true;
  }

  private async fetchLiveBroadcasts(channelId: string): Promise<{ videoId: string; title: string }[]> {
    const url = `${YOUTUBE_API}/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw await youtubeError(res);
    const data = await res.json() as { items?: any[] };
    return (data.items ?? [])
      .filter((it) => it.id?.videoId)
      .map((it) => ({ videoId: it.id.videoId as string, title: it.snippet?.title ?? "" }));
  }

  private async handleNewLiveVideo(
    ch: MonitoredChannel,
    v: { videoId: string; title: string },
    now: number,
  ): Promise<void> {
    console.log(`[StreamMonitor] ${ch.tag} new live video ${v.videoId}: ${v.title.slice(0, 60)}`);
    const lineup = await this.extractor.extract(v.videoId);
    if (!lineup) {
      console.warn(`[StreamMonitor] ${ch.tag} lineup extract returned null — skipping`);
      return;
    }
    if (!lineup.confident) {
      console.log(`[StreamMonitor] ${ch.tag} non-confident lineup (intermission/replay?) — skipping for now`);
      return;
    }

    // Does this lineup match an already-active session? (Stream restart
    // mid-game is the classic case — different videoId, same players.)
    // Active map is keyed by handleIdHex; scan values for a current
    // lineupHash match. Map is bounded to ~one session per channel.
    const existing = Object.values(this.state.active).find((s) => s.lineupHash === lineup.hash);
    if (existing) {
      console.log(`[StreamMonitor] ${ch.tag} session ${existing.sessionLabel} continues on new video ${v.videoId}`);
      existing.videoId = v.videoId;
      existing.videoTitle = v.title;
      existing.lastSeenAt = now;
      existing.lastLineupCheckAt = now;
      return;
    }

    await this.startSession(ch, v, lineup, now);
  }

  /** Re-OCR an active session and react to lineup changes.
   *
   *  Pro broadcasts only overlay nameplates for players currently in
   *  the hand (folded players' tiles disappear). So a single capture
   *  rarely sees the full 6-9 player table — it catches whoever happens
   *  to be in the hands during the sampling window. We treat each
   *  recheck as ADDITIVE: any newly-seen player gets folded into the
   *  session's running lineup and per-player markets are seeded for
   *  them. Over the session's first 30-60 min, this converges on the
   *  full table even if no single capture saw everyone.
   *
   *  We only flip to "session ended, start a new one" when the OCR
   *  shows a player set with very low overlap to what we've accumulated
   *  — i.e. the table genuinely turned over (everyone left, new game). */
  private async recheckLineup(session: ActiveSession): Promise<void> {
    const lineup = await this.extractor.extract(session.videoId);
    if (!lineup || !lineup.confident || lineup.players.length === 0) return;

    const oldNames = new Set(session.lineup.map((p) => p.name.toLowerCase()));
    const newNames = new Set(lineup.players.map((p) => p.name.toLowerCase()));

    // Same set of players — nothing to do.
    if (oldNames.size === newNames.size && [...newNames].every((n) => oldNames.has(n))) {
      return;
    }

    // Compute overlap on the *original* old set. Note the asymmetry:
    // we measure how many of the just-seen players were already known.
    // This prevents an edge case where the broadcast happens to show
    // 2 brand-new sub-in players in a single frame and we'd otherwise
    // declare turnover even though 5 known players are still seated.
    let intersection = 0;
    for (const n of newNames) if (oldNames.has(n)) intersection++;
    const newSeenButKnown = intersection / Math.max(newNames.size, 1);

    if (newSeenButKnown < 0.2 && oldNames.size > 2) {
      // Almost none of the new capture is recognised AND we had more
      // than 2 players accumulated — the table has genuinely turned
      // over. End this session; next discovery will pick up the new
      // lineup as a fresh session.
      console.log(`[StreamMonitor] ${session.channelTag} lineup turnover at ${session.sessionLabel} (${(newSeenButKnown * 100).toFixed(0)}% match to known) — ending session`);
      this.endSession(session, "lineup turnover");
      return;
    }

    // Otherwise: additive. Any name we haven't seen before is an entrant.
    const entrants = lineup.players.filter((p) => !oldNames.has(p.name.toLowerCase()));
    if (entrants.length === 0) return;

    console.log(`[StreamMonitor] ${session.channelTag} ${entrants.length} new player(s) at ${session.sessionLabel}: ${entrants.map((p) => p.name).join(", ")}`);
    for (const p of entrants) {
      const markets = newEntrantMarketsFor(session.sessionLabel, p);
      for (const m of markets) {
        await this.safeSeed(session.handleIdHex, m);
      }
    }

    // Grow the session's lineup with the new entrants — keep the prior
    // players too since they're still part of this session even if they
    // weren't in any of the just-sampled frames.
    const merged = [...session.lineup];
    for (const p of entrants) merged.push(p);
    session.lineup = merged;
    session.lineupHash = lineupHash(merged);
  }

  private async startSession(
    ch: MonitoredChannel,
    v: { videoId: string; title: string },
    lineup: Lineup,
    now: number,
  ): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const sessionLabel = `${ch.tag}-SESSION-${date}-${lineup.hash.slice(0, 8)}`;
    const closesAt = now + 12 * 3600;

    const created = await this.createEvent({
      label: sessionLabel,
      category: "LiveStream",
      closesAt,
    });

    const playerList = lineup.players.map((p) => p.name).join(", ");
    console.log(`[StreamMonitor] ${ch.tag} session started: ${sessionLabel} (${v.videoId})`);
    console.log(`                handle: ${created.handleIdHex.slice(0, 12)}…  pda: ${created.eventHandlePda}`);
    console.log(`                lineup: ${playerList}`);

    const session: ActiveSession = {
      sessionLabel,
      channelTag: ch.tag,
      channelId: ch.channelId,
      channelName: ch.name,
      videoId: v.videoId,
      videoTitle: v.title,
      handleIdHex: created.handleIdHex,
      lineup: lineup.players,
      lineupHash: lineup.hash,
      startedAt: now,
      lastSeenAt: now,
      lastLineupCheckAt: now,
    };
    this.state.active[created.handleIdHex] = session;

    // Generic markets (quads/royal/pot threshold/early bust/all-ins)
    // resolve too quickly to be interesting prediction markets — most
    // fire within the first hour and leave no trading window. Skip
    // them in auto-seeding; they're still in marketTemplates if
    // someone wants to one-off-seed them via the admin endpoint.
    // Player + H2H markets are the real demo content.
    for (const m of playerMarketsFor(sessionLabel, lineup.players)) {
      await this.safeSeed(created.handleIdHex, m);
    }

    const playerCount = lineup.players.length;
    const h2hCount = playerCount >= 2 ? Math.min(3, Math.floor(playerCount / 2)) * 2 : 0;
    console.log(`[StreamMonitor] ${ch.tag} ${sessionLabel} seeded ${playerCount * 4 + h2hCount} markets`);

    // Initialise stats record + spin up the game-state OCR loop.
    this.stats.ensureSession(sessionLabel, created.handleIdHex);
    this.startGameStateLoop(session);
  }

  private async safeSeed(handleHex: string, m: SeededMarket): Promise<void> {
    try {
      await this.seedMarket(handleHex, m.marketIdHex, m.label);
    } catch (err: any) {
      console.warn(`[StreamMonitor] seed ${m.slug} failed: ${err.message}`);
    }
  }

  /** Mark a session as ended in our state. The actual on-chain settlement
   *  is the settlement engine's job (day 5) — for now we just stop
   *  tracking. The EventHandle on-chain is still there with its markets
   *  so traders see it (with a "session ended" badge once the UI catches
   *  up); LP capital auto-refunds at closesAt regardless. */
  private endSession(session: ActiveSession, reason: string): void {
    console.log(`[StreamMonitor] ${session.channelTag} ending session ${session.sessionLabel}: ${reason}`);
    this.stopGameStateLoop(session.handleIdHex);
    delete this.state.active[session.handleIdHex];
    // TODO(day-5): emit settlement-pending event for the settlement engine
    // to pick up. Stats for this session live in this.stats.get(label).
  }

  // ─── State persistence ─────────────────────────────────────────────

  private loadState(): SessionStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<SessionStore>;
        if (parsed.schemaVersion === 2 && parsed.active) {
          // Migration: older v2 writes keyed `active` by lineupHash; the
          // current code keys by handleIdHex (immutable). Re-key in
          // place so callers operating against handleIdHex don't see
          // empty results for sessions persisted under their lineup
          // hash. Idempotent — sessions already keyed by handleIdHex
          // map to themselves.
          const rekeyed: Record<string, ActiveSession> = {};
          for (const [key, sess] of Object.entries(parsed.active)) {
            const targetKey = sess.handleIdHex;
            if (!targetKey) continue;
            if (rekeyed[targetKey]) continue; // dedupe if both keys present
            rekeyed[targetKey] = sess;
            if (key !== targetKey) {
              console.log(`[StreamMonitor] migrated session ${sess.sessionLabel} key ${key.slice(0,8)}… → ${targetKey.slice(0,8)}…`);
            }
          }
          return {
            schemaVersion: 2,
            active: rekeyed,
            lastPollAt: parsed.lastPollAt ?? 0,
          };
        }
        // v1 store (videoId-keyed) — not migratable. Start fresh; the
        // poller will re-discover any active sessions on next tick.
        console.log("[StreamMonitor] Ignoring v1 session store (lineup-keyed schema is incompatible)");
      }
    } catch (err) {
      console.warn("[StreamMonitor] State load failed:", err);
    }
    return { schemaVersion: 2, active: {}, lastPollAt: 0 };
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error("[StreamMonitor] State persist failed:", err);
    }
  }
}

/** Error subclass that carries the YouTube HTTP status + reason code.
 *  Lets `handleYoutubeError` distinguish quota-exhausted errors from
 *  generic 4xx/5xx hiccups without parsing the message string. */
class YoutubeError extends Error {
  youtubeStatus: number;
  youtubeReason: string;
  constructor(message: string, status: number, reason: string) {
    super(message);
    this.youtubeStatus = status;
    this.youtubeReason = reason;
  }
}

/** Wrap a non-2xx YouTube response in a structured error. Parses the
 *  error body just enough to surface the reason code (quotaExceeded,
 *  rateLimitExceeded, etc.) without dumping the multi-line JSON into
 *  logs. The full body is truncated to 120 chars for the .message. */
async function youtubeError(res: Response): Promise<YoutubeError> {
  const body = await res.text().catch(() => "");
  let reason = "";
  try {
    const parsed = JSON.parse(body);
    reason = parsed?.error?.errors?.[0]?.reason
      ?? parsed?.error?.status
      ?? "";
  } catch { /* body wasn't JSON */ }
  const message = `YouTube ${res.status}${reason ? ` (${reason})` : ""}: ${body.slice(0, 120).replace(/\s+/g, " ")}`;
  return new YoutubeError(message, res.status, reason);
}

/** Pull player names out of a market label by reversing the templates
 *  in marketTemplates.ts. Generics return []. Per-player return [X].
 *  H2H return [X, Y]. Used by replace-mode to identify which markets
 *  reference ghost players that should be detached from the ledger. */
function playerNamesReferencedByLabel(label: string): string[] {
  // Per-player templates
  const single = label.match(
    /^Will (.+?) (?:bluff the most this session|bust first|win the biggest pot tonight|win the most hands tonight)\?$/,
  );
  if (single) return [single[1].trim()];
  // H2H templates
  const h2hBluff = label.match(/^Will (.+?) bluff more than (.+?) tonight\?$/);
  if (h2hBluff) return [h2hBluff[1].trim(), h2hBluff[2].trim()];
  const h2hPot = label.match(/^Will (.+?) win a bigger pot than (.+?) tonight\?$/);
  if (h2hPot) return [h2hPot[1].trim(), h2hPot[2].trim()];
  return [];
}

/** Match the lineupExtractor's placeholder filter so refresh can also
 *  remove garbage that older extractions left in session.lineup. Kept
 *  in lockstep with isPlaceholderName there. */
function isObviousPlaceholder(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;
  if (/^[0-9$,.]+$/.test(trimmed)) return true;
  if (/^(player|seat|p)\s*\d{1,2}$/i.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return new Set([
    "player name", "player", "name",
    "n/a", "unknown", "tbd", "dealer", "host",
  ]).has(lower);
}

/** Recover the player lineup from a stored event's marketLabels by
 *  stripping the "Will <NAME> bluff…" / "Will <NAME> bust…" prefixes.
 *  Mirrors the frontend's parser in PredacyEventCard so reconstructed
 *  lineups match what users see on the cards. Returns lowercase names
 *  in first-seen order (de-duped). */
function playersFromMarketLabels(labels?: Record<string, string>): string[] {
  if (!labels) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lbl of Object.values(labels)) {
    let m = lbl.match(/^Will (.+?) bluff the most this session\?$/);
    if (!m) m = lbl.match(/^Will (.+?) bust first\?$/);
    if (!m) m = lbl.match(/^Will (.+?) win the biggest pot tonight\?$/);
    if (!m) m = lbl.match(/^Will (.+?) win the most hands tonight\?$/);
    if (!m) continue;
    const name = m[1].trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
