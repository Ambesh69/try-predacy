/**
 * Stream Monitor — discovers when watched poker channels go live and drives
 * the EventHandle lifecycle for that session.
 *
 * For v1 (today, day 2 of Phase 2):
 *   - Polls YouTube Data API every 60s for the configured channels.
 *   - When a channel transitions OFFLINE → LIVE, registers a Predacy
 *     EventHandle for the session and seeds 5 generic prop markets.
 *   - Tracks active sessions in /data so we don't double-create across
 *     relayer restarts.
 *
 * Phases not yet wired (build out over days 3-5):
 *   - Lineup extraction (vision OCR on opening frames)         → day 3
 *   - Player-aware market instantiation                         → day 3
 *   - Whisper transcription of stream audio                     → day 4
 *   - Event classifier (bluff/bust/pot/quads detection)         → day 4
 *   - Settlement on session end                                 → day 5
 *
 * The monitor is intentionally idempotent: every poll re-checks live state
 * and the createSession path bails out if the videoId is already active.
 * Safe to run alongside hot-reload / multiple relayer restarts.
 */

import * as fs from "fs";
import * as path from "path";
import { EventLedger, EventCategory } from "../eventLedger";

const POLL_INTERVAL_MS = 60_000;
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

// Channels we monitor for live broadcasts. ChannelIds resolved once via
// /channels?forHandle=... — see scripts/dev-notes for the resolution.
export interface MonitoredChannel {
  /** Short uppercase tag — used as a label prefix (e.g. "TRITON-...") */
  tag: string;
  /** YouTube channelId (UC...) */
  channelId: string;
  /** Human-readable channel name for logs/UI */
  name: string;
}

export const DEFAULT_CHANNELS: MonitoredChannel[] = [
  { tag: "TRITON", channelId: "UCpcv404DxfhGYhXgyB9Aoeg", name: "Triton Poker" },
  { tag: "HCL",    channelId: "UCQe7wB0o_cZgv1miyYB9TMA", name: "Hustler Casino Live" },
];

interface ActiveSession {
  videoId: string;
  channelTag: string;
  channelId: string;
  channelName: string;
  title: string;
  /** Hex handle id of the EventHandle backing this session. */
  handleIdHex: string;
  startedAt: number;
}

interface SessionStore {
  /** keyed by videoId */
  active: Record<string, ActiveSession>;
  lastPollAt: number;
}

const DEFAULT_SESSION_STORE = "/data/agent-sessions.json";
const FALLBACK_SESSION_STORE = path.join(__dirname, "..", "..", "agent-sessions.json");

// Standard prop markets seeded under every new session. Keyed by slug so
// the marketId is deterministic across restarts (sha256("<event>/<slug>")).
// The whale-pot threshold is parameterized per channel — Triton plays
// bigger than HCL on average.
export interface GenericMarketTemplate {
  slug: string;
  label: (channelTag: string) => string;
}

export const GENERIC_MARKETS: GenericMarketTemplate[] = [
  { slug: "quads",     label: () => "Anyone hits quads tonight?" },
  { slug: "royal",     label: () => "Anyone hits a royal flush tonight?" },
  { slug: "whale_pot", label: (tag) =>
      tag === "TRITON" ? "Will any pot exceed $500K tonight?" :
                         "Will any pot exceed $200K tonight?" },
  { slug: "early_bust", label: () => "First player busts within 90 minutes?" },
  { slug: "ten_allins", label: () => "10+ all-ins tonight?" },
];

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
  /** Hook to put an EventHandle on-chain + register it in the ledger.
   *  Injected because the actual flow uses the Solana client which lives
   *  in index.ts. Should be idempotent (safe to call for an existing
   *  EventHandle — the on-chain create returns "already in use" and the
   *  ledger upserts the label). */
  private createEvent: (args: CreateEventArgs) => Promise<CreateEventResult>;
  /** Hook to seed (or re-seed) a market under an event. Should:
   *    1. Call processor.startMarket(marketId) to create the on-chain market
   *    2. Call client.initBootstrapPool(marketId, eventHandlePda)
   *    3. Call eventLedger.attachMarket(eventHandle, marketId, label)
   *  All three idempotent — already-exists errors caught. */
  private seedMarket: (eventHandleHex: string, marketIdHex: string, label: string) => Promise<void>;
  private channels: MonitoredChannel[];
  private storePath: string;
  private state: SessionStore;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(args: {
    apiKey: string;
    ledger: EventLedger;
    createEvent: (args: CreateEventArgs) => Promise<CreateEventResult>;
    seedMarket: (eventHandleHex: string, marketIdHex: string, label: string) => Promise<void>;
    channels?: MonitoredChannel[];
    storePath?: string;
  }) {
    this.apiKey = args.apiKey;
    this.ledger = args.ledger;
    this.createEvent = args.createEvent;
    this.seedMarket = args.seedMarket;
    this.channels = args.channels ?? DEFAULT_CHANNELS;
    this.storePath = args.storePath
      || process.env.AGENT_SESSION_STORE
      || (process.env.LEDGER_PATH ? DEFAULT_SESSION_STORE : FALLBACK_SESSION_STORE);
    this.state = this.loadState();
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  start(): void {
    if (!this.enabled) {
      console.log("[StreamMonitor] YOUTUBE_API_KEY not set — monitor disabled");
      return;
    }
    if (this.running) return;
    this.running = true;
    console.log(`[StreamMonitor] Starting · ${this.channels.length} channels · poll every ${POLL_INTERVAL_MS / 1000}s`);
    // Run once immediately, then on interval.
    this.poll().catch((err) => console.error("[StreamMonitor] First poll failed:", err.message));
    this.timer = setInterval(() => {
      this.poll().catch((err) => console.error("[StreamMonitor] Poll failed:", err.message));
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns the currently-active session for a channel, if any. Useful
   *  for downstream stages (lineup extractor, transcriber) once they're
   *  wired in. */
  getActive(channelTag: string): ActiveSession | undefined {
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
    this.state.lastPollAt = Math.floor(Date.now() / 1000);

    for (const ch of this.channels) {
      let live: { videoId: string; title: string }[] = [];
      try {
        live = await this.fetchLiveBroadcasts(ch.channelId);
      } catch (err: any) {
        console.warn(`[StreamMonitor] ${ch.tag} fetch failed: ${err.message}`);
        continue;
      }

      const liveIds = new Set(live.map((v) => v.videoId));

      // Detect new go-live: video in liveIds but not in our active set yet.
      for (const v of live) {
        if (this.state.active[v.videoId]) continue;
        try {
          await this.startSession(ch, v);
        } catch (err: any) {
          console.error(`[StreamMonitor] ${ch.tag} startSession failed: ${err.message}`);
        }
      }

      // Detect went-offline: previously-active video for this channel no
      // longer in the live list. We mark it gone but DO NOT settle here —
      // that's the settlementEngine's job (day 5 wiring).
      for (const sess of Object.values(this.state.active)) {
        if (sess.channelTag !== ch.tag) continue;
        if (!liveIds.has(sess.videoId)) {
          console.log(`[StreamMonitor] ${ch.tag} session ended: ${sess.videoId} (${sess.title.slice(0, 60)})`);
          delete this.state.active[sess.videoId];
        }
      }
    }

    this.persist();
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

  private async startSession(ch: MonitoredChannel, v: { videoId: string; title: string }): Promise<void> {
    // EventHandle label uniquely identifies this session: channel tag +
    // ISO date + short videoId so two days of the same channel produce
    // distinct EventHandles, and a 24/7 stream that briefly drops gets
    // a NEW session each time it goes live (which is what we want — we
    // settle the old one when it goes offline).
    const date = new Date().toISOString().slice(0, 10);
    const sessionLabel = `${ch.tag}-SESSION-${date}-${v.videoId.slice(0, 6)}`;

    // Default close: 12h from now. Continuous streams will get re-created
    // on the next go-live anyway; this is just the LP auto-refund safety.
    const closesAt = Math.floor(Date.now() / 1000) + 12 * 3600;

    // Create the EventHandle on-chain + register in ledger (idempotent —
    // handler swallows "already in use" so a relayer restart mid-session
    // just upserts the label and keeps prior graduation/volume state).
    const created = await this.createEvent({
      label: sessionLabel,
      category: "LiveStream" as EventCategory,
      closesAt,
    });

    console.log(`[StreamMonitor] ${ch.tag} session started: ${sessionLabel} (${v.videoId})`);
    console.log(`                title: ${v.title.slice(0, 80)}`);
    console.log(`                handle: ${created.handleIdHex.slice(0, 12)}…  pda: ${created.eventHandlePda}`);

    this.state.active[v.videoId] = {
      videoId: v.videoId,
      channelTag: ch.tag,
      channelId: ch.channelId,
      channelName: ch.name,
      title: v.title,
      handleIdHex: created.handleIdHex,
      startedAt: Math.floor(Date.now() / 1000),
    };

    // Seed the 5 generic prop markets via the injected hook. Player-aware
    // markets are added by the lineup extractor on day 3.
    for (const tpl of GENERIC_MARKETS) {
      const marketId = await this.deriveMarketId(sessionLabel, tpl.slug);
      const marketIdHex = marketId.toString("hex");
      try {
        await this.seedMarket(created.handleIdHex, marketIdHex, tpl.label(ch.tag));
      } catch (err: any) {
        console.warn(`[StreamMonitor] ${ch.tag} seed ${tpl.slug} failed: ${err.message}`);
      }
    }
  }

  private async deriveMarketId(sessionLabel: string, slug: string): Promise<Buffer> {
    const crypto = await import("crypto");
    return crypto.createHash("sha256").update(`${sessionLabel}/${slug}`).digest();
  }

  // ─── State persistence ─────────────────────────────────────────────

  private loadState(): SessionStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        return JSON.parse(raw) as SessionStore;
      }
    } catch (err) {
      console.warn("[StreamMonitor] State load failed:", err);
    }
    return { active: {}, lastPollAt: 0 };
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
