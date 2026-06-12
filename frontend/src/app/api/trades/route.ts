import type { NextRequest } from "next/server";
import { getTrades, recordTrade, type TradeInput } from "@/lib/server/trades";

export const runtime = "nodejs"; // Prisma needs the Node runtime
export const dynamic = "force-dynamic"; // always serve live DB state

// GET /api/trades?owner=<base58>&limit=200 — newest-first trade history for one wallet.
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner) return Response.json({ trades: [] });
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 200);
  return Response.json({ trades: await getTrades(owner, limit) });
}

// POST /api/trades — record a closed/liquidated trade. Idempotent on (owner, id).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Partial<TradeInput>;
    if (!b.owner || !b.id || !b.side || !b.status) {
      return Response.json({ ok: false, error: "missing owner/id/side/status" }, { status: 400 });
    }
    await recordTrade({
      owner: b.owner,
      id: b.id,
      symbol: b.symbol ?? "SOL-ETH",
      side: b.side,
      notional: Number(b.notional ?? 0),
      collateral: Number(b.collateral ?? 0),
      leverage: Number(b.leverage ?? 0),
      entryRatio: Number(b.entryRatio ?? 0),
      exitRatio: Number(b.exitRatio ?? 0),
      realizedPnl: Number(b.realizedPnl ?? 0),
      status: b.status,
      signature: b.signature ?? null,
      closedTs: Number(b.closedTs ?? Math.floor(Date.now() / 1000)),
    });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "bad request" }, { status: 400 });
  }
}
