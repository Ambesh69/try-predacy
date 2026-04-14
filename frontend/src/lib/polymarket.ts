import axios from "axios";

export interface Market {
  conditionId: string;
  question: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  volumeNum: number;
  active: boolean;
  closed: boolean;
  endDate: string;
  tokens: Array<{ token_id: string; outcome: string; price: string }>;
  clobTokenIds?: string[];
  image?: string;
  icon?: string;
  category?: string;
  tags?: string[];
  slug?: string;
  groupItemTitle?: string;
}

export interface PolyEvent {
  id: string;
  title: string;
  slug?: string;
  volume: string;
  volumeNum: number;
  active: boolean;
  closed: boolean;
  endDate: string;
  image?: string;
  icon?: string;
  category?: string;
  tags?: string[];
  markets: Market[];
}

function normalizeMarket(m: any): Market {
  const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    ...m,
    outcomePrices: parse(m.outcomePrices) ?? [],
    outcomes:      parse(m.outcomes)      ?? [],
    tokens:        parse(m.tokens)        ?? [],
    tags:          parse(m.tags)          ?? [],
    clobTokenIds:  parse(m.clobTokenIds)  ?? [],
  };
}

function normalizeEvent(e: any): PolyEvent {
  const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
  const rawTags: any[] = parse(e.tags) ?? [];
  const tags: string[] = rawTags.map((t: any) =>
    typeof t === "string" ? t : (t?.label ?? t?.id ?? String(t))
  );
  return {
    ...e,
    tags,
    category: e.category ?? (tags[0] || undefined),
    volumeNum: e.volumeNum != null ? Number(e.volumeNum) : parseFloat(String(e.volume ?? "0")) || 0,
    markets: (e.markets ?? []).map(normalizeMarket),
  };
}

export async function getMarkets(limit = 20): Promise<Market[]> {
  const res = await axios.get(`/api/markets`, { params: { limit } });
  return (res.data ?? []).map(normalizeMarket);
}

export async function getEvents(limit = 50): Promise<PolyEvent[]> {
  const res = await axios.get(`/api/events`, { params: { limit } });
  return (res.data ?? []).map(normalizeEvent);
}

export async function getMarket(conditionId: string): Promise<Market | null> {
  const res = await axios.get(`/api/markets`, {
    params: { condition_id: conditionId },
  });
  const raw = res.data?.[0] ?? null;
  return raw ? normalizeMarket(raw) : null;
}

export async function getMidPrice(tokenId: string): Promise<number> {
  const CLOB_API = "https://clob.polymarket.com";
  const res = await axios.get(`${CLOB_API}/midpoint`, {
    params: { token_id: tokenId },
  });
  return parseFloat(res.data?.mid ?? "0.5");
}

export async function getOrderBook(tokenId: string): Promise<{
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}> {
  const res = await axios.get(`/api/orderbook`, {
    params: { token_id: tokenId },
  });
  const bids = res.data?.bids ?? [];
  const asks = res.data?.asks ?? [];
  return {
    bids: bids.map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
    asks: asks.map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
  };
}

export const MOCK_MARKETS: Market[] = [
  {
    conditionId: "0x" + "a1b2c3d4".repeat(8),
    question: "Will the Fed cut rates in March 2026?",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.34", "0.66"],
    volume: "4821300",
    volumeNum: 4821300,
    active: true,
    closed: false,
    endDate: "2026-03-20T00:00:00Z",
    tokens: [
      { token_id: "0x" + "1".repeat(64), outcome: "Yes", price: "0.34" },
      { token_id: "0x" + "2".repeat(64), outcome: "No", price: "0.66" },
    ],
    category: "Politics",
    tags: ["Fed", "rates", "economics"],
  },
  {
    conditionId: "0x" + "e5f6a7b8".repeat(8),
    question: "Will ETH price exceed $5,000 by end of Q2 2026?",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.41", "0.59"],
    volume: "12440800",
    volumeNum: 12440800,
    active: true,
    closed: false,
    endDate: "2026-06-30T00:00:00Z",
    tokens: [
      { token_id: "0x" + "3".repeat(64), outcome: "Yes", price: "0.41" },
      { token_id: "0x" + "4".repeat(64), outcome: "No", price: "0.59" },
    ],
    category: "Crypto",
    tags: ["ETH", "Ethereum", "price"],
  },
  {
    conditionId: "0x" + "c9d0e1f2".repeat(8),
    question: "Will there be a US recession in 2026?",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.22", "0.78"],
    volume: "7391500",
    volumeNum: 7391500,
    active: true,
    closed: false,
    endDate: "2026-12-31T00:00:00Z",
    tokens: [
      { token_id: "0x" + "5".repeat(64), outcome: "Yes", price: "0.22" },
      { token_id: "0x" + "6".repeat(64), outcome: "No", price: "0.78" },
    ],
    category: "Economics",
    tags: ["recession", "US economy"],
  },
  {
    conditionId: "0x" + "12345678".repeat(8),
    question: "Will Bitcoin reach $150k in 2026?",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.58", "0.42"],
    volume: "31200000",
    volumeNum: 31200000,
    active: true,
    closed: false,
    endDate: "2026-12-31T00:00:00Z",
    tokens: [
      { token_id: "0x" + "7".repeat(64), outcome: "Yes", price: "0.58" },
      { token_id: "0x" + "8".repeat(64), outcome: "No", price: "0.42" },
    ],
    category: "Crypto",
    tags: ["BTC", "Bitcoin", "price"],
  },
];
