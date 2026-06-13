import type { NextRequest } from "next/server";
import { getEvents, recordEvent, type TradeEventInput } from "@/lib/server/trades";

export const runtime = "nodejs"; // Prisma needs the Node runtime
export const dynamic = "force-dynamic"; // always serve live DB state

// GET /api/events?owner=<base58>&limit=100 - one wallet's full activity (opens + closes), newest-first.
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner) return Response.json({ events: [] });
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  return Response.json({ events: await getEvents(owner, limit) });
}

// POST /api/events - record a trade event (used for opens). Idempotent on signature. Registers the
// wallet in the Trader registry. Closes go through /api/trades, which emits its own close event.
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Partial<TradeEventInput>;
    if (!b.owner || !b.kind || !b.side) {
      return Response.json({ ok: false, error: "missing owner/kind/side" }, { status: 400 });
    }
    await recordEvent({
      owner: b.owner,
      kind: b.kind,
      symbol: b.symbol ?? "SOL-ETH",
      side: b.side,
      notional: Number(b.notional ?? 0),
      collateral: Number(b.collateral ?? 0),
      leverage: Number(b.leverage ?? 0),
      ratio: Number(b.ratio ?? 0),
      realizedPnl: b.realizedPnl == null ? null : Number(b.realizedPnl),
      signature: b.signature ?? null,
      ts: Number(b.ts ?? Math.floor(Date.now() / 1000)),
    });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "bad request" }, { status: 400 });
  }
}
