"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { clsx } from "clsx";
import {
  type EventDescriptor,
  formatUsdc6,
  getEvent,
  relativeTime,
} from "@/lib/lpApi";
import { OrderForm } from "@/components/OrderForm";
const WalletButton = dynamic(() => import("@/components/WalletButton"), { ssr: false });
const HeaderBalance = dynamic(() => import("@/components/HeaderBalance"), { ssr: false });

interface Props {
  params: Promise<{ handleId: string }>;
}

export default function PredacyEventDetail({ params }: Props) {
  const { handleId } = use(params);
  const [event, setEvent] = useState<EventDescriptor | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const ev = await getEvent(handleId).catch(() => null);
      if (!cancelled) setEvent(ev);
    }
    load();
    return () => { cancelled = true; };
  }, [handleId]);

  if (event === undefined) {
    return <PageShell><CenteredNotice>Loading event…</CenteredNotice></PageShell>;
  }
  if (event === null) {
    return (
      <PageShell>
        <CenteredNotice>
          Event handle <code className="text-accent font-mono">{handleId.slice(0, 12)}…</code> not registered.{" "}
          <Link href="/" className="text-accent hover:underline">Back to markets</Link>
        </CenteredNotice>
      </PageShell>
    );
  }

  const closesIn = event.closesAt - Math.floor(Date.now() / 1000);
  const isExpired = closesIn <= 0;
  const display = event.label ?? `Event ${event.handleId.slice(0, 8)}…`;

  return (
    <PageShell>
      <section className="border-b border-card-border bg-bg-elevated">
        <div className="max-w-7xl mx-auto px-4 py-8 flex flex-col md:flex-row md:items-end md:justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Link href="/" className="text-[11px] text-muted hover:text-text tracking-widest uppercase">
                ← Markets
              </Link>
              <span className="text-muted-dim">·</span>
              <span className="text-[11px] tracking-widest uppercase text-accent">Predacy event</span>
            </div>
            <h1 className="text-[28px] md:text-[36px] font-bold text-text font-mono">
              {display}
            </h1>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <Tag>{event.category}</Tag>
              {event.graduated ? (
                <Tag variant="accent">TIER 1 ACTIVE</Tag>
              ) : (
                <Tag variant="muted">PRE-GRAD</Tag>
              )}
              <span className={clsx(
                "text-[11px]",
                isExpired ? "text-danger" : "text-muted",
              )}>
                {isExpired ? "Closed" : `Closes ${relativeTime(event.closesAt)}`}
              </span>
            </div>
          </div>
          <Link
            href="/lp"
            className="border border-accent text-accent px-4 py-2.5 text-[11px] tracking-widest uppercase font-bold hover:bg-accent/5 transition-colors self-start md:self-end"
          >
            Provide Liquidity →
          </Link>
        </div>
      </section>

      <main className="max-w-7xl mx-auto px-4 py-8 space-y-8">
        {(!event.marketIds || event.marketIds.length === 0) ? (
          <div className="border border-card-border bg-card p-6 text-center">
            <p className="text-[13px] text-text">No markets attached to this event yet.</p>
            <p className="text-[11px] text-muted-dim mt-2 max-w-md mx-auto">
              An operator can attach Polymarket-mirrored markets via the relayer&apos;s{" "}
              <code className="text-accent">POST /events/{event.handleId.slice(0, 8)}…/markets</code>{" "}
              endpoint. Once attached, takers can trade under this event&apos;s sealed-bid batch auction.
            </p>
          </div>
        ) : (
          <FeaturedAndRest event={event} />
        )}
      </main>
    </PageShell>
  );
}

function FeaturedAndRest({ event }: { event: EventDescriptor }) {
  const groups = groupMarkets(event);
  // Promote the canonical "most_hands" group to the featured slot when
  // present — most universally interesting across both Triton (cash
  // game) and HCL (streamer showdown). Falls back to the first multi-
  // outcome group if most_hands isn't available, then to nothing if
  // the event only has binaries.
  const featured =
    groups.find((g): g is MultiOutcomeGroup => g.kind === "multi" && g.templateKey === "most_hands")
    ?? groups.find((g): g is MultiOutcomeGroup => g.kind === "multi");
  const restGroups = groups.filter((g) => g !== featured);

  return (
    <>
      {featured && <FeaturedMultiOutcome group={featured} event={event} />}
      <section className="grid lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-4">
          <SectionHeader>
            More markets <span className="text-muted-dim ml-1">({restGroups.length})</span>
          </SectionHeader>
          <RestOfMarkets groups={restGroups} />
        </div>
        <EventSidebar event={event} />
      </section>
    </>
  );
}

function RestOfMarkets({ groups }: { groups: Group[] }) {
  const multis = groups.filter((g): g is MultiOutcomeGroup => g.kind === "multi");
  const binaries = groups.filter((g): g is BinaryGroup => g.kind === "binary");
  if (multis.length === 0 && binaries.length === 0) {
    return (
      <p className="text-[11px] text-muted-dim italic">All markets surfaced above.</p>
    );
  }
  return (
    <div className="space-y-3">
      {multis.map((g) => (
        <MultiOutcomeMarket key={`m-${g.templateKey}`} group={g} />
      ))}
      {binaries.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {binaries.map(({ market }) => (
            <MarketCard key={market.marketId} marketId={market.marketId} label={market.label} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventSidebar({ event }: { event: EventDescriptor }) {
  return (
    <aside className="space-y-4">
      <SectionHeader>Event parameters</SectionHeader>
      <div className="border border-card-border bg-card p-4 space-y-3 text-[11px]">
        <ParamRow
          label="Cumulative volume"
          value={`$${formatUsdc6(event.cumulativeVolumeUsdc, 2)}`}
        />
        <ParamRow label="Taker fee" value={`${event.feeBpsTaker / 100}%`} />
        <ParamRow
          label="Fee split"
          value={`${event.feeBpsTreasury / 100}% treasury · ${event.feeBpsRebates / 100}% rebates`}
        />
        <ParamRow
          label="Graduation gate"
          value={`$${formatUsdc6(event.graduationThresholdUsdc, 0)} × ${event.graduationBatches}`}
          hint={event.graduated
            ? "Tier 1 backstop active — LP vault absorbs residual"
            : "Pre-grad — Tier 0 LMSR fills cold-start"}
        />
        <ParamRow
          label="Bootstrap seed"
          value={`$${formatUsdc6(event.bootstrapSeedUsdc, 0)}`}
        />
        <ParamRow
          label="Handle id"
          value={event.handleId.slice(0, 16) + "…"}
          monospace
        />
      </div>

      <SectionHeader>How it works</SectionHeader>
      <div className="border border-card-border bg-card-elevated p-4 text-[10px] text-muted leading-snug space-y-1.5">
        <p><span className="text-accent">·</span> Each market under this event clears in 30s sealed-bid batches.</p>
        <p><span className="text-accent">·</span> Taker fees feed the per-event rebate pool ({event.feeBpsRebates / 100}% slice).</p>
        <p><span className="text-accent">·</span> LP capital absorbs residual imbalance after pair-matching.</p>
        <p><span className="text-accent">·</span> Blind LP keeps individual deposits FHE-encrypted on-chain.</p>
      </div>
    </aside>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-text font-mono">
      <header className="border-b border-card-border">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-[14px] tracking-widest uppercase font-bold text-accent">
              Predacy
            </Link>
            <nav className="flex items-center gap-4 text-[11px] tracking-widest uppercase">
              <Link href="/" className="text-muted hover:text-text transition-colors">
                Markets
              </Link>
              <Link href="/lp" className="text-muted hover:text-text transition-colors">
                Liquidity
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <HeaderBalance />
            <WalletButton />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-16 text-center text-[13px] text-muted">
      {children}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] tracking-widest uppercase text-accent">
      {children}
    </p>
  );
}

function Tag({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "accent" | "muted";
}) {
  return (
    <span className={clsx(
      "text-[10px] tracking-widest uppercase border px-2 py-0.5",
      variant === "accent" && "border-accent/30 text-accent bg-accent/5",
      variant === "muted" && "border-border-bright text-muted-dim",
      variant === "default" && "border-border-bright text-muted bg-surface/70",
    )}>
      {children}
    </span>
  );
}

function ParamRow({
  label,
  value,
  hint,
  monospace,
}: {
  label: string;
  value: string;
  hint?: string;
  monospace?: boolean;
}) {
  return (
    <div>
      <p className="text-[9px] tracking-widest uppercase text-muted">{label}</p>
      <p className={clsx("text-text mt-0.5", monospace && "font-mono")}>{value}</p>
      {hint && <p className="text-[9px] text-muted-dim mt-0.5 leading-snug">{hint}</p>}
    </div>
  );
}

/* ── Multi-outcome grouping ──────────────────────────────────────────
 *
 *  The agent seeds 4 templates per player ("Will <X> bluff the most this
 *  session?", etc.). Rendered as N separate binary cards that read like
 *  spam. Group by template instead — one card titled "Who bluffs the
 *  most this session?" with each player as an outcome, à la Polymarket
 *  multi-outcome markets.
 *
 *  Implementation note: each underlying on-chain market is still a
 *  binary YES/NO market (one per player). The grouping is purely a UI
 *  presentation. Clicking an outcome takes you to that player's
 *  binary market for sealed-bid YES placement — buying YES on
 *  player X means betting "X wins this template".
 *
 *  H2H and generic markets stay as their own binary cards (already
 *  pairwise / single-outcome by design). */

interface MarketEntry {
  marketId: string;
  label: string;
}

interface MultiOutcomeGroup {
  kind: "multi";
  templateKey: "bluff_most" | "bust_first" | "biggest_pot" | "most_hands";
  title: string;
  outcomes: { marketId: string; player: string }[];
}

interface BinaryGroup {
  kind: "binary";
  market: MarketEntry;
}

type Group = MultiOutcomeGroup | BinaryGroup;

const TEMPLATE_TITLES: Record<MultiOutcomeGroup["templateKey"], string> = {
  bluff_most: "Who bluffs the most this session?",
  bust_first: "Who busts first?",
  biggest_pot: "Who wins the biggest pot tonight?",
  most_hands: "Who wins the most hands tonight?",
};

const TEMPLATE_PATTERNS: { key: MultiOutcomeGroup["templateKey"]; rx: RegExp }[] = [
  { key: "bluff_most",  rx: /^Will (.+?) bluff the most this session\?$/ },
  { key: "bust_first",  rx: /^Will (.+?) bust first\?$/ },
  { key: "biggest_pot", rx: /^Will (.+?) win the biggest pot tonight\?$/ },
  { key: "most_hands",  rx: /^Will (.+?) win the most hands tonight\?$/ },
];

function groupMarkets(event: EventDescriptor): Group[] {
  const labels = event.marketLabels ?? {};
  const ids = event.marketIds ?? [];
  const buckets = new Map<MultiOutcomeGroup["templateKey"], MultiOutcomeGroup["outcomes"]>();
  const binary: BinaryGroup[] = [];

  for (const id of ids) {
    const label = labels[id];
    if (!label) {
      binary.push({ kind: "binary", market: { marketId: id, label: `Market ${id.slice(0, 8)}…` } });
      continue;
    }
    let matched = false;
    for (const { key, rx } of TEMPLATE_PATTERNS) {
      const m = label.match(rx);
      if (!m) continue;
      const player = m[1].trim();
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({ marketId: id, player });
      matched = true;
      break;
    }
    if (!matched) {
      binary.push({ kind: "binary", market: { marketId: id, label } });
    }
  }

  // Order: multi-outcome groups in template-priority order, then binaries.
  const out: Group[] = [];
  const order: MultiOutcomeGroup["templateKey"][] = ["most_hands", "biggest_pot", "bluff_most", "bust_first"];
  for (const key of order) {
    const outcomes = buckets.get(key);
    if (!outcomes || outcomes.length < 2) {
      // Don't promote a 1-outcome group — fall back to a binary card so
      // we don't render an awkward "1-outcome multi" card.
      if (outcomes && outcomes.length === 1) {
        const o = outcomes[0];
        binary.push({
          kind: "binary",
          market: {
            marketId: o.marketId,
            label: labels[o.marketId] ?? TEMPLATE_TITLES[key],
          },
        });
      }
      continue;
    }
    out.push({
      kind: "multi",
      templateKey: key,
      title: TEMPLATE_TITLES[key],
      // Sort outcomes alphabetically for now — once price data is
      // available, sort descending by implied probability so the
      // favourite leads the list.
      outcomes: [...outcomes].sort((a, b) => a.player.localeCompare(b.player)),
    });
  }
  return [...out, ...binary];
}

/* ── Featured (image-3-style) multi-outcome with chart + order panel ─ */

function FeaturedMultiOutcome({
  group,
  event,
}: {
  group: MultiOutcomeGroup;
  event: EventDescriptor;
}) {
  // Selected outcome — drives both the order form and the highlight in
  // the outcomes list. Defaults to the first outcome since prices are
  // uniform (1/N) until the first batch clears.
  const [selectedId, setSelectedId] = useState<string>(group.outcomes[0].marketId);
  const selected = group.outcomes.find((o) => o.marketId === selectedId) ?? group.outcomes[0];
  const n = group.outcomes.length;
  const uniformPct = 100 / n;
  const yesPrice = uniformPct / 100;
  const noPrice = 1 - yesPrice;

  return (
    <section className="border border-card-border bg-card-elevated">
      {/* Top header row — title + meta tags. Matches image 3's
          "Tag · Ends X · Total vol" header. */}
      <div className="px-5 py-4 border-b border-card-border flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[10px] tracking-widest uppercase text-accent mb-1">
            Featured market · {n} outcomes
          </p>
          <h2 className="text-[18px] md:text-[20px] font-bold text-text leading-tight">
            {group.title}
          </h2>
        </div>
        <div className="text-right">
          <p className="text-[10px] tracking-widest uppercase text-muted-dim">Cumulative volume</p>
          <p className="text-[14px] tabular-nums text-text font-mono">
            ${formatUsdc6(event.cumulativeVolumeUsdc, 0)}
          </p>
        </div>
      </div>

      {/* Selected-outcome status line — matches image 3's "SELECTED X · Y% chance · YES Z¢ NO W¢" */}
      <div className="px-5 py-3 border-b border-card-border flex items-center gap-3 flex-wrap text-[11px]">
        <span className="text-muted tracking-widest uppercase">Selected</span>
        <span className="text-text font-mono font-bold">{selected.player}</span>
        <span className="text-muted-dim">·</span>
        <span className="text-accent tabular-nums">{Math.round(uniformPct)}% chance</span>
        <span className="text-muted-dim">·</span>
        <span className="tabular-nums" style={{ color: "#52F0D3" }}>
          YES {Math.round(uniformPct)}¢
        </span>
        <span className="tabular-nums" style={{ color: "#FF7683" }}>
          NO {100 - Math.round(uniformPct)}¢
        </span>
      </div>

      <div className="grid lg:grid-cols-[1fr_360px]">
        {/* Left column — placeholder chart (no historical data yet) +
            outcomes list. Once we accumulate batch-clear price history
            this becomes a real recharts/lightweight-charts panel. */}
        <div className="p-5 lg:border-r border-card-border space-y-4">
          <FlatChartPlaceholder selectedColor="#4EA3FF" />
          <FeaturedOutcomeList
            group={group}
            uniformPct={uniformPct}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>

        {/* Right column — sealed-bid order panel scoped to the selected
            outcome's binary market. OrderForm handles its own state but
            requires Privy context (no-ops gracefully when not
            configured, e.g. local dev without NEXT_PUBLIC_PRIVY_APP_ID). */}
        <aside className="p-5 bg-card">
          <PrivyGatedOrderForm
            // Re-mount on outcome switch so OrderForm's internal phase
            // state resets cleanly (otherwise a partially-prepared order
            // would carry across the outcome change).
            key={selected.marketId}
            marketId={selected.marketId}
            marketQuestion={`Will ${selected.player} ${humanLabelFor(group.templateKey)}?`}
            yesPrice={yesPrice}
            noPrice={noPrice}
          />
        </aside>
      </div>
    </section>
  );
}

/** Wraps OrderForm so it only renders when Privy is configured. Without
 *  this guard the underlying useSolanaWallets() hook reads .connectors
 *  on a null context and crashes the entire page (Privy returns null
 *  outside a PrivyProvider). The same guard would help the existing
 *  /market/predacy/<id> page if it surfaced this fallback there too. */
function PrivyGatedOrderForm(props: {
  marketId: string;
  marketQuestion: string;
  yesPrice: number;
  noPrice: number;
}) {
  const privyConfigured = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!privyConfigured) {
    return (
      <div className="text-[11px] text-muted-dim leading-snug space-y-2">
        <p className="text-[11px] tracking-widest uppercase text-accent">Place a sealed bid</p>
        <p>
          Wallet connection isn&apos;t configured in this environment.
          Set <code className="text-accent">NEXT_PUBLIC_PRIVY_APP_ID</code> to enable
          the order panel.
        </p>
      </div>
    );
  }
  return <OrderForm {...props} />;
}

function humanLabelFor(key: MultiOutcomeGroup["templateKey"]): string {
  switch (key) {
    case "bluff_most":  return "bluff the most this session";
    case "bust_first":  return "bust first";
    case "biggest_pot": return "win the biggest pot tonight";
    case "most_hands":  return "win the most hands tonight";
  }
}

function FlatChartPlaceholder({ selectedColor }: { selectedColor: string }) {
  // Until we have historical price data from settled batches, the chart
  // would just be a flat line at the uniform prior. Surface this honestly
  // rather than rendering empty axes — the message becomes a feature
  // ("price history starts after first batch") and the panel still has
  // visual weight in the layout.
  return (
    <div className="relative border border-card-border bg-card h-[180px] md:h-[220px] flex items-center justify-center overflow-hidden">
      {/* faint grid suggesting future chart */}
      <div className="absolute inset-0 opacity-30" style={{
        backgroundImage: `linear-gradient(${selectedColor}11 1px, transparent 1px), linear-gradient(90deg, ${selectedColor}11 1px, transparent 1px)`,
        backgroundSize: "32px 32px",
      }} />
      <div className="relative text-center">
        <p className="text-[11px] tracking-widest uppercase text-accent">Live price history</p>
        <p className="text-[10px] text-muted-dim mt-1">starts after the first sealed batch clears</p>
      </div>
    </div>
  );
}

function FeaturedOutcomeList({
  group,
  uniformPct,
  selectedId,
  onSelect,
}: {
  group: MultiOutcomeGroup;
  uniformPct: number;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const pctRounded = Math.round(uniformPct);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">{group.outcomes.length} outcomes</p>
        <p className="text-[10px] text-muted-dim">click to select</p>
      </div>
      <div className="border border-card-border">
        {group.outcomes.map(({ marketId, player }, idx) => {
          const isSelected = marketId === selectedId;
          return (
            <button
              type="button"
              key={marketId}
              onClick={() => onSelect(marketId)}
              className={clsx(
                "w-full grid grid-cols-[24px_1fr_auto_auto_auto] items-center gap-3 px-3 py-2 text-left transition-colors",
                idx > 0 && "border-t border-card-border",
                isSelected ? "bg-accent/[0.08]" : "hover:bg-card-elevated",
              )}
            >
              <span className={clsx(
                "text-[10px] tabular-nums",
                isSelected ? "text-accent" : "text-muted-dim",
              )}>
                {idx + 1}
              </span>
              <span className={clsx(
                "text-[12px] font-mono truncate",
                isSelected ? "text-text font-bold" : "text-text",
              )}>
                {player}
              </span>
              <div className="hidden md:block w-[100px] h-[2px] bg-border rounded-full overflow-hidden">
                <div
                  className="h-full"
                  style={{ width: `${Math.max(2, uniformPct)}%`, background: isSelected ? "#4EA3FF" : "#4EA3FF99" }}
                />
              </div>
              <span className={clsx(
                "text-[12px] tabular-nums w-[36px] text-right font-bold",
              )} style={{ color: isSelected ? "#4EA3FF" : "#4EA3FFAA" }}>
                {pctRounded}%
              </span>
              <div className="flex items-center gap-1">
                <span
                  className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums"
                  style={{ borderColor: "#2CE8C655", color: "#52F0D3", background: "#2CE8C612" }}
                >
                  YES {pctRounded}¢
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums"
                  style={{ borderColor: "#FF5F6D55", color: "#FF7683", background: "#FF5F6D12" }}
                >
                  NO {100 - pctRounded}¢
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MultiOutcomeMarket({ group }: { group: MultiOutcomeGroup }) {
  const [expanded, setExpanded] = useState(false);
  const n = group.outcomes.length;
  // Predacy-native markets default to 50/50 priors — actual prices
  // emerge from the first sealed-bid batch. We display a uniform prior
  // (1/N) across outcomes until live price data lands.
  const uniformPct = 100 / n;
  const VISIBLE_DEFAULT = 4;
  const visible = expanded ? group.outcomes : group.outcomes.slice(0, VISIBLE_DEFAULT);
  const hiddenCount = n - VISIBLE_DEFAULT;

  return (
    <div className="border border-card-border bg-card p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[15px] text-text leading-snug font-bold">{group.title}</h3>
        <span className="text-[10px] text-muted-dim tabular-nums shrink-0 mt-1">
          {n} outcomes
        </span>
      </div>
      <div className="flex flex-col">
        {visible.map(({ marketId, player }) => (
          <OutcomeRow
            key={marketId}
            marketId={marketId}
            player={player}
            pct={uniformPct}
          />
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-[11px] text-muted-dim hover:text-accent transition-colors text-left tracking-wider"
        >
          {expanded ? "show less" : `+${hiddenCount} more outcome${hiddenCount === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}

function OutcomeRow({
  marketId,
  player,
  pct,
}: {
  marketId: string;
  player: string;
  pct: number;
}) {
  const pctRounded = Math.round(pct);
  // Bar tint biased to red→amber→green by likelihood, like image 2.
  const barColor =
    pct < 10 ? "#FF5F6D" : pct < 25 ? "#F7B500" : pct < 50 ? "#4EA3FF" : "#2CE8C6";
  const pctColor =
    pct < 10 ? "#FF7683" : pct < 25 ? "#F7B500" : pct < 50 ? "#4EA3FF" : "#52F0D3";
  return (
    <Link
      href={`/market/predacy/${marketId}`}
      className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-1.5 group"
    >
      <span className="text-[13px] text-text font-mono group-hover:text-accent transition-colors truncate">
        {player}
      </span>
      <div className="w-[160px] h-[3px] bg-border rounded-full overflow-hidden">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${Math.max(2, pct)}%`, background: barColor }}
        />
      </div>
      <span className="text-[13px] tabular-nums font-bold w-[40px] text-right" style={{ color: pctColor }}>
        {pctRounded}%
      </span>
    </Link>
  );
}

function MarketCard({ marketId, label }: { marketId: string; label?: string }) {
  // Predacy-native markets default to a 50/50 prior — the actual price
  // emerges from the first sealed-bid batch, not from a Polymarket lookup.
  const display = label ?? `Market ${marketId.slice(0, 8)}…`;

  return (
    <Link href={`/market/predacy/${marketId}`} className="block">
      <div className="border border-card-border bg-card p-4 hover:border-border-bright transition-colors flex flex-col gap-3 cursor-crosshair h-full">
        <h3 className="text-[13px] text-text leading-snug line-clamp-3">
          {display}
        </h3>
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-1">
            <span
              className="text-2xl font-black tabular-nums leading-none"
              style={{ fontFamily: "var(--font-display)", color: "#4EA3FF" }}
            >
              50%
            </span>
            <span className="text-[9px] text-muted tracking-widest uppercase">implied</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums" style={{ borderColor: "#2CE8C655", color: "#52F0D3", background: "#2CE8C612" }}>YES 50¢</span>
            <span className="text-[10px] px-1.5 py-0.5 border font-mono tabular-nums" style={{ borderColor: "#FF5F6D55", color: "#FF7683", background: "#FF5F6D12" }}>NO 50¢</span>
          </div>
        </div>
        <div className="h-[2px] bg-border rounded-full overflow-hidden">
          <div className="h-full transition-all duration-500" style={{ width: "50%", background: "#4EA3FF" }} />
        </div>
        <div className="text-[10px] text-muted-dim tracking-widest uppercase">
          Place sealed bid →
        </div>
      </div>
    </Link>
  );
}
