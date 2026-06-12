"use client";

// Per-wallet record of closed/liquidated trades, captured at close time (the real on-chain position
// data + realized PnL). localStorage is the instant optimistic cache; Postgres (via /api/trades) is
// the durable source of truth, so history survives a storage clear and syncs across devices.
// recordTrade writes localStorage immediately and fire-and-forget POSTs to the DB; hydrateTrades
// merges the DB back in. (ER tx history isn't reliably retained, so we record as trades happen.)

export interface ClosedTrade {
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
  closedTs: number; // unix seconds
}

const key = (owner: string) => `shear:trades:${owner}`;

function readLocal(owner: string): ClosedTrade[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key(owner));
    const list = raw ? (JSON.parse(raw) as ClosedTrade[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeLocal(owner: string, list: ClosedTrade[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key(owner), JSON.stringify(list.slice(0, 200)));
  } catch {
    /* storage unavailable */
  }
}

// Synchronous read from localStorage for instant first paint. Call hydrateTrades after to pull the
// durable DB copy.
export function getTrades(owner: string): ClosedTrade[] {
  return readLocal(owner);
}

// Record a closed trade: write localStorage now (optimistic), then durably persist to Postgres.
export function recordTrade(owner: string, t: Omit<ClosedTrade, "id" | "closedTs">): ClosedTrade {
  const closedTs = Math.floor(Date.now() / 1000);
  const list = readLocal(owner);
  const id = `${closedTs}_${list.length}_${Math.round(t.realizedPnl * 1e6)}`;
  const entry: ClosedTrade = { ...t, id, closedTs };
  writeLocal(owner, [entry, ...list]);
  if (typeof window !== "undefined") {
    void fetch("/api/trades", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, ...entry }),
    }).catch(() => {
      /* best-effort; localStorage already holds it and a later hydrate will reconcile */
    });
  }
  return entry;
}

// Record a successful position OPEN to the durable activity log (fire-and-forget). This also
// registers the wallet in the DB immediately — before any close. Idempotent on the tx signature.
export function recordOpen(
  owner: string,
  e: { symbol: string; side: "long" | "short"; notional: number; collateral: number; leverage: number; entryRatio: number; signature?: string | null }
): void {
  if (typeof window === "undefined") return;
  void fetch("/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner,
      kind: "open",
      symbol: e.symbol,
      side: e.side,
      notional: e.notional,
      collateral: e.collateral,
      leverage: e.leverage,
      ratio: e.entryRatio,
      signature: e.signature ?? null,
      ts: Math.floor(Date.now() / 1000),
    }),
  }).catch(() => {
    /* best-effort */
  });
}

function toClosed(r: Partial<ClosedTrade> & { id: string; side: string; status: string; closedTs: number }): ClosedTrade {
  return {
    id: r.id,
    symbol: r.symbol ?? "SOL-ETH",
    side: r.side === "short" ? "short" : "long",
    notional: r.notional ?? 0,
    collateral: r.collateral ?? 0,
    leverage: r.leverage ?? (r.collateral ? (r.notional ?? 0) / r.collateral : 0),
    entryRatio: r.entryRatio ?? 0,
    exitRatio: r.exitRatio ?? 0,
    realizedPnl: r.realizedPnl ?? 0,
    status: r.status === "liquidated" ? "liquidated" : "closed",
    signature: r.signature ?? null,
    closedTs: r.closedTs,
  };
}

// Durable history from Postgres (newest-first), or [] if the API is unavailable.
export async function fetchTrades(owner: string): Promise<ClosedTrade[]> {
  try {
    const res = await fetch(`/api/trades?owner=${owner}&limit=200`);
    if (!res.ok) return [];
    const j = (await res.json()) as { trades?: ClosedTrade[] };
    return Array.isArray(j.trades) ? j.trades.map(toClosed) : [];
  } catch {
    return [];
  }
}

// Merge the durable DB copy with localStorage (which may hold a just-recorded trade not yet synced),
// dedupe by id, persist the merged list back, and return it newest-first.
export async function hydrateTrades(owner: string): Promise<ClosedTrade[]> {
  const local = readLocal(owner);
  const remote = await fetchTrades(owner);
  const byId = new Map<string, ClosedTrade>();
  for (const t of remote) byId.set(t.id, t);
  for (const t of local) if (!byId.has(t.id)) byId.set(t.id, t);
  const merged = [...byId.values()].sort((a, b) => b.closedTs - a.closedTs).slice(0, 200);
  writeLocal(owner, merged);
  return merged;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  totalProfit: number;
  totalLoss: number; // negative
  avgPnl: number;
  volume: number;
  liquidations: number;
  longCount: number;
  shortCount: number;
  estFees: number;
  firstTradeTs: number | null;
  bestTrade: ClosedTrade | null;
  worstTrade: ClosedTrade | null;
}

export function tradeStats(trades: ClosedTrade[], takerFeeBps = 6): TradeStats {
  const realizedPnl = trades.reduce((s, t) => s + t.realizedPnl, 0);
  const wins = trades.filter((t) => t.realizedPnl > 0).length;
  const losses = trades.filter((t) => t.realizedPnl <= 0).length;
  const totalProfit = trades.filter((t) => t.realizedPnl > 0).reduce((s, t) => s + t.realizedPnl, 0);
  const totalLoss = trades.filter((t) => t.realizedPnl < 0).reduce((s, t) => s + t.realizedPnl, 0);
  const volume = trades.reduce((s, t) => s + t.notional, 0);
  const sorted = [...trades].sort((a, b) => a.realizedPnl - b.realizedPnl);
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    realizedPnl,
    totalProfit,
    totalLoss,
    avgPnl: trades.length ? realizedPnl / trades.length : 0,
    volume,
    liquidations: trades.filter((t) => t.status === "liquidated").length,
    longCount: trades.filter((t) => t.side === "long").length,
    shortCount: trades.filter((t) => t.side === "short").length,
    // each round-trip pays open + close taker fee
    estFees: trades.reduce((s, t) => s + 2 * t.notional * (takerFeeBps / 1e4), 0),
    firstTradeTs: trades.length ? Math.min(...trades.map((t) => t.closedTs)) : null,
    bestTrade: sorted.length ? sorted[sorted.length - 1] : null,
    worstTrade: sorted.length ? sorted[0] : null,
  };
}
