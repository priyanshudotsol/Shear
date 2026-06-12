"use client";

import { useEffect, useRef } from "react";
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

const RESOLUTION_MIN = 60; // 1h candles
const PERIOD = RESOLUTION_MIN * 60; // seconds per candle
const DAYS = 7;
const MAX_CANDLES = 600;

const cacheKey = (base: string, quote: string) => `shear:candles:${base}-${quote}:${RESOLUTION_MIN}`;

function loadCache(base: string, quote: string): Candle[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(cacheKey(base, quote));
    if (!raw) return [];
    const c = JSON.parse(raw) as Candle[];
    return Array.isArray(c) ? c : [];
  } catch {
    return [];
  }
}
function saveCache(base: string, quote: string, candles: Candle[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cacheKey(base, quote), JSON.stringify(candles.slice(-MAX_CANDLES)));
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
}

export function RatioChart({ base, quote, liveRatio, entryRatio, liqRatio, height = 360 }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const lastSaveRef = useRef(0);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const liqLineRef = useRef<IPriceLine | null>(null);

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
      chart.timeScale().fitContent();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  // load cached candles instantly, then refresh from Pyth (so refresh is never blank / "gone")
  useEffect(() => {
    let cancelled = false;
    const s = seriesRef.current;
    if (!s) return;

    const render = (candles: Candle[]) => {
      candlesRef.current = candles;
      s.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
      requestAnimationFrame(() => chartRef.current?.timeScale().fitContent());
    };

    const cached = loadCache(base, quote);
    if (cached.length) render(cached); // instant — survives refresh

    (async () => {
      const fresh = await fetchRatioCandles(base, quote, RESOLUTION_MIN, DAYS);
      if (cancelled || !seriesRef.current || fresh.length === 0) return;
      render(fresh);
      saveCache(base, quote, fresh);
    })();

    return () => {
      cancelled = true;
    };
  }, [base, quote]);

  // live: fold the current ratio into the forming candle (or roll a new one) + persist
  useEffect(() => {
    const s = seriesRef.current;
    if (!s || !liveRatio || liveRatio <= 0) return;
    const candles = candlesRef.current;
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / PERIOD) * PERIOD;
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
      saveCache(base, quote, candles);
      postLiveCandle(base, quote, RESOLUTION_MIN, candles[candles.length - 1]);
    }
  }, [liveRatio, base, quote]);

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

  return <div ref={elRef} className="w-full" style={{ height }} />;
}
