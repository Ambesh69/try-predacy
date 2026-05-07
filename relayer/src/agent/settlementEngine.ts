/**
 * Settlement Engine — turns SessionStats into on-chain market
 * resolutions. Closes the demo loop:
 *
 *   user bids YES on "Will BILL bust first?"
 *      → agent OCRs BILL going BUSTED
 *      → settlement engine sees firstBustAt set + bustedPlayers=[BILL]
 *      → resolves bust_first_BILL → YES (other bust_first_<player> → NO)
 *      → user calls redeem_outcome to swap winning YES tokens 1:1 for USDC
 *
 * Two trigger modes:
 *
 *   Live    — invoked after every recordSnapshot. Settles markets whose
 *             resolution condition is met right now (quads hit, royal
 *             flush hit, first bust, $500K pot, 10+ all-ins, early-bust
 *             time threshold). Idempotent — markets already resolved
 *             are skipped.
 *
 *   End     — invoked when a session formally ends (or on demand via
 *             the admin endpoint). Settles the leaderboard markets
 *             that need a final tally: most_hands, biggest_pot,
 *             bluff_most, h2h_*, plus any generics still UNRESOLVED
 *             (which means the condition never tripped → NO).
 *
 * Resolution outcomes: 1 = YES, 2 = NO (matches on-chain
 * resolve_market signature). The engine never mutates state — only
 * the EventLedger's resolutions Map and the on-chain Market account
 * via SolanaClient.resolveMarket.
 */

import type { SolanaClient } from "../solanaClient";
import type { EventLedger, EventHandleEntry } from "../eventLedger";
import type { SessionStats, SessionStatsRecord } from "./sessionStats";

export type Outcome = 1 | 2; // 1 = YES, 2 = NO

/** A parsed view of a market's template + parameters, derived from
 *  its label. Used to drive resolution without persisting kind/slug
 *  alongside marketLabels in the ledger. */
export type Classified =
  | { kind: "quads" }
  | { kind: "royal" }
  | { kind: "whale-pot"; thresholdUsd: number }
  | { kind: "early-bust"; minutes: number }
  | { kind: "ten-allins"; threshold: number }
  | { kind: "bluff-most"; player: string }
  | { kind: "bust-first"; player: string }
  | { kind: "biggest-pot"; player: string }
  | { kind: "most-hands"; player: string }
  | { kind: "h2h-bluff"; a: string; b: string }
  | { kind: "h2h-pot"; a: string; b: string }
  | { kind: "hand-winner"; player: string; handIdx: number }
  | null;

export function classifyMarketLabel(label: string): Classified {
  // ─── Generic templates ─────────────────────────────────────────────
  if (label === "Anyone hits quads tonight?") return { kind: "quads" };
  if (label === "Anyone hits a royal flush tonight?") return { kind: "royal" };
  let m = label.match(/^Will any pot exceed \$([0-9.]+)([KMk])\?\s*tonight\?$/)
    ?? label.match(/^Will any pot exceed \$([0-9.]+)([KMk])?\s*tonight\?$/);
  if (m) {
    const n = parseFloat(m[1]);
    const mult = m[2]?.toUpperCase() === "M" ? 1_000_000 : m[2]?.toUpperCase() === "K" ? 1_000 : 1;
    return { kind: "whale-pot", thresholdUsd: n * mult };
  }
  m = label.match(/^First player busts within (\d+) minutes\?$/);
  if (m) return { kind: "early-bust", minutes: parseInt(m[1], 10) };
  m = label.match(/^(\d+)\+ all-ins tonight\?$/);
  if (m) return { kind: "ten-allins", threshold: parseInt(m[1], 10) };

  // ─── Per-player templates ──────────────────────────────────────────
  m = label.match(/^Will (.+?) bluff the most this session\?$/);
  if (m) return { kind: "bluff-most", player: m[1].trim() };
  m = label.match(/^Will (.+?) bust first\?$/);
  if (m) return { kind: "bust-first", player: m[1].trim() };
  m = label.match(/^Will (.+?) win the biggest pot tonight\?$/);
  if (m) return { kind: "biggest-pot", player: m[1].trim() };
  m = label.match(/^Will (.+?) win the most hands tonight\?$/);
  if (m) return { kind: "most-hands", player: m[1].trim() };

  // ─── H2H templates ─────────────────────────────────────────────────
  m = label.match(/^Will (.+?) bluff more than (.+?) tonight\?$/);
  if (m) return { kind: "h2h-bluff", a: m[1].trim(), b: m[2].trim() };
  m = label.match(/^Will (.+?) win a bigger pot than (.+?) tonight\?$/);
  if (m) return { kind: "h2h-pot", a: m[1].trim(), b: m[2].trim() };

  // ─── Hand-level templates ──────────────────────────────────────────
  m = label.match(/^Will (.+?) win hand #(\d+)\?$/);
  if (m) return { kind: "hand-winner", player: m[1].trim(), handIdx: parseInt(m[2], 10) };

  return null;
}

const canon = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");

/** Token list for fuzzy name matching. Splits on whitespace +
 *  punctuation, lowercases + strips accents, drops 1-2 letter
 *  tokens (initials, particles like "de", "la") that match too
 *  aggressively. */
function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Fuzzy player-name match. The gameState OCR sees abbreviated/casual
 *  forms ("airball" instead of "NIK AIRBALL", "britney" instead of
 *  "BRITNEY", "phua" instead of "PAUL PHUA") while market labels
 *  carry the full lineup form. Strict canon() equality misses all of
 *  these and resolves real winners as NO across the board.
 *
 *  Match rules (any one is sufficient):
 *    1. canon equality                           ("BRITNEY" ≡ "britney")
 *    2. one canon-form is a substring of the other, length ≥ 3
 *                                                ("phua" ⊂ "paulphua")
 *    3. any 3+ char token from one name appears in the other's tokens
 *                                                ("AIRBALL" ∈ "NIK AIRBALL".tokens)
 *
 *  The 3-char floor is what stops "a" / "de" / "la" / "el" / "2" from
 *  collapsing the whole namespace to a single bucket. */
function nameMatch(a: string, b: string): boolean {
  const ca = canon(a);
  const cb = canon(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  if (ca.length >= 3 && cb.includes(ca)) return true;
  if (cb.length >= 3 && ca.includes(cb)) return true;
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const setB = new Set(tokensB);
  for (const t of tokensA) {
    if (setB.has(t)) return true;
  }
  return false;
}

/** Look up per-player stats with the same fuzzy name matching used by
 *  the resolution path. SessionStats keys players by `canon(name)` of
 *  whatever the OCR reported, which often differs from the market
 *  label's full name. Falls back to a direct canon lookup before the
 *  scan since that's the common case. */
function lookupPlayerStats(
  stats: SessionStatsRecord | undefined,
  player: string,
): SessionStatsRecord["players"][string] | undefined {
  if (!stats) return undefined;
  const direct = stats.players[canon(player)];
  if (direct) return direct;
  for (const [k, v] of Object.entries(stats.players)) {
    if (nameMatch(k, player)) return v;
  }
  return undefined;
}

export interface PendingResolution {
  marketIdHex: string;
  label: string;
  classified: Classified;
  outcome: Outcome;
  reason: string;
}

/** Pure function — given an EventHandle's markets and the current
 *  session stats (or absence thereof), return every market's
 *  computable resolution and the rationale. Caller decides whether
 *  to actually emit the on-chain tx. */
export function computeResolutions(
  ev: EventHandleEntry,
  stats: SessionStatsRecord | undefined,
  now: number,
  trigger: "live" | "end",
): PendingResolution[] {
  if (!ev.marketLabels) return [];
  const out: PendingResolution[] = [];
  const sessionStartedAt = stats?.startedAt ?? ev.registeredAt;

  // Per-template leaderboard winners (used by per-player resolutions).
  // Computed once per pass so we don't recompute for every player.
  let mostHandsWinner: string | null = null;
  let mostBluffsWinner: string | null = null;
  let biggestPotWinner: string | null = null;
  let bustFirstWinner: string | null = null;
  if (stats) {
    let maxHands = -1, maxBluffs = -1, maxPot = -1;
    let earliestBust = Number.POSITIVE_INFINITY;
    for (const [name, p] of Object.entries(stats.players)) {
      if (p.handsWon > maxHands) { maxHands = p.handsWon; mostHandsWinner = name; }
      if (p.bluffs > maxBluffs) { maxBluffs = p.bluffs; mostBluffsWinner = name; }
      if (p.biggestPotWonUsd > maxPot) { maxPot = p.biggestPotWonUsd; biggestPotWinner = name; }
      if (p.bustedAt !== null && p.bustedAt < earliestBust) {
        earliestBust = p.bustedAt;
        bustFirstWinner = name;
      }
    }
    // Tie-break / no-data: leaders only count when at least one event
    // actually fired. Without a single hand won we can't crown anyone.
    if (maxHands < 1) mostHandsWinner = null;
    if (maxBluffs < 1) mostBluffsWinner = null;
    if (maxPot < 1) biggestPotWinner = null;
  }

  for (const [marketIdHex, label] of Object.entries(ev.marketLabels)) {
    const c = classifyMarketLabel(label);
    if (!c) continue;
    // Hand-winner markets are settled by settleHand() with the actual
    // hand winner — they don't have a session-end fallback resolution
    // (an unresolved hand market just stays open forever, which is
    // fine since the hand never actually resolved on-stream).
    if (c.kind === "hand-winner") continue;

    const push = (outcome: Outcome, reason: string) => {
      out.push({ marketIdHex, label, classified: c, outcome, reason });
    };

    switch (c.kind) {
      case "quads": {
        if (stats?.quadsHit) push(1, "QUADS overlay observed");
        else if (trigger === "end") push(2, "session ended without quads");
        break;
      }
      case "royal": {
        if (stats?.royalFlushHit) push(1, "ROYAL FLUSH overlay observed");
        else if (trigger === "end") push(2, "session ended without royal flush");
        break;
      }
      case "whale-pot": {
        if (stats && stats.maxPotSoFar >= c.thresholdUsd) {
          push(1, `max pot $${stats.maxPotSoFar.toLocaleString()} ≥ threshold $${c.thresholdUsd.toLocaleString()}`);
        } else if (trigger === "end") {
          push(2, `session ended below threshold (max pot $${stats?.maxPotSoFar.toLocaleString() ?? "0"})`);
        }
        break;
      }
      case "early-bust": {
        const windowSec = c.minutes * 60;
        if (stats?.firstBustAt !== null && stats?.firstBustAt !== undefined) {
          const elapsed = stats.firstBustAt - sessionStartedAt;
          push(elapsed <= windowSec ? 1 : 2,
            `first bust at +${Math.round(elapsed / 60)}m (window: ${c.minutes}m)`);
        } else if (now - sessionStartedAt >= windowSec) {
          push(2, `${c.minutes} min elapsed without bust`);
        }
        break;
      }
      case "ten-allins": {
        if (stats && stats.allInsCount >= c.threshold) {
          push(1, `all-ins observed: ${stats.allInsCount} ≥ ${c.threshold}`);
        } else if (trigger === "end") {
          push(2, `session ended at ${stats?.allInsCount ?? 0} all-ins (need ${c.threshold})`);
        }
        break;
      }
      case "bluff-most": {
        // Live trigger doesn't fire — leaderboard only stable at end.
        if (trigger !== "end") break;
        if (!stats || mostBluffsWinner === null) {
          push(2, "session ended with no bluffs recorded");
        } else {
          push(nameMatch(c.player, mostBluffsWinner) ? 1 : 2,
            `most bluffs: ${mostBluffsWinner} (${stats.players[mostBluffsWinner]?.bluffs ?? 0})`);
        }
        break;
      }
      case "bust-first": {
        // Live trigger fires the moment the first bust is observed.
        if (stats?.firstBustAt && bustFirstWinner) {
          push(nameMatch(c.player, bustFirstWinner) ? 1 : 2,
            `first bust: ${bustFirstWinner}`);
        } else if (trigger === "end") {
          push(2, "session ended without busts");
        }
        break;
      }
      case "biggest-pot": {
        if (trigger !== "end") break;
        if (!stats || biggestPotWinner === null) {
          push(2, "session ended with no resolved pots");
        } else {
          push(nameMatch(c.player, biggestPotWinner) ? 1 : 2,
            `biggest pot: ${biggestPotWinner} ($${(stats.players[biggestPotWinner]?.biggestPotWonUsd ?? 0).toLocaleString()})`);
        }
        break;
      }
      case "most-hands": {
        if (trigger !== "end") break;
        if (!stats || mostHandsWinner === null) {
          push(2, "session ended with no hands resolved");
        } else {
          push(nameMatch(c.player, mostHandsWinner) ? 1 : 2,
            `most hands: ${mostHandsWinner} (${stats.players[mostHandsWinner]?.handsWon ?? 0})`);
        }
        break;
      }
      case "h2h-bluff": {
        if (trigger !== "end") break;
        const aB = lookupPlayerStats(stats, c.a)?.bluffs ?? 0;
        const bB = lookupPlayerStats(stats, c.b)?.bluffs ?? 0;
        push(aB > bB ? 1 : 2, `${c.a}=${aB} vs ${c.b}=${bB} bluffs`);
        break;
      }
      case "h2h-pot": {
        if (trigger !== "end") break;
        const aP = lookupPlayerStats(stats, c.a)?.biggestPotWonUsd ?? 0;
        const bP = lookupPlayerStats(stats, c.b)?.biggestPotWonUsd ?? 0;
        push(aP > bP ? 1 : 2, `${c.a}=$${aP.toLocaleString()} vs ${c.b}=$${bP.toLocaleString()} pots`);
        break;
      }
    }
  }
  return out;
}

export class SettlementEngine {
  private client: SolanaClient;
  private ledger: EventLedger;
  private stats: SessionStats;

  constructor(client: SolanaClient, ledger: EventLedger, stats: SessionStats) {
    this.client = client;
    this.ledger = ledger;
    this.stats = stats;
  }

  /** True when the EventLedger already records a resolution for this
   *  marketId under this handle. The ledger persists to disk, so this
   *  becomes the de-facto resolved-set across relayer restarts — no
   *  parallel in-memory Set to keep in sync, no MarketAlreadyResolved
   *  log noise on the first tick after a redeploy. */
  private isAlreadyResolved(handleHex: string, marketIdHex: string): boolean {
    const ev = this.ledger.get(handleHex);
    return !!ev?.resolutions?.[marketIdHex];
  }

  /** Live trigger — call after each gameState snapshot. Settles only
   *  event-driven markets (quads, royal, first bust, whale-pot
   *  threshold, etc.) where the condition is unambiguously met. */
  async settleLive(handleHex: string): Promise<PendingResolution[]> {
    return this.settle(handleHex, "live");
  }

  /** End trigger — call when a session ends (or on demand via the
   *  admin endpoint). Settles every still-UNRESOLVED market under
   *  the event using the final session stats. */
  async settleEnd(handleHex: string): Promise<PendingResolution[]> {
    return this.settle(handleHex, "end");
  }

  /** Settle every hand-winner market for a specific hand. Called
   *  immediately after the gameState OCR sees winnerPlayers populated
   *  while a hand is open. Winners get YES, everyone else (whose
   *  market exists for this handIdx) gets NO. Idempotent — already-
   *  resolved markets are skipped via the in-memory cache + the
   *  on-chain MarketAlreadyResolved guard.
   *
   *  Compares names via canon() so OCR casing/punctuation differences
   *  ("airball" vs "AIRBALL", "ST. WANG" vs "ST WANG") don't cause
   *  false NOs. */
  async settleHand(
    handleHex: string,
    handIdx: number,
    winners: string[],
  ): Promise<PendingResolution[]> {
    const ev = this.ledger.get(handleHex);
    if (!ev?.marketLabels) return [];
    const winnerKeys = new Set(winners.map((w) => canon(w)));
    const applied: PendingResolution[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (const [marketIdHex, label] of Object.entries(ev.marketLabels)) {
      const c = classifyMarketLabel(label);
      if (!c || c.kind !== "hand-winner" || c.handIdx !== handIdx) continue;
      // Use fuzzy matcher so OCR shortforms ("airball") collapse to
      // the market's full name ("NIK AIRBALL") just like the
      // session-level resolutions do.
      const isWinner = winners.some((w) => nameMatch(c.player, w));
      const outcome: Outcome = isWinner ? 1 : 2;
      const outcomeStr: "YES" | "NO" = isWinner ? "YES" : "NO";
      const reason = outcome === 1
        ? `won hand #${handIdx} (winners: ${winners.join(", ")})`
        : `lost hand #${handIdx} (winners: ${winners.join(", ")})`;
      const p: PendingResolution = {
        marketIdHex,
        label,
        classified: c,
        outcome,
        reason,
      };
      // Snapshot prior resolved-state before our own ledger write so
      // we don't short-circuit on first ever resolve of this market.
      const wasAlreadyResolved = this.isAlreadyResolved(handleHex, marketIdHex);
      try {
        this.ledger.setMarketResolution(handleHex, marketIdHex, outcomeStr);
      } catch { /* unknown handle */ }
      if (wasAlreadyResolved) continue;
      try {
        const marketIdBuf = Buffer.from(marketIdHex.replace(/^0x/, ""), "hex");
        await this.client.resolveMarket(marketIdBuf, outcome);
        console.log(
          `[Settlement] hand resolved ${marketIdHex.slice(0, 8)}… (${c.player} hand #${handIdx}) → ${outcomeStr} — ${reason}`,
        );
        applied.push(p);
      } catch (err: any) {
        const msg = String(err?.message || "");
        if (msg.includes("MarketAlreadyResolved") || msg.includes("already resolved")) {
          continue;
        }
        console.warn(`[Settlement] hand-winner ${marketIdHex.slice(0, 8)}… resolve failed: ${msg.slice(0, 160)}`);
      }
      void now;
    }
    return applied;
  }

  /** Dry-run — compute resolutions without sending any txs. Useful
   *  for the admin preview endpoint and for unit tests. */
  preview(handleHex: string, trigger: "live" | "end" = "end"): PendingResolution[] {
    const ev = this.ledger.get(handleHex);
    if (!ev) return [];
    const sessionLabel = ev.label ?? `event-${handleHex.slice(0, 8)}`;
    const stats = this.stats.get(sessionLabel);
    return computeResolutions(ev, stats, Math.floor(Date.now() / 1000), trigger);
  }

  private async settle(handleHex: string, trigger: "live" | "end"): Promise<PendingResolution[]> {
    const ev = this.ledger.get(handleHex);
    if (!ev) return [];
    const sessionLabel = ev.label ?? `event-${handleHex.slice(0, 8)}`;
    const stats = this.stats.get(sessionLabel);
    const now = Math.floor(Date.now() / 1000);
    const pending = computeResolutions(ev, stats, now, trigger);

    const applied: PendingResolution[] = [];
    for (const p of pending) {
      const outcomeStr: "YES" | "NO" = p.outcome === 1 ? "YES" : "NO";
      // Snapshot the prior resolved-state BEFORE writing the ledger;
      // otherwise our own setMarketResolution below makes
      // isAlreadyResolved() return true and we'd skip the on-chain
      // RPC the first time we ever see this market.
      const wasAlreadyResolved = this.isAlreadyResolved(handleHex, p.marketIdHex);

      // Always reflect the resolution into the EventLedger. Idempotent
      // thanks to setMarketResolution's prior-equals check. Also
      // back-fills cases where the ledger schema gained `resolutions`
      // after the on-chain settle already happened.
      try {
        this.ledger.setMarketResolution(handleHex, p.marketIdHex, outcomeStr);
      } catch { /* unknown handle — surfaced earlier */ }

      if (wasAlreadyResolved) continue;
      try {
        const marketIdBuf = Buffer.from(p.marketIdHex.replace(/^0x/, ""), "hex");
        await this.client.resolveMarket(marketIdBuf, p.outcome);
        console.log(
          `[Settlement] ${trigger} resolved ${p.marketIdHex.slice(0, 8)}… (${p.classified?.kind}) → ${outcomeStr} — ${p.reason}`,
        );
        applied.push(p);
      } catch (err: any) {
        const msg = String(err?.message || "");
        // Already resolved on-chain — silently move on. The ledger
        // write above already ran so the UI is up to date.
        if (msg.includes("MarketAlreadyResolved") || msg.includes("already resolved")) {
          continue;
        }
        console.warn(`[Settlement] ${p.marketIdHex.slice(0, 8)}… resolve failed: ${msg.slice(0, 160)}`);
      }
    }
    return applied;
  }
}

let instance: SettlementEngine | null = null;
export function getSettlementEngine(client: SolanaClient, ledger: EventLedger, stats: SessionStats): SettlementEngine {
  if (!instance) instance = new SettlementEngine(client, ledger, stats);
  return instance;
}
