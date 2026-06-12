// Client access to ratio OHLC candles. Backed by the local SQLite store behind /api/candles
// (see src/lib/server/candles.ts) so loads are instant and shared, instead of hitting the slow
// Pyth benchmarks endpoint directly on every chart mount. The server fills from Pyth on a cold/
// stale store; the chart also POSTs its live forming candle so real-time ticks persist.

export interface Candle {
  time: number; // unix seconds (candle open time)
  open: number;
  high: number;
  low: number;
  close: number;
}

// OHLC candles for ratio = base/quote over the last `days` at `resolutionMin`-minute candles.
export async function fetchRatioCandles(
  base: string,
  quote: string,
  resolutionMin = 60,
  days = 7
): Promise<Candle[]> {
  try {
    const res = await fetch(`/api/candles?base=${base}&quote=${quote}&resolution=${resolutionMin}&days=${days}`);
    if (!res.ok) return [];
    const j = (await res.json()) as { candles?: Candle[] };
    return Array.isArray(j.candles) ? j.candles : [];
  } catch {
    return [];
  }
}

// Persist the live forming candle to the store (fire-and-forget, throttled by the caller).
export async function postLiveCandle(base: string, quote: string, resolutionMin: number, candle: Candle): Promise<void> {
  try {
    await fetch(`/api/candles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base, quote, resolution: resolutionMin, candle }),
    });
  } catch {
    /* best-effort */
  }
}
