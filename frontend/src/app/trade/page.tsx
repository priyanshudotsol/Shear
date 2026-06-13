"use client";

import { useMarket } from "@/context/market";
import { RatioChart } from "@/components/ratio-chart";
import { OrderPanel } from "@/components/trade/order-panel";
import { MarketStatsBar, OpenInterest } from "@/components/trade/market-stats";
import { PositionsPanel } from "@/components/trade/positions-panel";
import { EventFeed } from "@/components/event-feed";
import { ErBadge } from "@/components/status-badges";
import { PageBackdrop } from "@/components/common";
import { Activity } from "lucide-react";
import * as M from "@/lib/shear-math";

export default function TradePage() {
  const { active, chain } = useMarket();
  const { ratio, symbol } = active;
  const position = chain.positions[0] ?? null; // show the first open position's lines on the chart
  const liqRatio = position
    ? M.liquidationRatio(position.side, position.entryRatio, position.notional / position.collateral)
    : null;

  return (
    <div className="relative mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <PageBackdrop />
      <MarketStatsBar />

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* chart */}
        <div className="flex flex-col rounded-2xl border border-border bg-card/60">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold">{symbol}</span>
              <span className="font-mono text-muted-foreground tnum">{ratio.toPrecision(6)}</span>
            </div>
            <ErBadge />
          </div>
          <div className="p-4">
            <RatioChart base={active.base} quote={active.quote} liveRatio={ratio} entryRatio={position?.entryRatio} liqRatio={liqRatio} height={420} />
            {position && (
              <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4 bg-foreground/60" /> entry {position.entryRatio.toPrecision(6)}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-4 bg-down" /> liquidation {liqRatio?.toPrecision(6)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* order panel + live activity */}
        <div className="space-y-4">
          <OrderPanel />
          <div className="rounded-2xl border border-border bg-card/60">
            <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3 text-sm">
              <Activity className="h-3.5 w-3.5 text-primary" />
              <span className="font-semibold">Recent activity</span>
              <span className="text-xs text-muted-foreground">· all traders</span>
            </div>
            <div className="p-2">
              <EventFeed limit={12} />
            </div>
          </div>
        </div>
      </div>

      {/* positions / open orders / history — below the trading terminal */}
      <div className="mt-4">
        <PositionsPanel />
      </div>

      {/* open interest split */}
      <div className="mt-4 max-w-md">
        <OpenInterest />
      </div>
    </div>
  );
}
