/**
 * Lineup Extractor — given a live YouTube videoId, returns the players
 * currently visible at the table.
 *
 * Pipeline:
 *   1. yt-dlp resolves the videoId to a current HLS manifest URL
 *      (the public /watch page just returns a player iframe; yt-dlp
 *      parses player_response to find the actual HLS endpoint).
 *   2. ffmpeg pulls a single keyframe from the HLS stream and writes
 *      it as a JPEG to /tmp.
 *   3. The JPEG is base64-encoded and sent to GPT-4o vision with a
 *      prompt asking for the player nameplates.
 *   4. Response is parsed into a structured Lineup.
 *
 * Why GPT-4V over Tesseract: poker-stream nameplates are stylized
 * (gradient backgrounds, custom fonts, sometimes country flags) and
 * Tesseract chokes on them. GPT-4o has no trouble. Cost is ~$0.003
 * per call at detail=high — negligible for our cadence (one extraction
 * at session start + every 10 min for lineup-change detection).
 */

import { promises as fsp } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const execAsync = promisify(exec);

const OPENAI_API = "https://api.openai.com/v1";
const VISION_MODEL = "gpt-4o";
const FRAME_DIR = path.join(os.tmpdir(), "predacy-frames");

export interface Player {
  /** Seat index, 1-based, left-to-right or by-clock as visible on screen.
   *  May be 0 if GPT-4o couldn't determine seat order. */
  seat: number;
  /** Player name as read from the nameplate. Unicode-safe. */
  name: string;
}

export interface Lineup {
  /** Sorted by seat ascending. Empty if extraction failed. */
  players: Player[];
  /** Source frame timestamp (unix seconds) — useful for log correlation. */
  capturedAt: number;
  /** Whether the extractor was confident about the read. False usually
   *  means the stream was on a thumbnail, intermission, or replay. */
  confident: boolean;
  /** Stable hash over `seat:name` pairs. Two captures with the same
   *  hash mean the lineup hasn't changed (so no need to spawn a new
   *  session, attach new markets, etc). */
  hash: string;
}

// Backoff windows for repeated extract failures. Two regimes:
//   - "transient" (network blip, ffmpeg flake) — 90s backoff
//   - "persistent" (HTTP 401/403/429/quota) — 15min backoff so we don't
//     hammer OpenAI with rejected calls when billing is misconfigured
const TRANSIENT_BACKOFF_MS = 90_000;
const PERSISTENT_BACKOFF_MS = 15 * 60_000;

// Multi-frame sampling. Pro-poker broadcasts only overlay nameplates for
// the players currently IN the hand (folded players' tiles disappear).
// A single frame catches 1-3 names; the broadcast cycles to a wide-
// angle "table view" with 6+ visible nameplates roughly once per ~60-
// 90s. We need a long enough window to catch at least one wide-angle.
//
// Empirical result on Triton Cash Game Invitational I:
//   4 × 12s ( 48s) → 1-2 players (single hand only)
//   8 × 15s (120s) → 6 players (catches wide-angle shot)
//  12 × 15s (180s) → 6-9 players (catches wide-angle reliably for HCL too)
//
// HCL Streamer Showdown cycles wide-angles less often than Triton — 8
// frames was hitting heads-up moments only and undercounting the table
// at 4 players. 12 frames closes that gap.
//
// Cost: 12 × $0.003 = $0.036 per extraction. Negligible vs. value.
const DEFAULT_NUM_FRAMES = 12;
const DEFAULT_INTERVAL_SEC = 15;

interface FailureRecord {
  failedAt: number;
  reason: "transient" | "persistent";
  message: string;
}

export class LineupExtractor {
  private apiKey: string;
  private recentFailures: Map<string, FailureRecord> = new Map();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  /** Clear the failure-backoff for a specific videoId, or all videos when
   *  called with no arg. Used by admin force-refresh: an operator wants a
   *  fresh extraction RIGHT NOW even if a transient/persistent failure
   *  was cached on a recent attempt. */
  clearFailures(videoId?: string): void {
    if (videoId) this.recentFailures.delete(videoId);
    else this.recentFailures.clear();
  }

  /** Run the full pipeline: sample multiple frames over a window, OCR
   *  each, union the player names found, return Lineup. Returns null
   *  on hard failure (network down, video private, persistent OpenAI
   *  quota issue) — caller should retry on next tick rather than crash.
   *
   *  Why multi-frame: broadcaster overlays only show players currently
   *  in the hand. Sampling 4 frames over ~48s catches 4 different hand
   *  groupings, which together usually cover the full 6-9 player table.
   *
   *  Honors a per-videoId backoff so we don't hammer OpenAI with the
   *  same failing request every poll. Backoff is longer for billing/auth
   *  failures than for transient network blips. */
  async extract(videoId: string, opts?: { numFrames?: number; intervalSec?: number }): Promise<Lineup | null> {
    if (!this.enabled) {
      console.warn("[LineupExtractor] OPENAI_API_KEY not set — extractor disabled");
      return null;
    }

    const last = this.recentFailures.get(videoId);
    if (last) {
      const window = last.reason === "persistent" ? PERSISTENT_BACKOFF_MS : TRANSIENT_BACKOFF_MS;
      const elapsed = Date.now() - last.failedAt;
      if (elapsed < window) {
        // Quietly skip — caller already saw the original error logged.
        return null;
      }
      // Backoff window elapsed; give it another shot.
      this.recentFailures.delete(videoId);
    }

    const numFrames = opts?.numFrames ?? DEFAULT_NUM_FRAMES;
    const intervalSec = opts?.intervalSec ?? DEFAULT_INTERVAL_SEC;

    // Map keyed by lowercase name so different OCR captures of the same
    // player (slight casing variations) collapse to one entry. We keep
    // the seat from the *first* frame that saw them, since seat indices
    // shift between hands and the first one is good enough as a label.
    const aggregated = new Map<string, Player>();
    let anyConfident = false;
    let framesAttempted = 0;
    let framesSucceeded = 0;
    const t0 = Date.now();

    for (let i = 0; i < numFrames; i++) {
      framesAttempted++;
      let framePath: string | null = null;
      try {
        framePath = await this.captureFrame(videoId);
        const single = await this.ocrFrame(framePath);
        framesSucceeded++;
        if (single.confident) anyConfident = true;
        for (const p of single.players) {
          const key = p.name.toLowerCase();
          if (!aggregated.has(key)) aggregated.set(key, p);
        }
        console.log(`[LineupExtractor] ${videoId} frame ${i + 1}/${numFrames}: ${single.players.length} player(s) (confident=${single.confident}); union=${aggregated.size}`);
      } catch (err: any) {
        const msg = String(err?.message || "");
        const persistent = /\b(401|403|429|insufficient_quota|invalid_api_key)\b/i.test(msg);
        if (persistent) {
          // Bail out of the whole sampling pass — billing/auth issues
          // won't resolve mid-loop and we'd just rack up more rejected
          // requests. Surface the failure to the caller via backoff.
          this.recentFailures.set(videoId, { failedAt: Date.now(), reason: "persistent", message: msg });
          console.error(`[LineupExtractor] extract(${videoId}) persistent failure on frame ${i + 1}, retrying in ${PERSISTENT_BACKOFF_MS / 60_000}m: ${msg.slice(0, 200)}`);
          return null;
        }
        // Transient — log and continue with the remaining frames.
        console.warn(`[LineupExtractor] ${videoId} frame ${i + 1}/${numFrames} skipped (transient): ${msg.slice(0, 150)}`);
      } finally {
        if (framePath) await fsp.unlink(framePath).catch(() => {});
      }

      // Sleep between frames so we sample a meaningful temporal window.
      // Skip the trailing sleep on the last iteration.
      if (i < numFrames - 1) {
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
      }
    }

    if (framesSucceeded === 0) {
      this.recentFailures.set(videoId, {
        failedAt: Date.now(),
        reason: "transient",
        message: `no successful frames out of ${framesAttempted}`,
      });
      console.error(`[LineupExtractor] extract(${videoId}) all ${framesAttempted} frames failed`);
      return null;
    }

    // Re-number seats 1..N in name order so downstream marketTemplates
    // gets stable indices regardless of which frame surfaced each player.
    const players = Array.from(aggregated.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p, idx) => ({ ...p, seat: idx + 1 }));

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[LineupExtractor] ${videoId} extracted ${players.length} unique players across ${framesSucceeded}/${framesAttempted} frames in ${elapsed}s`);

    return {
      players,
      capturedAt: Math.floor(Date.now() / 1000),
      // Confident if any single frame was confident AND we got at least
      // one name. The union may grow further on subsequent extractions —
      // streamMonitor's recheckLineup folds in new names over time.
      confident: anyConfident && players.length >= 1,
      hash: lineupHash(players),
    };
  }

  // ─── Step 1+2: yt-dlp + ffmpeg ──────────────────────────────────────

  private async captureFrame(videoId: string): Promise<string> {
    await fsp.mkdir(FRAME_DIR, { recursive: true });
    const outPath = path.join(FRAME_DIR, `${videoId}-${Date.now()}.jpg`);

    // yt-dlp -g returns the direct media URL. -f selects a 720p-or-lower
    // stream so we don't burn bandwidth on 4K — the nameplates render
    // fine at 720p and GPT-4o doesn't gain accuracy from higher res
    // (it scales internally anyway).
    const ytdlp = await execAsync(
      `yt-dlp -g -f "best[height<=720][protocol*=m3u8]/best[height<=720]" "https://www.youtube.com/watch?v=${videoId}"`,
      { timeout: 20_000 },
    );
    const streamUrl = ytdlp.stdout.trim().split("\n")[0];
    if (!streamUrl) throw new Error("yt-dlp returned no stream URL");

    // -ss 0 seeks to the live edge, -frames:v 1 grabs one frame.
    // -y overwrites silently. -loglevel error keeps the output quiet.
    await execAsync(
      `ffmpeg -y -loglevel error -i "${streamUrl}" -frames:v 1 -q:v 2 "${outPath}"`,
      { timeout: 30_000 },
    );

    const stat = await fsp.stat(outPath);
    if (stat.size === 0) throw new Error("ffmpeg produced empty frame");

    return outPath;
  }

  // ─── Step 3+4: GPT-4o vision ────────────────────────────────────────

  private async ocrFrame(framePath: string): Promise<Lineup> {
    const buf = await fsp.readFile(framePath);
    const b64 = buf.toString("base64");

    const prompt = `You are looking at a live poker stream screenshot. Find EVERY player nameplate visible — text overlays near each player's chip stack and hole cards.

Return ONLY valid JSON in this exact shape (no prose, no markdown fences):

{
  "confident": true | false,
  "players": [
    {"seat": 1, "name": "Player Name"},
    ...
  ]
}

Rules:
- Return EVERY visible nameplate. Don't gate-keep — partial reads from heads-up action shots are useful.
- Two distinct shot types to handle:
    1) ACTION SHOT (heads-up / 3-handed): only the players in the current hand have nameplates visible, usually anchored at bottom-left + bottom-right. Expect 1-3 names.
    2) WIDE-ANGLE TABLE SHOT (overhead or perimeter view): you can see the full table felt with 5-9 nameplates arranged around the perimeter — top, sides, bottom. SCAN ALL EDGES of the frame, not just the bottom. Expect 5-9 names. Pro broadcasts (Triton, Hustler Casino Live, GG Poker, PokerGO) typically render each nameplate as a small chip-stack tile near each seat.
- If you see a wide-angle / overhead shot, exhaustively enumerate every seat — do not stop at 4. Hustler Casino Live and Triton tables seat up to 9 players.
- "confident" is true if you can clearly read AT LEAST ONE nameplate AND the screenshot is from an active poker session (not a sponsor reel, lobby screen, blank intermission card, or replay-stat overlay with no table visible). A partial table view counts.
- If the frame is purely a title card, sponsor logo, or commercial break with no poker table visible at all, return {"confident": false, "players": []}.
- "seat" is 1-based, left-to-right or clockwise from bottom-left as visible. Use 0 if you can't tell.
- "name" is the exact nameplate text — preserve casing and accents. Don't add titles, country flags, chip stacks, or dollar amounts.
- Skip dealer/admin/host nameplates if their role is obvious (e.g., labelled "DEALER", "HOST"). Otherwise include any name you can read.`;

    const res = await fetch(`${OPENAI_API}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 500,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
              },
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

    let parsed: { confident?: boolean; players?: Player[] };
    try {
      parsed = JSON.parse(content);
    } catch (err: any) {
      throw new Error(`OpenAI response was not valid JSON: ${content.slice(0, 100)}`);
    }

    const players = (parsed.players ?? [])
      .filter((p) => p?.name && typeof p.name === "string")
      .map((p) => ({ seat: Number(p.seat) || 0, name: p.name.trim() }))
      .sort((a, b) => a.seat - b.seat);

    return {
      players,
      capturedAt: Math.floor(Date.now() / 1000),
      confident: !!parsed.confident && players.length >= 2,
      hash: lineupHash(players),
    };
  }
}

/** Stable hash over a lineup so we can compare across captures. The same
 *  set of players in the same seats always produces the same hash, even
 *  if the JSON ordering varies. */
export function lineupHash(players: Player[]): string {
  if (players.length === 0) return "empty";
  const canonical = [...players]
    .sort((a, b) => (a.seat - b.seat) || a.name.localeCompare(b.name))
    .map((p) => `${p.seat}:${p.name.toLowerCase()}`)
    .join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
