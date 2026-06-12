import type { NextRequest } from "next/server";
import { getCandles, upsertCandles, fetchRatioCandlesRemote, type Candle } from "@/lib/server/candles";

export const runtime = "nodejs"; // Prisma needs the Node runtime
export const dynamic = "force-dynamic"; // always serve live DB state

// GET /api/candles?base=SOL&quote=ETH&resolution=60&days=7
// Serves ratio candles from the local Postgres store. Backfills from Pyth when the store is empty,
// stale (newest older than ~2 candle periods), or thin (far fewer bars than the window should hold),
// so repeat loads are instant but history isn't suppressed by a single live candle.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const base = (sp.get("base") ?? "SOL").toUpperCase();
  const quote = (sp.get("quote") ?? "ETH").toUpperCase();
  const resolution = Math.max(1, Number(sp.get("resolution") ?? 60));
  const days = Math.max(1, Number(sp.get("days") ?? 7));

  const periodSec = resolution * 60;
  const expectedBars = Math.ceil((days * 86_400) / periodSec);
  let candles = await getCandles(base, quote, resolution);
  const latest = candles.length ? candles[candles.length - 1].time : 0;
  const stale = Math.floor(Date.now() / 1000) - latest > periodSec * 2;
  // A live POST keeps `latest` fresh, so recency alone can't gate the backfill — also require that
  // the store actually holds most of the requested window, else history never loads for live markets.
  const thin = candles.length < expectedBars * 0.6;
  if (latest === 0 || stale || thin) {
    try {
      const fresh = await fetchRatioCandlesRemote(base, quote, resolution, days);
      await upsertCandles(base, quote, resolution, fresh);
      candles = await getCandles(base, quote, resolution);
    } catch {
      /* keep serving whatever is already stored */
    }
  }

  return Response.json({ candles });
}

// POST /api/candles  { base, quote, resolution, candle }
// Persists the live forming candle so the store accumulates real-time ticks across sessions/browsers.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { base?: string; quote?: string; resolution?: number; candle?: Candle };
    const { base, quote, resolution, candle } = body;
    if (base && quote && resolution && candle) {
      await upsertCandles(base.toUpperCase(), quote.toUpperCase(), Number(resolution), [candle]);
    }
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  return Response.json({ ok: true });
}
