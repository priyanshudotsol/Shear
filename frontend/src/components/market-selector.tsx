"use client";

import { useMarket } from "@/context/market";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChevronDown, Check } from "lucide-react";
import { fmtRatio, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

export function MarketSelector({ size = "default" }: { size?: "sm" | "default" }) {
  const { markets, activeMarket, setActiveMarket } = useMarket();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="secondary" size={size} className="gap-2 rounded-none font-semibold" />}>
        {activeMarket}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 rounded-none">
        {markets.map((m) => {
          const up = m.ratioChange >= 0;
          return (
            <DropdownMenuItem
              key={m.symbol}
              onClick={() => setActiveMarket(m.symbol)}
              className="flex items-center gap-2"
            >
              <span className="w-4">
                {m.symbol === activeMarket && <Check className="h-3.5 w-3.5 text-primary" />}
              </span>
              <span className="font-semibold">{m.symbol}</span>
              <span className="ml-auto flex items-center gap-2 font-mono text-xs">
                <span className="text-muted-foreground">{fmtRatio(m.ratio)}</span>
                <span className={cn(up ? "text-up" : "text-down")}>{fmtPct(m.ratioChange)}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
