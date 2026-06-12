"use client";

import { useMarket } from "@/context/market";
import { cn } from "@/lib/utils";
import type { FeedEvent } from "@/lib/market-engine";
import { ArrowUpRight, ArrowDownRight, Flame, Coins, Activity } from "lucide-react";

const META: Record<FeedEvent["kind"], { icon: typeof Activity; cls: string }> = {
  opened: { icon: ArrowUpRight, cls: "text-up" },
  closed: { icon: ArrowDownRight, cls: "text-muted-foreground" },
  liquidated: { icon: Flame, cls: "text-down" },
  funding: { icon: Activity, cls: "text-primary" },
  deposit: { icon: Coins, cls: "text-up" },
  withdraw: { icon: Coins, cls: "text-muted-foreground" },
  crank: { icon: Activity, cls: "text-primary" },
};

function ago(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

export function EventFeed({ className, compact }: { className?: string; compact?: boolean }) {
  const { events } = useMarket();
  return (
    <div className={cn("space-y-1", className)}>
      {events.slice(0, compact ? 6 : 14).map((e) => {
        const m = META[e.kind];
        const Icon = m.icon;
        return (
          <div key={e.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/40">
            <Icon className={cn("h-3.5 w-3.5 shrink-0", m.cls)} />
            <span className="flex-1 truncate text-muted-foreground">{e.text}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground/60">{ago(e.ts)}</span>
          </div>
        );
      })}
    </div>
  );
}
