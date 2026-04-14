import type { Market } from "@/lib/polymarket";

const ANON_PLACEHOLDER = /^Individual\s+[A-Z]$/i;

export function outcomeLabel(m: Market): string {
  if (m.groupItemTitle) return m.groupItemTitle;
  return m.question
    .replace(/^Will\s+/i, "")
    .replace(/\s+as\s+the\s+next\s+.*\?$/i, "?")
    .replace(/\s+win\s+.*\?$/i, "?")
    .replace(/\s+become\s+.*\?$/i, "?");
}

export function filterAndDeduplicateMarkets(markets: Market[]): Market[] {
  const active = markets.filter((m) => {
    if (m.closed === true) return false;
    const label = (m.groupItemTitle ?? m.question ?? "").trim();
    if (ANON_PLACEHOLDER.test(label)) return false;
    const yp  = parseFloat(m.outcomePrices?.[0] ?? "0");
    const np  = parseFloat(m.outcomePrices?.[1] ?? "0");
    const vol = m.volumeNum || parseFloat(m.volume ?? "0");
    if (yp === 0 && np === 0 && vol === 0) return false;
    return true;
  });

  const seen = new Map<string, Market>();
  for (const m of active) {
    const key  = outcomeLabel(m).trim().toLowerCase();
    const prev = seen.get(key);
    if (!prev) { seen.set(key, m); continue; }
    const prevVol = prev.volumeNum || parseFloat(prev.volume ?? "0");
    const curVol  = m.volumeNum    || parseFloat(m.volume    ?? "0");
    if (
      curVol > prevVol ||
      (curVol === prevVol &&
        parseFloat(m.outcomePrices?.[0] ?? "0") >
        parseFloat(prev.outcomePrices?.[0] ?? "0"))
    ) {
      seen.set(key, m);
    }
  }
  return Array.from(seen.values());
}

export function fmtPct(p: number): string {
  if (!isFinite(p) || p <= 0) return "<1%";
  const pct = Math.round(p * 100);
  if (pct < 1)  return "<1%";
  if (pct > 99) return ">99%";
  return `${pct}%`;
}

export function fmtCents(p: number): string {
  const c = p * 100;
  if (c <= 0)     return "0¢";
  if (c >= 99.95) return "100¢";
  return `${c.toFixed(1)}¢`;
}
