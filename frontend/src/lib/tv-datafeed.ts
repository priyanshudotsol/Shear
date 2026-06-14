// TradingView Charting Library datafeed for SHEAR's relative-value ratio markets.
//
// Unlike ordr (orderbook DEX pulling Binance klines), SHEAR is a pool-based ratio-perp exchange:
// each "symbol" is a base/quote ratio (e.g. SOL/ETH) served as OHLC candles from our own store
// (/api/candles, backed by Pyth). The live forming candle is driven by the market's current ratio
// via `pushLiveRatio` rather than by polling an exchange.

import type {
  IBasicDataFeed,
  LibrarySymbolInfo,
  ResolutionString,
  SearchSymbolResultItem,
  Bar,
  SubscribeBarsCallback,
  OnReadyCallback,
  ResolveCallback,
  DatafeedErrorCallback,
  HistoryCallback,
  PeriodParams,
} from "charting_library";
import { fetchRatioCandles, postLiveCandle, type Candle } from "@/lib/pyth-history";

// TV resolution string -> candle resolution in minutes (also our store key).
const RES_TO_MIN: Record<string, number> = {
  "1": 1,
  "5": 5,
  "15": 15,
  "30": 30,
  "60": 60,
  "1D": 1440,
};
const SUPPORTED: ResolutionString[] = ["1", "5", "15", "30", "60", "1D"] as ResolutionString[];

// How much history to pull per resolution - enough to fill the view without over-fetching the store.
const daysFor = (min: number): number => {
  switch (min) {
    case 1: return 1;
    case 5: return 3;
    case 15: return 7;
    case 30: return 14;
    case 60: return 30;
    case 1440: return 365;
    default: return 7;
  }
};

// Symbol names are "BASE/QUOTE" (e.g. "SOL/ETH").
const splitSymbol = (name: string): { base: string; quote: string } => {
  const clean = name.toUpperCase().replace(/^[^:]+:/, "");
  const [base, quote] = clean.split("/");
  return { base: base ?? clean, quote: quote ?? "USD" };
};

const minFor = (resolution: string): number => RES_TO_MIN[resolution] ?? 60;
const candleToBar = (c: Candle): Bar => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close });

// Live bridge: track each active subscription so `pushLiveRatio` can fold the current ratio into the
// forming bar and emit it, mirroring how the lightweight-charts version rolled live ticks.
interface Sub {
  onTick: SubscribeBarsCallback;
  base: string;
  quote: string;
  resolution: string;
  periodSec: number;
  last: Bar | null;
}
const subs = new Map<string, Sub>();
const lastSaveAt = new Map<string, number>();
// Most recent historical bar per symbol+resolution, so live folding continues from real history.
const lastBars = new Map<string, Bar>();

// Called by the chart component whenever the market ratio updates. Folds the ratio into the forming
// candle (or rolls a new one at the period boundary), pushes it to the widget, and persists it.
export function pushLiveRatio(base: string, quote: string, ratio: number): void {
  if (!ratio || ratio <= 0) return;
  const now = Math.floor(Date.now() / 1000);
  for (const sub of subs.values()) {
    if (sub.base !== base.toUpperCase() || sub.quote !== quote.toUpperCase()) continue;
    const bucket = Math.floor(now / sub.periodSec) * sub.periodSec;
    if (!sub.last || bucket > sub.last.time / 1000) {
      sub.last = { time: bucket * 1000, open: ratio, high: ratio, low: ratio, close: ratio };
    } else {
      sub.last = {
        ...sub.last,
        close: ratio,
        high: Math.max(sub.last.high, ratio),
        low: Math.min(sub.last.low, ratio),
      };
    }
    sub.onTick(sub.last);

    // Throttle persistence to ~once / 5s per market+resolution so live ticks accumulate server-side.
    const key = `${sub.base}-${sub.quote}:${sub.resolution}`;
    if (now - (lastSaveAt.get(key) ?? 0) > 5) {
      lastSaveAt.set(key, now);
      const c: Candle = {
        time: Math.floor(sub.last.time / 1000),
        open: sub.last.open,
        high: sub.last.high,
        low: sub.last.low,
        close: sub.last.close,
      };
      void postLiveCandle(sub.base, sub.quote, minFor(sub.resolution), c);
    }
  }
}

export const ratioDatafeed: IBasicDataFeed = {
  onReady(callback: OnReadyCallback) {
    setTimeout(
      () =>
        callback({
          supported_resolutions: SUPPORTED,
          exchanges: [{ value: "SHEAR", name: "SHEAR", desc: "SHEAR ratio markets" }],
          symbols_types: [{ name: "ratio", value: "ratio" }],
        }),
      0,
    );
  },

  searchSymbols(
    _userInput: string,
    _exchange: string,
    _symbolType: string,
    onResult: (items: SearchSymbolResultItem[]) => void,
  ) {
    onResult([]);
  },

  resolveSymbol(symbolName: string, onResolve: ResolveCallback) {
    const { base, quote } = splitSymbol(symbolName);
    const name = `${base}/${quote}`;
    setTimeout(
      () =>
        onResolve({
          name,
          full_name: name,
          ticker: name,
          description: `${base} / ${quote} ratio`,
          type: "ratio",
          session: "24x7",
          exchange: "SHEAR",
          listed_exchange: "SHEAR",
          timezone: "Etc/UTC",
          format: "price",
          // Ratios are small decimals - match the lightweight-charts precision (5 dp, 0.00001 minmove).
          pricescale: 100000,
          minmov: 1,
          has_intraday: true,
          has_daily: true,
          has_weekly_and_monthly: false,
          supported_resolutions: SUPPORTED,
          volume_precision: 0,
          data_status: "streaming",
        } as LibrarySymbolInfo),
      0,
    );
  },

  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback,
  ) {
    const { from, to, firstDataRequest } = periodParams;
    // Our store only holds a recent window - serve it on the first request, then report no more
    // history for older pages so the widget stops paging.
    if (!firstDataRequest) {
      onResult([], { noData: true });
      return;
    }
    const { base, quote } = splitSymbol(symbolInfo.name);
    const min = minFor(resolution);
    fetchRatioCandles(base, quote, min, daysFor(min))
      .then((candles) => {
        // Sort ascending + dedupe (TradingView rejects unordered/duplicate bars), then drop anything
        // after the requested `to`. We intentionally do NOT lower-bound by `from`: the store holds a
        // bounded window and returning extra older bars is harmless, whereas a `from` that doesn't
        // overlap our window would silently blank the chart.
        const seen = new Set<number>();
        const bars = candles
          .map(candleToBar)
          .filter((b) => b.time <= to * 1000)
          .sort((a, b) => a.time - b.time)
          .filter((b) => (seen.has(b.time) ? false : (seen.add(b.time), true)));
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[tv-datafeed] getBars ${base}/${quote} res=${resolution} fetched=${candles.length} returned=${bars.length} from=${from} to=${to}`);
        }
        if (bars.length === 0) {
          onResult([], { noData: true });
          return;
        }
        const key = `${base.toUpperCase()}/${quote.toUpperCase()}_${resolution}`;
        lastBars.set(key, bars[bars.length - 1]);
        onResult(bars, { noData: false });
      })
      .catch((err) => onError(String(err)));
  },

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    subscriberUID: string,
  ) {
    const { base, quote } = splitSymbol(symbolInfo.name);
    const key = `${base.toUpperCase()}/${quote.toUpperCase()}_${resolution}`;
    subs.set(subscriberUID, {
      onTick,
      base: base.toUpperCase(),
      quote: quote.toUpperCase(),
      resolution,
      periodSec: minFor(resolution) * 60,
      last: lastBars.get(key) ?? null,
    });
  },

  unsubscribeBars(subscriberUID: string) {
    subs.delete(subscriberUID);
  },
};
