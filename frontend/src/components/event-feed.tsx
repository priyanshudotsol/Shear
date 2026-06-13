"use client";

// DB-backed activity feed. With no `owner` it renders the global feed (/api/activity = recent events
// across all wallets); with an `owner` it renders that wallet's activity (/api/events?owner=). Events
// are the persisted trade log (opens + closes + liquidations) - see src/lib/server/trades.ts.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { fmtUsd, fmtUsdSigned, shortKey } from "@/lib/format";
import { ArrowUpRight, ArrowDownRight, Flame, Activity } from "lucide-react";

export interface ActivityEvent {
  id: string;
  owner: string;
  kind: "open" | "close" | "liquidated";
  symbol: string;
  side: "long" | "short";
  notional: number;
  collateral: number;
  leverage: number;
  ratio: number;
  realizedPnl: number | null;
  ts: number; // unix seconds
}

const META: Record<ActivityEvent["kind"], { icon: typeof Activity; cls: string; verb: string }> = {
  open: { icon: ArrowUpRight, cls: "text-up", verb: "opened" },
  close: { icon: ArrowDownRight, cls: "text-muted-foreground", verb: "closed" },
  liquidated: { icon: Flame, cls: "text-down", verb: "liquidated" },
};

function ago(ts: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function EventFeed({
  owner,
  limit = 14,
  pollMs = 10_000,
  className,
}: {
  owner?: string | null;
  limit?: number;
  pollMs?: number;
  className?: string;
}) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const url = owner ? `/api/events?owner=${owner}&limit=${limit}` : `/api/activity?limit=${limit}`;
    const load = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const j = (await res.json()) as { events?: ActivityEvent[] };
        if (alive) setEvents(Array.isArray(j.events) ? j.events : []);
      } catch {
        /* keep showing whatever we have */
      } finally {
        if (alive) setLoaded(true);
      }
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [owner, limit, pollMs]);

  if (loaded && events.length === 0) {
    return <p className={cn("px-2 py-6 text-center text-sm text-muted-foreground", className)}>No activity yet.</p>;
  }

  return (
    <div className={cn("space-y-1", className)}>
      {events.map((e) => {
        const m = META[e.kind] ?? META.close;
        const Icon = m.icon;
        const long = e.side === "long";
        const detail =
          e.kind === "open" ? fmtUsd(e.notional) : e.realizedPnl != null ? fmtUsdSigned(e.realizedPnl) : fmtUsd(e.notional);
        return (
          <div key={e.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/40">
            <Icon className={cn("h-3.5 w-3.5 shrink-0", m.cls)} />
            <span className="flex-1 truncate text-muted-foreground">
              {owner ? null : <span className="font-mono text-foreground/70">{shortKey(e.owner, 4)} </span>}
              {m.verb} <span className={cn("font-medium", long ? "text-up" : "text-down")}>{e.side}</span> {e.symbol}
              {e.kind === "open" && <span className="text-muted-foreground/70"> {e.leverage.toFixed(0)}×</span>}
            </span>
            <span
              className={cn(
                "shrink-0 font-mono text-xs",
                e.kind === "close" && e.realizedPnl != null
                  ? e.realizedPnl >= 0
                    ? "text-up"
                    : "text-down"
                  : "text-muted-foreground/70"
              )}
            >
              {detail}
            </span>
            <span className="w-8 shrink-0 text-right font-mono text-xs text-muted-foreground/50">{ago(e.ts)}</span>
          </div>
        );
      })}
    </div>
  );
}
