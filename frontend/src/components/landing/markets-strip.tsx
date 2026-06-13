"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { useMarket } from "@/context/market";
import { fmtRatio, fmtPct, fmtPctRaw } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ArrowUpRight } from "lucide-react";

const MotionLink = motion.create(Link);

export function MarketsStrip() {
  const { markets, setActiveMarket, priceLive } = useMarket();

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {markets.map((m) => {
        const up = m.ratioChange >= 0;
        return (
          <MotionLink
            key={m.symbol}
            href="/trade"
            onClick={() => setActiveMarket(m.symbol)}
            whileHover={{ y: -6, scale: 1.02 }}
            whileTap={{ scale: 0.99 }}
            transition={{ type: "spring", stiffness: 300, damping: 22 }}
            className="group relative block overflow-hidden rounded-2xl border border-border bg-card/60 p-5 hover:border-primary/40 hover:bg-card"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="text-base font-semibold tracking-tight">{m.symbol}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {m.base}/USD ÷ {m.quote}/USD
                </div>
              </div>
              <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
            </div>

            <div className="mt-6 flex items-end justify-between">
              <div>
                <div className="font-mono text-2xl font-semibold tnum">
                  {priceLive ? fmtRatio(m.ratio) : "-"}
                </div>
                <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">ratio</div>
              </div>
              <div className="text-right">
                <div
                  className={cn(
                    "rounded-md px-2 py-1 font-mono text-sm tnum",
                    up ? "bg-up/10 text-up" : "bg-down/10 text-down"
                  )}
                >
                  {fmtPct(m.ratioChange)}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  funding {fmtPctRaw(m.fundingRatePerHr, 3)}/h
                </div>
              </div>
            </div>

            <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-primary/5 blur-2xl transition-opacity group-hover:opacity-100 opacity-0" />
          </MotionLink>
        );
      })}
    </div>
  );
}
