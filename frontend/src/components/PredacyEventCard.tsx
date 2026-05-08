"use client";

import Link from "next/link";
import { clsx } from "clsx";
import { type EventDescriptor, formatUsdc6, relativeTime } from "@/lib/lpApi";

interface Props {
  event: EventDescriptor;
}

const CHANNEL_DISPLAY: Record<string, { name: string; subtitle: string }> = {
  TRITON: { name: "Triton Poker", subtitle: "Cash Game Invitational" },
  HCL: { name: "Hustler Casino Live", subtitle: "Streamer Showdown" },
};

/** Pull the channel tag (TRITON / HCL / etc.) off the front of a session
 *  label like "TRITON-SESSION-2026-05-04-7783281c", or the manual seed
 *  format "TRITON-2026-05-04". Returns null for non-stream events. */
function parseLabel(label?: string | null): { channel: string | null } {
  if (!label) return { channel: null };
  const m = label.match(/^([A-Z]+)-/);
  return { channel: m?.[1] ?? null };
}

/** Pull unique player names out of marketLabels by stripping the
 *  "Will <NAME> bluff the most…" / "Will <NAME> bust first?" prefixes.
 *  Used as the fallback display when the event has no recognised
 *  template-grouped markets yet (lineup-only state). */
function playersFromMarketLabels(labels: Record<string, string> | undefined): string[] {
  if (!labels) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lbl of Object.values(labels)) {
    let m = lbl.match(/^Will (.+?) bluff the most this session\?$/);
    if (!m) m = lbl.match(/^Will (.+?) bust first\?$/);
    if (!m) continue;
    const name = m[1].trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/* ── Featured-market grouping ─────────────────────────────────────────
 *
 *  Mirrors the `groupMarkets` logic in PredacyEventDetail.tsx, narrowed
 *  to picking the single best card-preview group: the newest hand-level
 *  group if any (LIVE trading window), otherwise the highest-priority
 *  session-level template that has ≥2 outcomes. Returns null if neither
 *  a multi-outcome group nor a binary fallback is available — caller
 *  shows the lineup string instead.
 */

type SessionTemplateKey = "bluff_most" | "bust_first" | "biggest_pot" | "most_hands";

interface FeaturedGroup {
  /** Headline shown above the outcomes (e.g., "Who wins hand #42?"). */
  title: string;
  /** Tag pill rendered top-right of the group block. "LIVE · HAND #N"
   *  for hand-level groups, the template's display tag for session ones. */
  tag: string;
  /** Whether this group is the live hand-level betting window — drives
   *  the pulsing accent + "LIVE" badge. */
  isLive: boolean;
  outcomes: { marketId: string; player: string }[];
}

const TEMPLATE_PATTERNS: { key: SessionTemplateKey; rx: RegExp; title: string; tag: string }[] = [
  { key: "most_hands",  rx: /^Will (.+?) win the most hands tonight\?$/,  title: "Who wins the most hands tonight?",   tag: "MOST HANDS" },
  { key: "biggest_pot", rx: /^Will (.+?) win the biggest pot tonight\?$/, title: "Who wins the biggest pot tonight?",  tag: "BIGGEST POT" },
  { key: "bluff_most",  rx: /^Will (.+?) bluff the most this session\?$/, title: "Who bluffs the most this session?",  tag: "BLUFF MOST" },
  { key: "bust_first",  rx: /^Will (.+?) bust first\?$/,                  title: "Who busts first?",                   tag: "BUST FIRST" },
];

const HAND_PATTERN = /^Will (.+?) win hand #(\d+)\?$/;

function pickFeaturedGroup(event: EventDescriptor): FeaturedGroup | null {
  const labels = event.marketLabels ?? {};
  const ids = event.marketIds ?? Object.keys(labels);
  if (ids.length === 0) return null;

  const handBuckets = new Map<number, { marketId: string; player: string }[]>();
  const sessionBuckets = new Map<SessionTemplateKey, { marketId: string; player: string }[]>();

  for (const id of ids) {
    const label = labels[id];
    if (!label) continue;
    const handMatch = label.match(HAND_PATTERN);
    if (handMatch) {
      const player = handMatch[1].trim();
      const handIdx = parseInt(handMatch[2], 10);
      const arr = handBuckets.get(handIdx) ?? [];
      arr.push({ marketId: id, player });
      handBuckets.set(handIdx, arr);
      continue;
    }
    for (const { key, rx } of TEMPLATE_PATTERNS) {
      const m = label.match(rx);
      if (!m) continue;
      const player = m[1].trim();
      const arr = sessionBuckets.get(key) ?? [];
      arr.push({ marketId: id, player });
      sessionBuckets.set(key, arr);
      break;
    }
  }

  // Newest active hand (highest handIdx) — the live trading window
  // judges and traders care most about. Even a single-outcome hand
  // group surfaces here since the narrative makes sense.
  const handIdxs = [...handBuckets.keys()].sort((a, b) => b - a);
  if (handIdxs.length > 0) {
    const handIdx = handIdxs[0];
    const outcomes = handBuckets.get(handIdx)!;
    return {
      title: `Who wins hand #${handIdx}?`,
      tag: `LIVE · HAND #${handIdx}`,
      isLive: true,
      outcomes: [...outcomes].sort((a, b) => a.player.localeCompare(b.player)),
    };
  }

  // Session-level group, in priority order. Skip groups with <2
  // outcomes — a 1-outcome "multi" card looks broken.
  for (const { key, title, tag } of TEMPLATE_PATTERNS) {
    const outcomes = sessionBuckets.get(key);
    if (!outcomes || outcomes.length < 2) continue;
    return {
      title,
      tag,
      isLive: false,
      outcomes: [...outcomes].sort((a, b) => a.player.localeCompare(b.player)),
    };
  }
  return null;
}

export default function PredacyEventCard({ event }: Props) {
  const closesIn = event.closesAt - Math.floor(Date.now() / 1000);
  const isClosingSoon = closesIn > 0 && closesIn < 86400;
  const isExpired = closesIn <= 0;

  const { channel } = parseLabel(event.label);
  const channelInfo = channel ? CHANNEL_DISPLAY[channel] : undefined;
  const featured = pickFeaturedGroup(event);
  const lineupPlayers = playersFromMarketLabels(event.marketLabels);

  // Title: stream-friendly name when we recognise the channel; otherwise
  // fall back to the label itself (still better than the hash).
  const title = channelInfo?.name ?? event.label ?? `Event ${event.handleId.slice(0, 8)}…`;
  const subtitle = channelInfo?.subtitle ?? null;

  // Resolution overlay — when ALL outcomes in the featured group have
  // resolved, show the winner badge in place of the bars.
  const resolutions = event.resolutions ?? {};
  const featuredAllResolved = featured?.outcomes.every((o) => resolutions[o.marketId]) ?? false;
  const featuredWinner = featured?.outcomes.find((o) => resolutions[o.marketId] === "YES");

  return (
    <Link href={`/event/predacy/${event.handleId}`} className="block h-full">
      <div className={clsx(
        "market-card border bg-surface p-5 cursor-crosshair flex flex-col gap-3 h-full",
        event.graduated
          ? "border-accent/60 shadow-[0_0_0_1px_rgba(44,232,198,0.2),0_12px_28px_rgba(8,20,30,0.35)]"
          : featured?.isLive
            ? "border-accent/40 shadow-[0_0_0_1px_rgba(44,232,198,0.14)]"
            : "border-border",
      )}>
        <div className="flex items-center gap-2 flex-wrap">
          {event.graduated ? (
            <span className="flex items-center gap-1 text-[10px] text-accent tracking-widest uppercase border border-accent/30 px-2 py-0.5 bg-accent/5">
              <span className="w-1 h-1 rounded-full bg-accent animate-pulse inline-block" /> TIER 1 ACTIVE
            </span>
          ) : (
            <span className="text-[10px] text-muted-dim tracking-widest uppercase border border-border-bright px-2 py-0.5">
              PRE-GRAD
            </span>
          )}
          <span className="text-[10px] text-muted tracking-widest uppercase border border-border-bright bg-surface/70 px-2 py-0.5">
            {event.category}
          </span>
          <span className={clsx(
            "text-[10px] ml-auto",
            isExpired ? "text-danger" : isClosingSoon ? "text-warning" : "text-muted",
          )}>
            {isExpired ? "Closed" : `Closes ${relativeTime(event.closesAt)}`}
          </span>
        </div>

        <div>
          <h3 className="text-text text-base leading-snug font-bold">
            {title}
          </h3>
          {subtitle && (
            <p className="text-[11px] text-muted mt-0.5">{subtitle}</p>
          )}
        </div>

        {/* Featured market preview — polymarket-style. Replaces the
            lineup-list when the agent has seeded recognisable template
            markets; falls back to the lineup display otherwise. */}
        {featured ? (
          <FeaturedPreview
            featured={featured}
            totalMarkets={event.marketCount}
            allResolved={featuredAllResolved}
            winnerPlayer={featuredWinner?.player ?? null}
          />
        ) : lineupPlayers.length > 0 ? (
          <div className="text-[11px] text-muted-dim leading-snug">
            <span className="text-accent">{lineupPlayers.length} player{lineupPlayers.length === 1 ? "" : "s"}:</span>{" "}
            <span className="text-muted">
              {lineupPlayers.slice(0, 4).join(", ")}
              {lineupPlayers.length > 4 && `, +${lineupPlayers.length - 4} more`}
            </span>
          </div>
        ) : (
          <p className="text-[11px] text-muted-dim italic">Waiting on agent lineup…</p>
        )}

        <div className="grid grid-cols-3 gap-2 pt-1">
          <Stat
            label="Markets"
            value={String(event.marketCount)}
          />
          <Stat
            label="Volume"
            value={`$${formatUsdc6(event.cumulativeVolumeUsdc, 0)}`}
          />
          <Stat
            label="Taker fee"
            value={`${event.feeBpsTaker / 100}%`}
          />
        </div>

        <div className="h-[2px] bg-border rounded-full mt-auto" />

        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-dim font-mono">
            {event.handleId.slice(0, 8)}…
          </span>
          <span className="flex items-center gap-1 text-[10px] text-accent tracking-widest uppercase">
            Open <span className="text-accent">→</span>
          </span>
        </div>
      </div>
    </Link>
  );
}

/* ── Featured preview block ─────────────────────────────────────────── */

const VISIBLE_OUTCOMES = 3;
const ACCENT_COLOR = "#4EA3FF";

function FeaturedPreview({
  featured,
  totalMarkets,
  allResolved,
  winnerPlayer,
}: {
  featured: FeaturedGroup;
  totalMarkets: number;
  allResolved: boolean;
  winnerPlayer: string | null;
}) {
  const n = featured.outcomes.length;
  const uniformPct = 100 / n;
  const pctRounded = Math.round(uniformPct);
  const visible = featured.outcomes.slice(0, VISIBLE_OUTCOMES);
  const moreInGroup = Math.max(0, n - visible.length);
  const otherMarkets = Math.max(0, totalMarkets - n);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={clsx(
          "text-[9px] tracking-widest uppercase px-2 py-0.5 border",
          featured.isLive
            ? "text-accent border-accent/40 bg-accent/5"
            : "text-muted border-border-bright bg-surface/70",
        )}>
          {featured.isLive && (
            <span className="inline-block w-1 h-1 rounded-full bg-accent animate-pulse mr-1.5 align-middle" />
          )}
          {featured.tag}
        </span>
        {allResolved && (
          <span className="text-[9px] tracking-widest uppercase text-accent ml-auto">
            Resolved · {winnerPlayer ?? "—"}
          </span>
        )}
      </div>

      <p className="text-[12px] text-text/90 leading-snug">{featured.title}</p>

      {/* Outcome rows. Uniform distribution since LMSR live odds aren't
          available client-side without an extra fetch — same convention
          PredacyEventDetail's PolymarketCard uses. */}
      <div className="flex flex-col gap-1">
        {visible.map(({ marketId, player }) => (
          <div
            key={marketId}
            className="grid grid-cols-[1fr_60px_28px] items-center gap-2 text-[11px]"
          >
            <span className="font-mono truncate text-text/80">{player}</span>
            <div className="h-[2px] bg-border rounded-full overflow-hidden">
              <div
                className="h-full"
                style={{ width: `${Math.max(2, uniformPct)}%`, background: ACCENT_COLOR }}
              />
            </div>
            <span className="tabular-nums text-right font-bold text-[11px]" style={{ color: ACCENT_COLOR }}>
              {pctRounded}%
            </span>
          </div>
        ))}
      </div>

      {(moreInGroup > 0 || otherMarkets > 0) && (
        <p className="text-[10px] text-muted-dim mt-0.5">
          {moreInGroup > 0 && `+${moreInGroup} more outcome${moreInGroup === 1 ? "" : "s"}`}
          {moreInGroup > 0 && otherMarkets > 0 && " · "}
          {otherMarkets > 0 && `${otherMarkets} more market${otherMarkets === 1 ? "" : "s"}`}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] tracking-widest uppercase text-muted">{label}</p>
      <p className="text-text text-[13px] font-mono tabular-nums mt-0.5">{value}</p>
    </div>
  );
}
