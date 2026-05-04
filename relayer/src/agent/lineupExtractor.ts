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

  /** Run the full pipeline: pull a frame, OCR it, return Lineup. Returns
   *  null on hard failure (network down, video private, etc) — caller
   *  should retry on next tick rather than crash.
   *
   *  Honors a per-videoId backoff so we don't hammer OpenAI with the
   *  same failing request every poll. Backoff is longer for billing/auth
   *  failures than for transient network blips. */
  async extract(videoId: string): Promise<Lineup | null> {
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

    let framePath: string | null = null;
    try {
      framePath = await this.captureFrame(videoId);
      const lineup = await this.ocrFrame(framePath);
      return lineup;
    } catch (err: any) {
      const msg = String(err?.message || "");
      const persistent = /\b(401|403|429|insufficient_quota|invalid_api_key)\b/i.test(msg);
      const reason: FailureRecord["reason"] = persistent ? "persistent" : "transient";
      this.recentFailures.set(videoId, { failedAt: Date.now(), reason, message: msg });
      const minutes = (persistent ? PERSISTENT_BACKOFF_MS : TRANSIENT_BACKOFF_MS) / 60_000;
      console.error(`[LineupExtractor] extract(${videoId}) failed (${reason}, retrying in ${minutes}m): ${msg.slice(0, 200)}`);
      return null;
    } finally {
      if (framePath) {
        await fsp.unlink(framePath).catch(() => {});
      }
    }
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

    const prompt = `You are looking at a live poker stream screenshot. Extract the player nameplates visible at the table.

Return ONLY valid JSON in this exact shape (no prose, no markdown fences):

{
  "confident": true | false,
  "players": [
    {"seat": 1, "name": "Player Name"},
    ...
  ]
}

Rules:
- "confident" is true ONLY if you can clearly read at least 2 nameplates AND the screenshot shows an active poker table (not a thumbnail, intermission card, replay, sponsor reel, lobby screen, etc).
- If the screenshot is a title/intermission/replay/non-table view, return {"confident": false, "players": []}.
- "seat" is 1-based, ordered left-to-right as visible on screen. Use 0 if you cannot determine seat order.
- "name" is the exact text on the nameplate, including any case/accents. Don't add titles, country flags, or stack sizes.
- Skip dealer/admin nameplates if present.`;

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
