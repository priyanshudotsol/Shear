"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";
import { fetchRatioCandles, postLiveCandle, type Candle } from "@/lib/pyth-history";

const DEFAULT_RESOLUTION_MIN = 60; // 1h candles
const MAX_CANDLES = 1500;

// Selectable timeframes. `min` is the candle resolution in minutes — also the store/Pyth key
// (24h = 1440 = daily bars). Each timeframe is a separate row set keyed by resolution in the DB.
const TIMEFRAMES: { label: string; min: number }[] = [
  { label: "1m", min: 1 },
  { label: "5m", min: 5 },
  { label: "15m", min: 15 },
  { label: "30m", min: 30 },
  { label: "1h", min: 60 },
  { label: "24h", min: 1440 },
];

// History window per timeframe — enough bars to fill the chart without over-fetching Pyth or
// tripping the store's "thin" backfill on every load.
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

const cacheKey = (base: string, quote: string, res: number) => `shear:candles:${base}-${quote}:${res}`;

function loadCache(base: string, quote: string, res: number): Candle[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(cacheKey(base, quote, res));
    if (!raw) return [];
    const c = JSON.parse(raw) as Candle[];
    return Array.isArray(c) ? c : [];
  } catch {
    return [];
  }
}
function saveCache(base: string, quote: string, res: number, candles: Candle[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cacheKey(base, quote, res), JSON.stringify(candles.slice(-MAX_CANDLES)));
  } catch {
    /* storage full / unavailable */
  }
}

interface Props {
  base: string; // e.g. "SOL"
  quote: string; // e.g. "ETH"
  liveRatio?: number; // current ratio — updates the forming candle so the chart is live
  entryRatio?: number | null;
  liqRatio?: number | null;
  height?: number;
  /** When set, zoom to the most recent N candles instead of fitting the full range — gives candles
   *  a readable width in narrow containers (e.g. the landing teaser) rather than a dense strip. */
  visibleBars?: number;
  /** Show the 1m/5m/.../24h timeframe selector. Off for compact embeds (e.g. landing teaser). */
  showTimeframes?: boolean;
}

export function RatioChart({ base, quote, liveRatio, entryRatio, liqRatio, height = 360, visibleBars, showTimeframes = false }: Props) {
  const [resolutionMin, setResolutionMin] = useState(DEFAULT_RESOLUTION_MIN);
  const period = resolutionMin * 60; // seconds per candle
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const lastSaveRef = useRef(0);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const liqLineRef = useRef<IPriceLine | null>(null);

  // Fit the full range, or zoom to the most recent `visibleBars` candles when set.
  const applyView = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const len = candlesRef.current.length;
    if (visibleBars && len > visibleBars) {
      chart.timeScale().setVisibleLogicalRange({ from: len - visibleBars, to: len + 4 });
    } else {
      chart.timeScale().fitContent();
    }
  }, [visibleBars]);

  // init chart once
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(180,190,205,0.65)",
        fontFamily: "var(--font-geist-mono), monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(120,135,160,0.06)" },
        horzLines: { color: "rgba(120,135,160,0.08)" },
      },
      rightPriceScale: { borderColor: "rgba(120,135,160,0.12)" },
      timeScale: { borderColor: "rgba(120,135,160,0.12)", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(120,200,220,0.4)", width: 1, style: LineStyle.Dotted, labelBackgroundColor: "#0c1116" },
        horzLine: { color: "rgba(120,200,220,0.4)", labelBackgroundColor: "#0c1116" },
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "rgba(86,204,142,1)",
      downColor: "rgba(230,90,90,1)",
      wickUpColor: "rgba(86,204,142,0.7)",
      wickDownColor: "rgba(230,90,90,0.7)",
      borderVisible: false,
      priceFormat: { type: "price", precision: 5, minMove: 0.00001 },
    });
    chartRef.current = chart;
    seriesRef.current = series;

    // refit whenever the container resizes so the candles always fill the width (fixes the
    // "candles bunched on the right with empty space" when the chart lays out after data loads).
    const ro = new ResizeObserver(() => {
      if (!elRef.current) return;
      chart.applyOptions({ width: elRef.current.clientWidth });
      applyView();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height, applyView]);

  // load cached candles instantly, then refresh from Pyth (so refresh is never blank / "gone")
  useEffect(() => {
    let cancelled = false;
    const s = seriesRef.current;
    if (!s) return;

    const render = (candles: Candle[]) => {
      candlesRef.current = candles;
      s.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
      requestAnimationFrame(applyView);
    };

    const cached = loadCache(base, quote, resolutionMin);
    render(cached.length ? cached : []); // instant — survives refresh; clears stale timeframe on switch

    (async () => {
      const fresh = await fetchRatioCandles(base, quote, resolutionMin, daysFor(resolutionMin));
      if (cancelled || !seriesRef.current || fresh.length === 0) return;
      render(fresh);
      saveCache(base, quote, resolutionMin, fresh);
    })();

    return () => {
      cancelled = true;
    };
  }, [base, quote, resolutionMin, applyView]);

  // live: fold the current ratio into the forming candle (or roll a new one) + persist
  useEffect(() => {
    const s = seriesRef.current;
    if (!s || !liveRatio || liveRatio <= 0) return;
    const candles = candlesRef.current;
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / period) * period;
    const last = candles[candles.length - 1];
    if (!last || bucket > last.time) {
      const c: Candle = { time: bucket, open: liveRatio, high: liveRatio, low: liveRatio, close: liveRatio };
      candles.push(c);
      s.update({ ...c, time: c.time as UTCTimestamp });
    } else {
      last.close = liveRatio;
      last.high = Math.max(last.high, liveRatio);
      last.low = Math.min(last.low, liveRatio);
      s.update({ ...last, time: last.time as UTCTimestamp });
    }
    // throttle persistence to ~once / 5s: localStorage (instant paint on refresh) + the SQLite
    // store (so live ticks accumulate server-side, shared across sessions/browsers).
    if (now - lastSaveRef.current > 5) {
      lastSaveRef.current = now;
      saveCache(base, quote, resolutionMin, candles);
      postLiveCandle(base, quote, resolutionMin, candles[candles.length - 1]);
    }
  }, [liveRatio, base, quote, resolutionMin, period]);

  // entry / liq price lines
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (entryLineRef.current) {
      s.removePriceLine(entryLineRef.current);
      entryLineRef.current = null;
    }
    if (liqLineRef.current) {
      s.removePriceLine(liqLineRef.current);
      liqLineRef.current = null;
    }
    if (entryRatio && entryRatio > 0) {
      entryLineRef.current = s.createPriceLine({
        price: entryRatio,
        color: "rgba(180,190,205,0.7)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "entry",
      });
    }
    if (liqRatio && liqRatio > 0) {
      liqLineRef.current = s.createPriceLine({
        price: liqRatio,
        color: "rgba(230,90,90,0.85)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "liq",
      });
    }
  }, [entryRatio, liqRatio]);

  return (
    <div className="w-full">
      {showTimeframes && (
        <div className="mb-2 flex items-center gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.min}
              type="button"
              onClick={() => setResolutionMin(tf.min)}
              className={
                "rounded px-2 py-1 text-xs font-medium transition-colors " +
                (tf.min === resolutionMin
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
              }
            >
              {tf.label}
            </button>
          ))}
        </div>
      )}
      <div ref={elRef} className="w-full" style={{ height }} />
    </div>
  );
}
