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

const POLL_INTERVAL_MS = 60_000;
const LINEUP_RECHECK_MS = 10 * 60 * 1000;   // re-OCR active session every 10 min
const OFFLINE_GRACE_MS = 5 * 60 * 1000;     // tolerate 5 min of "video gone" before ending session
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
  /** Keyed by lineup hash (the session identity), not videoId. */
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
  private createEvent: (args: CreateEventArgs) => Promise<CreateEventResult>;
  private seedMarket: (eventHandleHex: string, marketIdHex: string, label: string) => Promise<void>;
  private channels: MonitoredChannel[];
  private storePath: string;
  private state: SessionStore;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(args: {
    apiKey: string;
    openaiApiKey: string;
    ledger: EventLedger;
    createEvent: (args: CreateEventArgs) => Promise<CreateEventResult>;
    seedMarket: (eventHandleHex: string, marketIdHex: string, label: string) => Promise<void>;
    channels?: MonitoredChannel[];
    storePath?: string;
  }) {
    this.apiKey = args.apiKey;
    this.ledger = args.ledger;
    this.extractor = new LineupExtractor(args.openaiApiKey);
    this.createEvent = args.createEvent;
    this.seedMarket = args.seedMarket;
    this.channels = args.channels ?? DEFAULT_CHANNELS;
    this.storePath = args.storePath
      || process.env.AGENT_SESSION_STORE
      || (process.env.LEDGER_PATH ? DEFAULT_SESSION_STORE : FALLBACK_SESSION_STORE);
    this.state = this.loadState();
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
    let live: { videoId: string; title: string }[] = [];
    try {
      live = await this.fetchLiveBroadcasts(ch.channelId);
    } catch (err: any) {
      console.warn(`[StreamMonitor] ${ch.tag} fetch failed: ${err.message}`);
      return;
    }

    const liveVideoIds = new Set(live.map((v) => v.videoId));
    const activeForChannel = this.listActive().filter((s) => s.channelTag === ch.tag);

    for (const v of live) {
      const knownSession = activeForChannel.find((s) => s.videoId === v.videoId);

      if (knownSession) {
        // Existing video — touch lastSeen, do periodic re-OCR.
        knownSession.lastSeenAt = now;
        if (Date.now() - knownSession.lastLineupCheckAt * 1000 > LINEUP_RECHECK_MS) {
          await this.recheckLineup(knownSession);
          knownSession.lastLineupCheckAt = now;
        }
        continue;
      }

      // New videoId for this channel — extract lineup to identify session.
      await this.handleNewLiveVideo(ch, v, now);
    }

    // Active sessions whose video disappeared from the live feed.
    // Hold for OFFLINE_GRACE_MS before declaring ended.
    for (const sess of activeForChannel) {
      if (liveVideoIds.has(sess.videoId)) continue;
      if (Date.now() - sess.lastSeenAt * 1000 > OFFLINE_GRACE_MS) {
        this.endSession(sess, "video offline past grace period");
      }
    }
  }

  private async fetchLiveBroadcasts(channelId: string): Promise<{ videoId: string; title: string }[]> {
    const url = `${YOUTUBE_API}/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${this.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`YouTube ${res.status}: ${body.slice(0, 200)}`);
    }
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
    const existing = this.state.active[lineup.hash];
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

  /** Re-OCR an active session and react to lineup changes. */
  private async recheckLineup(session: ActiveSession): Promise<void> {
    const lineup = await this.extractor.extract(session.videoId);
    if (!lineup || !lineup.confident) {
      // Not confident — don't act on it. Could be a hand transition, a
      // close-up shot, etc. The next recheck in 10 min will retry.
      return;
    }

    if (lineup.hash === session.lineupHash) return; // unchanged

    // Compare name sets to decide entrant vs full-turnover.
    const oldNames = new Set(session.lineup.map((p) => p.name.toLowerCase()));
    const newNames = new Set(lineup.players.map((p) => p.name.toLowerCase()));

    let intersection = 0;
    for (const n of newNames) if (oldNames.has(n)) intersection++;

    const overlapRatio = intersection / Math.max(oldNames.size, newNames.size, 1);
    if (overlapRatio < 0.5) {
      // Mostly different players → previous session is done.
      console.log(`[StreamMonitor] ${session.channelTag} lineup turnover detected (overlap=${(overlapRatio * 100).toFixed(0)}%) — ending ${session.sessionLabel}`);
      this.endSession(session, "lineup turnover");
      // Next poll will re-detect the new lineup as a fresh session.
      return;
    }

    // Partial overlap → option-A behavior: add markets for new entrants.
    const entrants = lineup.players.filter((p) => !oldNames.has(p.name.toLowerCase()));
    if (entrants.length === 0) {
      // Players left but no one new sat down — reseating, no markets to add.
      session.lineup = lineup.players;
      session.lineupHash = lineup.hash;
      return;
    }

    console.log(`[StreamMonitor] ${session.channelTag} ${entrants.length} new entrant(s) at ${session.sessionLabel}: ${entrants.map((p) => p.name).join(", ")}`);
    for (const p of entrants) {
      const markets = newEntrantMarketsFor(session.sessionLabel, p);
      for (const m of markets) {
        await this.safeSeed(session.handleIdHex, m);
      }
    }

    // Update session state to reflect the new lineup. Note we deliberately
    // keep the same handleIdHex / sessionLabel — the session continues,
    // just with extra players covered.
    session.lineup = lineup.players;
    session.lineupHash = lineup.hash;
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
    this.state.active[lineup.hash] = session;

    // Seed generic markets first so the cards show up fast — these don't
    // depend on the lineup. Player-aware markets follow.
    for (const m of genericMarketsFor(ch.tag, sessionLabel)) {
      await this.safeSeed(created.handleIdHex, m);
    }
    for (const m of playerMarketsFor(sessionLabel, lineup.players)) {
      await this.safeSeed(created.handleIdHex, m);
    }

    console.log(`[StreamMonitor] ${ch.tag} ${sessionLabel} seeded ${5 + lineup.players.length * 4 + (lineup.players.length >= 2 ? 2 : 0)} markets`);
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
    delete this.state.active[session.lineupHash];
    // TODO(day-5): emit settlement-pending event for the settlement engine
    // to pick up. Tracked outcomes per market need to be passed along.
  }

  // ─── State persistence ─────────────────────────────────────────────

  private loadState(): SessionStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<SessionStore>;
        if (parsed.schemaVersion === 2) {
          return parsed as SessionStore;
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
