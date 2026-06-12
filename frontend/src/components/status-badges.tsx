"use client";

import { useMarket } from "@/context/market";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Zap, Activity } from "lucide-react";

export function OracleHealth({ className }: { className?: string }) {
  const { oracleStale, crankTick } = useMarket();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              oracleStale ? "border-down/40 text-down" : "border-up/30 text-up",
              className
            )}
          />
        }
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", oracleStale ? "bg-down" : "bg-up animate-ticker")} />
        {oracleStale ? "Oracle stale" : "Oracle live"}
      </TooltipTrigger>
      <TooltipContent>
        Two Pyth-Lazer feeds (SOL/USD ÷ ETH/USD) read on-chain. Crank tick #{crankTick}.
      </TooltipContent>
    </Tooltip>
  );
}

export function SessionBadge({ className }: { className?: string }) {
  const { sessionActive } = useMarket();
  if (!sessionActive) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary",
              className
            )}
          />
        }
      >
        <Zap className="h-3 w-3" />
        Gasless session
      </TooltipTrigger>
      <TooltipContent>Session key active — open/close are popup-free and fee-free for 1h.</TooltipContent>
    </Tooltip>
  );
}

export function ErBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Activity className="h-3 w-3 text-primary" />
      MagicBlock ER
    </span>
  );
}
