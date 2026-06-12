"use client";

import { useMarket } from "@/context/market";
import { MarketSelector } from "@/components/market-selector";
import { fmtRatio, fmtPct, fmtPctRaw, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import * as M from "@/lib/shear-math";

export function MarketStatsBar() {
  const { active, chain, priceLive } = useMarket();
  const up = active.ratioChange >= 0;
  const longOi = chain.market?.longOi ?? 0;
  const shortOi = chain.market?.shortOi ?? 0;
  const fundingRatePerHr = M.fundingRate(M.skew(longOi, shortOi));
  const util = chain.pool ? M.netUtilization(longOi, shortOi, chain.pool.poolUsdc) : 0;

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-border bg-card/70 px-4 py-3">
      <div className="flex items-center gap-3">
        <MarketSelector />
        <div className="hidden sm:block">
          <div className="text-xs text-muted-foreground">Ratio perpetual</div>
          <div className="text-xs text-muted-foreground/70">
            {active.base}/USD ÷ {active.quote}/USD
          </div>
        </div>
      </div>

      <Cell label="Ratio">
        <span className="font-mono text-lg font-semibold tnum">{fmtRatio(active.ratio)}</span>
      </Cell>
      <Cell label="24h">
        <span className={cn("font-mono tnum", up ? "text-up" : "text-down")}>{fmtPct(active.ratioChange)}</span>
      </Cell>
      <Cell label="Funding / hr">
        <span className="font-mono tnum">{fmtPctRaw(fundingRatePerHr, 4)}</span>
      </Cell>
      <Cell label="Open interest">
        <span className="font-mono tnum">{fmtUsd(longOi + shortOi, 0)}</span>
      </Cell>
      <Cell label="Pool util">
        <span className={cn("font-mono tnum", util > 0.45 ? "text-down" : "")}>{fmtPctRaw(util, 1)}</span>
      </Cell>
      <Cell label={`${active.base} / ${active.quote} · Pyth`} className="ml-auto hidden lg:block">
        {priceLive ? (
          <span className="font-mono text-sm tnum text-muted-foreground">
            {fmtUsd(active.basePrice)} <span className="opacity-40">·</span> {fmtUsd(active.quotePrice)}
          </span>
        ) : (
          <span className="font-mono text-sm tnum text-muted-foreground/50 animate-ticker">syncing…</span>
        )}
      </Cell>
    </div>
  );
}

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function OpenInterest() {
  const { active, chain } = useMarket();
  const longOi = chain.market?.longOi ?? 0;
  const shortOi = chain.market?.shortOi ?? 0;
  const total = longOi + shortOi;
  const longPct = total > 0 ? (longOi / total) * 100 : 50;
  return (
    <div className="rounded-xl border border-border bg-card/70 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Open interest · {active.symbol}</h3>
        <span className="font-mono text-xs text-muted-foreground">{fmtUsd(total, 0)}</span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-secondary">
        <div className="bg-up" style={{ width: `${longPct}%` }} />
        <div className="bg-down" style={{ width: `${100 - longPct}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs">
        <span className="text-up">Long {fmtUsd(longOi, 0)}</span>
        <span className="text-down">Short {fmtUsd(shortOi, 0)}</span>
      </div>
      {total === 0 && <p className="mt-2 text-[11px] text-muted-foreground">No open interest on-chain yet.</p>}
    </div>
  );
}
