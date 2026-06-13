"use client";

import { useMarket } from "@/context/market";
import { RatioChart } from "@/components/ratio-chart";
import { fmtRatio, fmtPct, fmtPctRaw } from "@/lib/format";
import { cn } from "@/lib/utils";

export function LiveTeaser() {
  const { active } = useMarket();
  const { ratio, ratioChange: ratioChange24h, fundingRatePerHr, skew, base, quote, symbol } = active;
  const up = ratioChange24h >= 0;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card/80 p-5 shadow-2xl backdrop-blur">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{symbol}</span>
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide">Ratio perp</span>
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="font-mono text-3xl font-semibold tnum">{fmtRatio(ratio)}</span>
            <span className={cn("font-mono text-sm tnum", up ? "text-up" : "text-down")}>{fmtPct(ratioChange24h)}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Funding / hr</div>
          <div className="font-mono text-sm tnum">{fmtPctRaw(fundingRatePerHr, 4)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            skew <span className="font-mono">{(skew * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>
      <div className="-mx-2">
        <RatioChart base={base} quote={quote} liveRatio={ratio} height={200} visibleBars={48} />
      </div>
      <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
    </div>
  );
}
