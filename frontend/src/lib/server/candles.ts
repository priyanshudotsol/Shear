// SERVER-ONLY. Postgres-backed (via Prisma) store for ratio OHLC candles, served by /api/candles.
// Never import this from client code — it pulls the Prisma client. The /api/candles route is the
// only consumer. Postgres runs locally via docker-compose.yml; schema in prisma/schema.prisma.
import { prisma } from "./prisma";

export interface Candle {
  time: number; // unix seconds (candle open time)
  open: number;
  high: number;
  low: number;
  close: number;
}

const marketKey = (base: string, quote: string) => `${base}-${quote}`;

export async function getCandles(base: string, quote: string, resolution: number, limit = 600): Promise<Candle[]> {
  const rows = await prisma.candle.findMany({
    where: { market: marketKey(base, quote), resolution },
    orderBy: { time: "desc" },
    take: limit,
    select: { time: true, open: true, high: true, low: true, close: true },
  });
  return rows.reverse(); // oldest -> newest for the chart
}

export async function upsertCandles(base: string, quote: string, resolution: number, candles: Candle[]): Promise<void> {
  const valid = candles.filter((c) => c.time > 0 && c.open > 0);
  if (!valid.length) return;
  const market = marketKey(base, quote);
  await prisma.$transaction(
    valid.map((c) =>
      prisma.candle.upsert({
        where: { market_resolution_time: { market, resolution, time: c.time } },
        create: { market, resolution, time: c.time, open: c.open, high: c.high, low: c.low, close: c.close },
        update: { open: c.open, high: c.high, low: c.low, close: c.close },
      })
    )
  );
}

// --- source: Pyth benchmarks TradingView shim (server-side fetch). base/USD ÷ quote/USD per bar. ---
const PYTH_BENCH = "https://benchmarks.pyth.network/v1/shims/tradingview/history";
const pythSymbol = (asset: string) => `Crypto.${asset.toUpperCase()}/USD`;

interface Bars {
  s: string;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
}

async function fetchBars(asset: string, resolution: number, from: number, to: number): Promise<Bars | null> {
  const url = `${PYTH_BENCH}?symbol=${encodeURIComponent(pythSymbol(asset))}&resolution=${resolution}&from=${from}&to=${to}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as Bars;
    if (j.s !== "ok" || !j.t?.length) return null;
    return j;
  } catch {
    return null;
  }
}

export async function fetchRatioCandlesRemote(
  base: string,
  quote: string,
  resolutionMin = 60,
  days = 7
): Promise<Candle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86_400;
  const [b, q] = await Promise.all([
    fetchBars(base, resolutionMin, from, to),
    fetchBars(quote, resolutionMin, from, to),
  ]);
  if (!b || !q) return [];

  const qo = new Map<number, number>(), qh = new Map<number, number>(), ql = new Map<number, number>(), qc = new Map<number, number>();
  for (let i = 0; i < q.t.length; i++) {
    qo.set(q.t[i], q.o[i]);
    qh.set(q.t[i], q.h[i]);
    ql.set(q.t[i], q.l[i]);
    qc.set(q.t[i], q.c[i]);
  }

  const out: Candle[] = [];
  for (let i = 0; i < b.t.length; i++) {
    const t = b.t[i];
    if (!qc.has(t)) continue;
    const qO = qo.get(t)!, qH = qh.get(t)!, qL = ql.get(t)!, qC = qc.get(t)!;
    if (!qO || !qH || !qL || !qC) continue;
    out.push({
      time: t,
      open: b.o[i] / qO,
      close: b.c[i] / qC,
      high: b.h[i] / qL, // max ratio: base high / quote low
      low: b.l[i] / qH, // min ratio: base low / quote high
    });
  }
  return out;
}
