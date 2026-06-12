// SERVER-ONLY. Postgres-backed (via Prisma) durable trade history + wallet registry, served by
// /api/trades and /api/activity. Never import from client code — it pulls the Prisma client.
// Live market/pool/position state is NOT stored here; it stays authoritative on-chain.
import { prisma } from "./prisma";

export interface TradeInput {
  owner: string;
  id: string;
  symbol: string;
  side: "long" | "short";
  notional: number;
  collateral: number;
  leverage: number;
  entryRatio: number;
  exitRatio: number;
  realizedPnl: number;
  status: "closed" | "liquidated";
  signature?: string | null;
  closedTs: number;
}

export interface TradeRow extends TradeInput {
  signature: string | null;
}

export interface TradeEventInput {
  owner: string;
  kind: "open" | "close" | "liquidated";
  symbol: string;
  side: "long" | "short";
  notional: number;
  collateral: number;
  leverage: number;
  ratio: number; // entry ratio for open, exit ratio for close
  realizedPnl?: number | null;
  signature?: string | null;
  ts: number;
}

const finite = (n: unknown, fallback = 0) => (typeof n === "number" && Number.isFinite(n) ? n : fallback);

const eventId = (e: TradeEventInput) =>
  e.signature ?? `${e.owner}-${e.kind}-${Math.floor(finite(e.ts))}-${Math.round(finite(e.ratio) * 1e6)}`;

// Write one activity-log row. Idempotent on id (tx signature, or a composite fallback). Runs inside
// a caller-supplied transaction so it commits atomically with the Trade/Trader writes.
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
async function writeEvent(tx: Tx, e: TradeEventInput): Promise<void> {
  const data = {
    owner: e.owner,
    kind: e.kind,
    symbol: e.symbol,
    side: e.side,
    notional: finite(e.notional),
    collateral: finite(e.collateral),
    leverage: finite(e.leverage),
    ratio: finite(e.ratio),
    realizedPnl: e.realizedPnl == null ? null : finite(e.realizedPnl),
    signature: e.signature ?? null,
    ts: Math.floor(finite(e.ts, Date.now() / 1000)),
  };
  const id = eventId(e);
  await tx.tradeEvent.upsert({ where: { id }, create: { id, ...data }, update: data });
}

// Upsert the trade (idempotent by [owner, id]) and recompute the wallet's aggregates from the Trade
// table in the same transaction — recompute, not increment, so a re-POSTed trade can't double-count.
export async function recordTrade(t: TradeInput): Promise<void> {
  const data = {
    symbol: t.symbol,
    side: t.side,
    notional: finite(t.notional),
    collateral: finite(t.collateral),
    leverage: finite(t.leverage),
    entryRatio: finite(t.entryRatio),
    exitRatio: finite(t.exitRatio),
    realizedPnl: finite(t.realizedPnl),
    status: t.status,
    signature: t.signature ?? null,
    closedTs: Math.floor(finite(t.closedTs, Date.now() / 1000)),
  };

  await prisma.$transaction(async (tx) => {
    await tx.trade.upsert({
      where: { owner_id: { owner: t.owner, id: t.id } },
      create: { owner: t.owner, id: t.id, ...data },
      update: data,
    });

    const rows = await tx.trade.findMany({
      where: { owner: t.owner },
      select: { realizedPnl: true, notional: true, status: true, closedTs: true },
    });

    const agg = rows.reduce(
      (a, r) => {
        a.trades += 1;
        if (r.realizedPnl > 0) a.wins += 1;
        else a.losses += 1;
        if (r.status === "liquidated") a.liquidations += 1;
        a.realizedPnl += r.realizedPnl;
        a.volume += r.notional;
        a.first = a.first === null ? r.closedTs : Math.min(a.first, r.closedTs);
        a.last = a.last === null ? r.closedTs : Math.max(a.last, r.closedTs);
        return a;
      },
      { trades: 0, wins: 0, losses: 0, liquidations: 0, realizedPnl: 0, volume: 0, first: null as number | null, last: null as number | null }
    );

    const stats = {
      trades: agg.trades,
      wins: agg.wins,
      losses: agg.losses,
      liquidations: agg.liquidations,
      realizedPnl: agg.realizedPnl,
      volume: agg.volume,
      firstTradeTs: agg.first,
      lastTradeTs: agg.last,
    };

    await tx.trader.upsert({
      where: { address: t.owner },
      create: { address: t.owner, ...stats },
      update: stats,
    });

    await writeEvent(tx, {
      owner: t.owner,
      kind: t.status === "liquidated" ? "liquidated" : "close",
      symbol: t.symbol,
      side: t.side,
      notional: t.notional,
      collateral: t.collateral,
      leverage: t.leverage,
      ratio: t.exitRatio,
      realizedPnl: t.realizedPnl,
      signature: t.signature,
      ts: data.closedTs,
    });
  });
}

// Record an open (or any non-close event) and register the wallet in the Trader registry. Stats stay
// untouched until a close recomputes them.
export async function recordEvent(e: TradeEventInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await writeEvent(tx, e);
    await tx.trader.upsert({ where: { address: e.owner }, create: { address: e.owner }, update: {} });
  });
}

function toEventRow(r: { side: string; kind: string; realizedPnl: number | null }) {
  return { ...r, side: r.side as "long" | "short", kind: r.kind as "open" | "close" | "liquidated" };
}

// Global activity feed: most recent events across all wallets (opens + closes).
export async function getRecentEvents(limit = 50) {
  const rows = await prisma.tradeEvent.findMany({ orderBy: { ts: "desc" }, take: Math.min(Math.max(1, limit), 200) });
  return rows.map(toEventRow);
}

// One wallet's full activity (opens + closes), newest-first.
export async function getEvents(owner: string, limit = 100) {
  const rows = await prisma.tradeEvent.findMany({ where: { owner }, orderBy: { ts: "desc" }, take: Math.min(Math.max(1, limit), 500) });
  return rows.map(toEventRow);
}

// Newest-first trade history for one wallet.
export async function getTrades(owner: string, limit = 200): Promise<TradeRow[]> {
  const rows = await prisma.trade.findMany({
    where: { owner },
    orderBy: { closedTs: "desc" },
    take: Math.min(Math.max(1, limit), 1000),
  });
  return rows.map((r) => ({ ...r, side: r.side as "long" | "short", status: r.status as "closed" | "liquidated" }));
}

export async function getTrader(address: string) {
  return prisma.trader.findUnique({ where: { address } });
}
