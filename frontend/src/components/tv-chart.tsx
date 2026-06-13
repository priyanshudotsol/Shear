"use client";

import { useEffect, useRef } from "react";
import type {
  IChartingLibraryWidget,
  ChartingLibraryWidgetOptions,
  ResolutionString,
  EntityId,
} from "charting_library";
import { ratioDatafeed, pushLiveRatio } from "@/lib/tv-datafeed";
import { themeVar } from "@/lib/utils";

declare global {
  interface Window {
    TradingView: {
      widget: new (options: ChartingLibraryWidgetOptions) => IChartingLibraryWidget;
    };
  }
}

const SCRIPT_ID = "tv-charting-library";
let _scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (_scriptPromise) return _scriptPromise;
  _scriptPromise = new Promise((resolve, reject) => {
    if (window.TradingView?.widget) {
      resolve();
      return;
    }
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", reject);
      return;
    }
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = "/charting_library/charting_library.standalone.js";
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _scriptPromise;
}

// Pull SHEAR's theme tokens (resolved to rgb) so the widget matches the rest of the dark UI.
function getTheme() {
  return {
    bg: themeVar("--card", "#1f1f1f"),
    grid: themeVar("--border", "#2a2a2a"),
    text: themeVar("--muted-foreground", "#8a8a8a"),
    scaleLine: themeVar("--border", "#2a2a2a"),
    up: themeVar("--up", "#3abf72"),
    down: themeVar("--down", "#f9363c"),
  };
}

function getOverrides(t: ReturnType<typeof getTheme>) {
  return {
    "paneProperties.background": t.bg,
    "paneProperties.backgroundType": "solid" as const,
    "paneProperties.vertGridProperties.color": t.grid,
    "paneProperties.horzGridProperties.color": t.grid,
    "scalesProperties.textColor": t.text,
    "scalesProperties.lineColor": t.scaleLine,
    "mainSeriesProperties.candleStyle.upColor": t.up,
    "mainSeriesProperties.candleStyle.downColor": t.down,
    "mainSeriesProperties.candleStyle.wickUpColor": t.up,
    "mainSeriesProperties.candleStyle.wickDownColor": t.down,
    "mainSeriesProperties.candleStyle.borderUpColor": t.up,
    "mainSeriesProperties.candleStyle.borderDownColor": t.down,
    "mainSeriesProperties.candleStyle.drawWick": true,
    "mainSeriesProperties.candleStyle.drawBorder": true,
  };
}

function injectBg(container: HTMLElement, bg: string) {
  const iframe = container.querySelector("iframe");
  if (!iframe?.contentDocument?.head) return;
  const doc = iframe.contentDocument;
  let el = doc.getElementById("shear-bg") as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = "shear-bg";
    doc.head.appendChild(el);
  }
  el.textContent = `body,.chart-controls-bar,#footer-chart-panel,[class*="drawingToolbar"],[class*="inner-"]{background-color:${bg} !important}`;
}

interface Props {
  base: string;
  quote: string;
  liveRatio?: number;
  entryRatio?: number | null;
  liqRatio?: number | null;
  height?: number;
  /** Fill the parent's height (flex child) instead of using a fixed `height`. */
  fill?: boolean;
  /** Strip all chrome (toolbars, legend, timeframe bar) for a clean embedded mini-chart. */
  minimal?: boolean;
}

export function TvChart({ base, quote, liveRatio, entryRatio, liqRatio, height = 420, fill = false, minimal = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const readyRef = useRef(false);
  const linesRef = useRef<EntityId[]>([]);
  const symbol = `${base}/${quote}`;

  // init / re-init the widget when the market changes
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;
    readyRef.current = false;

    loadScript().then(() => {
      if (cancelled || !container) return;
      widgetRef.current?.remove();
      const t = getTheme();

      const disabledFeatures = [
        "header_symbol_search",
        "header_compare",
        "go_to_date",
        "display_market_status",
        "symbol_info",
      ];
      if (minimal) {
        disabledFeatures.push(
          "header_widget",
          "left_toolbar",
          "timeframes_toolbar",
          "control_bar",
          "legend_widget",
          "edit_buttons_in_legend",
          "context_menus",
          "main_series_scale_menu",
          "border_around_the_chart",
          "scroll_past_realtime",
        );
      }

      const w = new window.TradingView.widget({
        container,
        datafeed: ratioDatafeed,
        symbol,
        interval: "60" as ResolutionString,
        library_path: "/charting_library/",
        locale: "en",
        fullscreen: false,
        autosize: true,
        theme: "dark",
        loading_screen: { backgroundColor: t.bg },
        timezone: "Etc/UTC",
        ...(minimal
          ? { hide_top_toolbar: true, hide_legend: true, hide_side_toolbar: true, hide_volume_ma: true }
          : {}),
        disabled_features: disabledFeatures,
        enabled_features: minimal ? [] : ["side_toolbar_in_fullscreen_mode"],
        overrides: getOverrides(t),
      } as ChartingLibraryWidgetOptions);

      w.onChartReady(() => {
        if (cancelled) return;
        readyRef.current = true;
        w.applyOverrides(getOverrides(t));
        w.setCSSCustomProperty("--tv-color-platform-background", t.bg);
        w.setCSSCustomProperty("--color-bg-primary", t.bg);
        w.setCSSCustomProperty("--tv-color-pane-background", t.bg);
        injectBg(container, t.bg);
      });

      widgetRef.current = w;
    });

    return () => {
      cancelled = true;
      readyRef.current = false;
      widgetRef.current?.remove();
      widgetRef.current = null;
      linesRef.current = [];
    };
  }, [symbol, minimal]);

  // fold the market's live ratio into the forming candle via the datafeed bridge
  useEffect(() => {
    if (!liveRatio || liveRatio <= 0) return;
    pushLiveRatio(base, quote, liveRatio);
  }, [liveRatio, base, quote]);

  // draw entry / liquidation horizontal lines (best-effort - never break the chart)
  useEffect(() => {
    const w = widgetRef.current;
    if (!w || !readyRef.current) return;
    let chart: ReturnType<IChartingLibraryWidget["activeChart"]>;
    try {
      chart = w.activeChart();
    } catch {
      return;
    }
    for (const id of linesRef.current) {
      try {
        chart.removeEntity(id);
      } catch {
        /* already gone */
      }
    }
    linesRef.current = [];

    const addLine = (price: number, color: string, title: string) => {
      try {
        Promise.resolve(
          chart.createShape(
            { time: (Date.now() / 1000) as never, price },
            {
              shape: "horizontal_line",
              lock: true,
              disableSelection: true,
              disableSave: true,
              overrides: { linecolor: color, linestyle: 2, linewidth: 1, showLabel: true, textcolor: color },
              text: title,
            },
          ),
        )
          .then((id) => {
            if (id) linesRef.current.push(id);
          })
          .catch(() => {});
      } catch {
        /* shape API unavailable */
      }
    };

    const t = getTheme();
    if (entryRatio && entryRatio > 0) addLine(entryRatio, t.text, "entry");
    if (liqRatio && liqRatio > 0) addLine(liqRatio, t.down, "liq");
  }, [entryRatio, liqRatio, symbol]);

  return (
    <div
      ref={containerRef}
      className={fill ? "min-h-[420px] w-full flex-1" : "w-full"}
      style={fill ? undefined : { height }}
    />
  );
}
