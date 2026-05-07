/**
 * Market Templates — given a session (channel + lineup), generate the
 * full set of prop markets to seed under that EventHandle.
 *
 * Two layers:
 *   - Generic session-level: 5 markets that don't depend on the lineup
 *     (quads hit?, royal flush?, big pot?, early bust?, 10+ all-ins?).
 *     These ship at session start before lineup is even captured, so
 *     traders can engage even if vision OCR hasn't run yet.
 *   - Player-aware: per-player and head-to-head markets instantiated
 *     once the lineup is known. These are the meat of the demo —
 *     "Will Hellmuth bluff most?", "Will Dwan vs Polk win bigger pot?".
 *
 * MarketIds are deterministic so re-running attachment is idempotent
 * and we don't accidentally double-create on-chain accounts:
 *   marketId = sha256(`${sessionLabel}/${slug}`)
 *
 * Player names are slugified (lowercase, no punctuation, spaces → "_")
 * before hashing so "Phil Hellmuth" and "phil  hellmuth" collide. This
 * lets a re-OCR with slight casing differences settle to the same
 * marketId rather than churning new ones.
 */

import * as crypto from "crypto";
import type { Player } from "./lineupExtractor";

export type ChannelTag = "TRITON" | "HCL";

export interface SeededMarket {
  /** Slug used to derive the marketId — also useful as a stable key for
   *  the settlement engine to look up which market to settle. */
  slug: string;
  /** Hex marketId (lowercase, no 0x prefix) — sha256(sessionLabel/slug). */
  marketIdHex: string;
  /** Human label that lands in eventLedger.marketLabels and on the UI card. */
  label: string;
  /** Categorisation for the settlement engine. */
  kind:
    | "generic-quads"
    | "generic-royal"
    | "generic-whale-pot"
    | "generic-early-bust"
    | "generic-allins"
    | "player-bluff-most"
    | "player-bust-first"
    | "player-biggest-pot"
    | "player-most-hands"
    | "h2h-bluff"
    | "h2h-pot"
    | "hand-winner";
  /** Empty for generic markets. Set to player name(s) for player-aware. */
  players?: string[];
}

// ─── Generic markets (session-level) ────────────────────────────────

interface GenericTemplate {
  slug: string;
  kind: SeededMarket["kind"];
  label: (channel: ChannelTag) => string;
}

const GENERIC_TEMPLATES: GenericTemplate[] = [
  {
    slug: "quads",
    kind: "generic-quads",
    label: () => "Anyone hits quads tonight?",
  },
  {
    slug: "royal",
    kind: "generic-royal",
    label: () => "Anyone hits a royal flush tonight?",
  },
  {
    slug: "whale_pot",
    kind: "generic-whale-pot",
    // Triton plays bigger than HCL on average, so different thresholds.
    label: (ch) => ch === "TRITON"
      ? "Will any pot exceed $500K tonight?"
      : "Will any pot exceed $200K tonight?",
  },
  {
    slug: "early_bust",
    kind: "generic-early-bust",
    label: () => "First player busts within 90 minutes?",
  },
  {
    slug: "ten_allins",
    kind: "generic-allins",
    label: () => "10+ all-ins tonight?",
  },
];

// ─── Player-aware templates ─────────────────────────────────────────

interface PlayerTemplate {
  slug: (player: string) => string;
  kind: SeededMarket["kind"];
  label: (player: string) => string;
}

const PLAYER_TEMPLATES: PlayerTemplate[] = [
  {
    slug: (p) => `bluff_most_${slugify(p)}`,
    kind: "player-bluff-most",
    label: (p) => `Will ${p} bluff the most this session?`,
  },
  {
    slug: (p) => `bust_first_${slugify(p)}`,
    kind: "player-bust-first",
    label: (p) => `Will ${p} bust first?`,
  },
  {
    slug: (p) => `biggest_pot_${slugify(p)}`,
    kind: "player-biggest-pot",
    label: (p) => `Will ${p} win the biggest pot tonight?`,
  },
  {
    slug: (p) => `most_hands_${slugify(p)}`,
    kind: "player-most-hands",
    label: (p) => `Will ${p} win the most hands tonight?`,
  },
];

interface HeadToHeadTemplate {
  slug: (a: string, b: string) => string;
  kind: SeededMarket["kind"];
  label: (a: string, b: string) => string;
}

const H2H_TEMPLATES: HeadToHeadTemplate[] = [
  {
    slug: (a, b) => `h2h_bluff_${slugify(a)}_vs_${slugify(b)}`,
    kind: "h2h-bluff",
    label: (a, b) => `Will ${a} bluff more than ${b} tonight?`,
  },
  {
    slug: (a, b) => `h2h_pot_${slugify(a)}_vs_${slugify(b)}`,
    kind: "h2h-pot",
    label: (a, b) => `Will ${a} win a bigger pot than ${b} tonight?`,
  },
];

// ─── Public API ──────────────────────────────────────────────────────

/** All markets for a session at start, before lineup is captured. Just
 *  the generic 5. Returned in seeding order — keep stable for clean
 *  on-chain create logs. */
export function genericMarketsFor(channel: ChannelTag, sessionLabel: string): SeededMarket[] {
  return GENERIC_TEMPLATES.map((t) => makeMarket({
    sessionLabel,
    slug: t.slug,
    label: t.label(channel),
    kind: t.kind,
  }));
}

/** All player-aware markets for a session given the captured lineup.
 *  Caller is expected to have already seeded the generic markets via
 *  genericMarketsFor — these layer on top.
 *
 *  For 6 players: 4 per-player templates × 6 = 24 player markets, plus
 *  a few head-to-heads between the most "interesting" pairs (top-billed
 *  seats, currently the first two seats; we'll get smarter once we have
 *  a notoriety/recency table to rank players by). */
export function playerMarketsFor(
  sessionLabel: string,
  players: Player[],
): SeededMarket[] {
  if (players.length === 0) return [];
  const out: SeededMarket[] = [];

  // Per-player markets — one of each template per player.
  for (const p of players) {
    for (const t of PLAYER_TEMPLATES) {
      out.push(makeMarket({
        sessionLabel,
        slug: t.slug(p.name),
        label: t.label(p.name),
        kind: t.kind,
        players: [p.name],
      }));
    }
  }

  // Head-to-head markets — the strongest demo content because of clean
  // PvP narrative + long settlement window. We seed up to 3 pairs by
  // pairing top vs bottom of the lineup (1-vs-N, 2-vs-(N-1), 3-vs-(N-2))
  // so we get diverse matchups instead of always 1-vs-2 by alphabetical
  // chance. Once we have a notoriety/recency table we'd pick known
  // rivalries (Hellmuth-vs-Polk, Dwan-vs-Antonius, etc.) but
  // top-vs-bottom gives reasonable spread today.
  for (const [a, b] of pickH2HPairs(players)) {
    for (const t of H2H_TEMPLATES) {
      out.push(makeMarket({
        sessionLabel,
        slug: t.slug(a.name, b.name),
        label: t.label(a.name, b.name),
        kind: t.kind,
        players: [a.name, b.name],
      }));
    }
  }

  return out;
}

/** Select up to 3 (a, b) pairs to seed as head-to-head markets. Pairs
 *  the i-th-from-front with the i-th-from-back so a 9-player table
 *  gets pairs (1,9), (2,8), (3,7) — diverse skill/notoriety mix
 *  rather than the alphabetical first two. With <2 players we return
 *  no pairs (no H2H to seed). With 2-3 players we return at most
 *  floor(N/2) pairs so we don't seed self-vs-self. */
function pickH2HPairs(players: Player[]): [Player, Player][] {
  if (players.length < 2) return [];
  const pairs: [Player, Player][] = [];
  const maxPairs = Math.min(3, Math.floor(players.length / 2));
  for (let i = 0; i < maxPairs; i++) {
    const a = players[i];
    const b = players[players.length - 1 - i];
    if (a === b) break;
    pairs.push([a, b]);
  }
  return pairs;
}

/** Hand-level real-time markets — seeded the moment a new hand starts
 *  (gameState OCR shows pre-flop → flop transition) for the top 2
 *  in-hand players (the closest-to-the-action seats — typically the
 *  players in a heads-up showdown post-flop). Settles the moment a
 *  winner is declared on screen.
 *
 *  Cap of 2 markets/hand keeps the cost bounded: at ~50 hands/hr that's
 *  ~100 markets/hr on devnet rent (~2 SOL/hr) — sustainable across a
 *  multi-hour demo with the relayer's standard 5 SOL faucet drip. The
 *  prior 5-player cap was 5 SOL/hr which burned through faucet drops
 *  too quickly to leave room for the rest of the agent's writes.
 *
 *  Less coverage means heads-up showdowns get markets but multi-way
 *  pots only seed for 2 of N players. The settlement engine still
 *  marks the seeded markets as YES/NO based on canon-name match
 *  against winnerPlayers — players who actually won but had no market
 *  seeded simply don't pay out (same behavior as session-end leaders
 *  who weren't in the lineup at start).
 *
 *  The slug bakes in handIdx so each hand creates fresh markets
 *  rather than colliding with prior hands' settled markets. */
export function handLevelMarketsFor(
  sessionLabel: string,
  handIdx: number,
  inHandPlayers: Player[],
): SeededMarket[] {
  const players = inHandPlayers.slice(0, 2);
  return players.map((p) =>
    makeMarket({
      sessionLabel,
      slug: `hand_${handIdx}_${slugify(p.name)}`,
      label: `Will ${p.name} win hand #${handIdx}?`,
      kind: "hand-winner",
      players: [p.name],
    }),
  );
}

/** Markets to add when a NEW player sits down mid-session (option A from
 *  the architecture decision). Doesn't disturb existing markets — just
 *  adds the per-player set for the new entrant. Head-to-heads are
 *  intentionally not added retroactively — they were defined at session
 *  start with the original lineup, and changing the H2H pair mid-session
 *  would muddy settlement. */
export function newEntrantMarketsFor(
  sessionLabel: string,
  newPlayer: Player,
): SeededMarket[] {
  return PLAYER_TEMPLATES.map((t) => makeMarket({
    sessionLabel,
    slug: t.slug(newPlayer.name),
    label: t.label(newPlayer.name),
    kind: t.kind,
    players: [newPlayer.name],
  }));
}

// ─── Internals ──────────────────────────────────────────────────────

function makeMarket(args: {
  sessionLabel: string;
  slug: string;
  label: string;
  kind: SeededMarket["kind"];
  players?: string[];
}): SeededMarket {
  const marketIdHex = crypto
    .createHash("sha256")
    .update(`${args.sessionLabel}/${args.slug}`)
    .digest("hex");
  return {
    slug: args.slug,
    marketIdHex,
    label: args.label,
    kind: args.kind,
    players: args.players,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
