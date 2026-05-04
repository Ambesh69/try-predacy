/**
 * Game-State Extractor — pulls a single frame from a live stream and
 * extracts structured "what's happening on the table right now" state
 * via GPT-4o-mini vision.
 *
 * This is separate from the LineupExtractor (which answers "who's at
 * the table") because the cadence and reliability requirements differ:
 *
 *   LineupExtractor    → multi-frame sample, GPT-4o, slow + expensive,
 *                        runs once at session start + every 10 min.
 *   GameStateExtractor → single frame, GPT-4o-mini, fast + cheap,
 *                        runs every 5s while session is active.
 *
 * The state the extractor returns is the canonical input to the
 * sessionStats accumulator: each new state feeds into per-player
 * counters (bluffs, biggest pot, busts), and into hand-boundary
 * detection (cards reset → new hand starts).
 *
 * Cost target: GPT-4o-mini is ~33x cheaper than full 4o. At 5s cadence:
 *   720 calls/hr × ~$0.0001 ≈ $0.07/hr/session.
 *   For a 4hr Triton/HCL session, ~$0.30. Negligible.
 */

import { promises as fsp } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

const OPENAI_API = "https://api.openai.com/v1";
const MODEL = "gpt-4o-mini";
const FRAME_DIR = path.join(os.tmpdir(), "predacy-game-frames");

export interface GameState {
  /** Unix seconds when the frame was captured. */
  capturedAt: number;
  /** Pot size in USD as displayed on screen. null if no pot box visible
   *  (intermission, replay, between hands). */
  potUsd: number | null;
  /** Hand-strength badges currently visible on screen — broadcasters
   *  display "QUADS", "FULL HOUSE", "ROYAL FLUSH" etc. when a strong
   *  hand is revealed at showdown. Uppercase, normalised. */
  handStrengths: string[];
  /** Whether an "ALL IN" overlay is currently shown. */
  allInActive: boolean;
  /** Player name(s) declared the winner of the current hand, if a
   *  winner-overlay is on screen. Null if no winner shown. */
  winnerPlayers: string[];
  /** Player name(s) shown with a "BUSTED" / "OUT" overlay this frame. */
  bustedPlayers: string[];
  /** Player names visible with a nameplate (i.e., currently in the
   *  hand or recently shown). Used to track "who's still active." */
  inHandPlayers: string[];
  /** Number of community cards visible on the table. 0 = pre-flop or
   *  between hands, 3 = flop, 4 = turn, 5 = river. Used for street
   *  boundary detection. */
  boardCardCount: number;
  /** True if the frame shows a clear poker-table view (not intermission,
   *  sponsor reel, lobby, etc). Other fields are only meaningful when
   *  this is true. */
  tableView: boolean;
}

interface FailureRecord {
  failedAt: number;
  reason: "transient" | "persistent";
}

const TRANSIENT_BACKOFF_MS = 30_000;
const PERSISTENT_BACKOFF_MS = 15 * 60_000;

export class GameStateExtractor {
  private apiKey: string;
  private recentFailures: Map<string, FailureRecord> = new Map();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  get enabled(): boolean { return !!this.apiKey; }

  /** Capture one frame and OCR it. Returns null on failure (caller
   *  should treat as "no signal this tick" and try again next tick). */
  async snapshot(videoId: string): Promise<GameState | null> {
    if (!this.enabled) return null;

    const last = this.recentFailures.get(videoId);
    if (last) {
      const window = last.reason === "persistent" ? PERSISTENT_BACKOFF_MS : TRANSIENT_BACKOFF_MS;
      if (Date.now() - last.failedAt < window) return null;
      this.recentFailures.delete(videoId);
    }

    let framePath: string | null = null;
    try {
      framePath = await this.captureFrame(videoId);
      const state = await this.ocrState(framePath);
      return state;
    } catch (err: any) {
      const msg = String(err?.message || "");
      const persistent = /\b(401|403|429|insufficient_quota|invalid_api_key)\b/i.test(msg);
      this.recentFailures.set(videoId, {
        failedAt: Date.now(),
        reason: persistent ? "persistent" : "transient",
      });
      const minutes = (persistent ? PERSISTENT_BACKOFF_MS : TRANSIENT_BACKOFF_MS) / 60_000;
      console.warn(`[GameStateExtractor] ${videoId} snapshot failed (${persistent ? "persistent" : "transient"}, retry in ${minutes}m): ${msg.slice(0, 150)}`);
      return null;
    } finally {
      if (framePath) await fsp.unlink(framePath).catch(() => {});
    }
  }

  private async captureFrame(videoId: string): Promise<string> {
    await fsp.mkdir(FRAME_DIR, { recursive: true });
    const outPath = path.join(FRAME_DIR, `${videoId}-${Date.now()}.jpg`);
    const ytdlp = await execAsync(
      `yt-dlp -g -f "best[height<=720][protocol*=m3u8]/best[height<=720]" "https://www.youtube.com/watch?v=${videoId}"`,
      { timeout: 20_000 },
    );
    const streamUrl = ytdlp.stdout.trim().split("\n")[0];
    if (!streamUrl) throw new Error("yt-dlp returned no stream URL");
    await execAsync(
      `ffmpeg -y -loglevel error -i "${streamUrl}" -frames:v 1 -q:v 2 "${outPath}"`,
      { timeout: 30_000 },
    );
    const stat = await fsp.stat(outPath);
    if (stat.size === 0) throw new Error("ffmpeg produced empty frame");
    return outPath;
  }

  private async ocrState(framePath: string): Promise<GameState> {
    const buf = await fsp.readFile(framePath);
    const b64 = buf.toString("base64");

    const prompt = `You are looking at a screenshot from a live poker stream (likely Triton Poker or Hustler Casino Live). Extract the current game state.

Return ONLY valid JSON in this exact shape (no prose, no markdown fences):

{
  "tableView": true | false,
  "potUsd": number | null,
  "handStrengths": ["QUADS", "FULL HOUSE", ...],
  "allInActive": true | false,
  "winnerPlayers": ["NAME", ...],
  "bustedPlayers": ["NAME", ...],
  "inHandPlayers": ["NAME", ...],
  "boardCardCount": 0
}

Rules:
- "tableView" is false if the frame is a sponsor reel, lobby screen, intermission card, podcast/interview shot with no table visible, or a stream-offline screen. Other fields can be defaults in that case.
- "potUsd" is the pot size displayed in the pot box (usually bottom center, e.g. "$ 295,000" → 295000). Return null if no pot box is visible.
- "handStrengths" lists any hand-strength callouts currently overlaid on screen, normalised UPPERCASE. Examples: "QUADS", "FULL HOUSE", "FLUSH", "STRAIGHT", "TWO PAIR", "ROYAL FLUSH", "STRAIGHT FLUSH". Empty array if none.
- "allInActive" is true ONLY if an "ALL IN" overlay or badge is currently showing on a player tile or as a center text. Most frames will be false.
- "winnerPlayers" lists names with a "WINNER" badge or chip-collection animation pointing at them. Empty if no winner declared in this frame.
- "bustedPlayers" lists names with "BUSTED", "OUT", or "ELIMINATED" overlay. Empty otherwise.
- "inHandPlayers" lists every player nameplate visible on screen. These are the players currently in the hand (folded players' tiles disappear in pro broadcasts).
- "boardCardCount" is the number of community cards visible on the table felt. 0 = pre-flop or hand done, 3 = flop, 4 = turn, 5 = river.
- All player names should be exact text from nameplates, preserving case and accents.`;

    const res = await fetch(`${OPENAI_API}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "low" } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned empty content");

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (err: any) {
      throw new Error(`OpenAI response was not valid JSON: ${content.slice(0, 100)}`);
    }

    return {
      capturedAt: Math.floor(Date.now() / 1000),
      potUsd: typeof parsed.potUsd === "number" ? parsed.potUsd : null,
      handStrengths: Array.isArray(parsed.handStrengths)
        ? parsed.handStrengths.map((s: any) => String(s).trim().toUpperCase()).filter(Boolean)
        : [],
      allInActive: !!parsed.allInActive,
      winnerPlayers: Array.isArray(parsed.winnerPlayers)
        ? parsed.winnerPlayers.map((s: any) => String(s).trim()).filter(Boolean)
        : [],
      bustedPlayers: Array.isArray(parsed.bustedPlayers)
        ? parsed.bustedPlayers.map((s: any) => String(s).trim()).filter(Boolean)
        : [],
      inHandPlayers: Array.isArray(parsed.inHandPlayers)
        ? parsed.inHandPlayers.map((s: any) => String(s).trim()).filter(Boolean)
        : [],
      boardCardCount: typeof parsed.boardCardCount === "number"
        ? Math.max(0, Math.min(5, Math.round(parsed.boardCardCount)))
        : 0,
      tableView: !!parsed.tableView,
    };
  }
}
