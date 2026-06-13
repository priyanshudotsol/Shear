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

// Selectable timeframes. `min` is the candle resolution in minutes - also the store/Pyth key
// (24h = 1440 = daily bars). Each timeframe is a separate row set keyed by resolution in the DB.
const TIMEFRAMES: { label: string; min: number }[] = [
  { label: "1m", min: 1 },
  { label: "5m", min: 5 },
  { label: "15m", min: 15 },
  { label: "30m", min: 30 },
  { label: "1h", min: 60 },
  { label: "24h", min: 1440 },
];

// History window per timeframe - enough bars to fill the chart without over-fetching Pyth or
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

// Resolve a CSS color expression to a sRGB hex/rgba string. lightweight-charts paints to a canvas
// and its parser only understands rgb/hex - not oklch/lab/color-mix. Browsers now serialize computed
// `color` in its own space (e.g. lab()), so we (1) resolve var()/color-mix to a concrete value via a
// probe element, then (2) round-trip it through a canvas 2D context, which normalizes any CSS Color 4
// value down to sRGB hex/rgba.
const resolveColor = (expr: string, fallback = "transparent"): string => {
  if (typeof window === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.color = expr;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  if (!computed) return fallback;
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return computed;
  // Rasterize a single pixel and read the sRGB bytes back - guarantees an rgb()/rgba() value even
  // when the browser keeps `color` in lab()/oklch() form on both getComputedStyle and fillStyle.
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = computed;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
};
// Resolve a theme CSS variable (e.g. "--brand") to an rgb string.
const themeColor = (name: string): string => resolveColor(`var(${name})`);
// Blend a theme color with transparency for subtle grid/wick/crosshair tints.
const themeColorAlpha = (name: string, percent: number): string =>
  resolveColor(`color-mix(in oklch, var(${name}) ${percent}%, transparent)`);

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
  liveRatio?: number; // current ratio - updates the forming candle so the chart is live
  entryRatio?: number | null;
  liqRatio?: number | null;
  height?: number;
  /** When set, zoom to the most recent N candles instead of fitting the full range - gives candles
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
        textColor: themeColor("--muted-foreground"),
        fontFamily: "var(--font-geist-mono), monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: themeColorAlpha("--border", 60) },
        horzLines: { color: themeColorAlpha("--border", 80) },
      },
      rightPriceScale: { borderColor: themeColor("--border") },
      timeScale: { borderColor: themeColor("--border"), timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: themeColorAlpha("--brand", 45), width: 1, style: LineStyle.Dotted, labelBackgroundColor: themeColor("--brand") },
        horzLine: { color: themeColorAlpha("--brand", 45), labelBackgroundColor: themeColor("--brand") },
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: themeColor("--up"),
      downColor: themeColor("--down"),
      wickUpColor: themeColorAlpha("--up", 70),
      wickDownColor: themeColorAlpha("--down", 70),
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
    render(cached.length ? cached : []); // instant - survives refresh; clears stale timeframe on switch

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
        color: themeColor("--muted-foreground"),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "entry",
      });
    }
    if (liqRatio && liqRatio > 0) {
      liqLineRef.current = s.createPriceLine({
        price: liqRatio,
        color: themeColorAlpha("--down", 85),
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
