"use client";

import { useChainEvents, type ChainEvent } from "@/lib/use-chain-events";
import { shortKey } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  ArrowDownRight,
  Flame,
  Activity,
  Coins,
  ExternalLink,
  Layers,
} from "lucide-react";

function iconFor(label: string) {
  if (label.includes("opened")) return { Icon: ArrowUpRight, cls: "text-up" };
  if (label.includes("closed")) return { Icon: ArrowDownRight, cls: "text-muted-foreground" };
  if (label.includes("Liquidation") || label.includes("Bad debt")) return { Icon: Flame, cls: "text-down" };
  if (label.includes("LP")) return { Icon: Layers, cls: "text-primary" };
  if (label.includes("Collateral")) return { Icon: Coins, cls: "text-up" };
  return { Icon: Activity, cls: "text-primary" };
}

function ago(blockTime: number | null) {
  if (!blockTime) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - blockTime));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Row({ e }: { e: ChainEvent }) {
  const { Icon, cls } = iconFor(e.label);
  const inner = (
    <>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", e.err ? "text-down" : cls)} />
      <span className={cn("flex-1 truncate", e.err && "text-down")}>
        {e.label}
        {e.err && " (failed)"}
      </span>
      <span className="shrink-0 rounded bg-secondary px-1 text-[10px] uppercase text-muted-foreground">{e.source}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">{shortKey(e.signature, 4)}</span>
      {e.source === "base" && <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
      <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground/60">{ago(e.blockTime)}</span>
    </>
  );
  if (e.source === "base") {
    return (
      <a
        href={`https://explorer.solana.com/tx/${e.signature}?cluster=devnet`}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/40"
      >
        {inner}
      </a>
    );
  }
  return <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm">{inner}</div>;
}

// Only trade events — opens, closes, liquidations, margin changes (no funding crank
// or generic/unparsed program txs).
const TRADE_LABELS = new Set(["Position opened", "Position closed", "Margin adjusted", "Liquidation"]);

export function ChainActivity({ compact, className }: { compact?: boolean; className?: string }) {
  const { events, loading } = useChainEvents();
  const shown = events.filter((e) => TRADE_LABELS.has(e.label)).slice(0, compact ? 6 : 14);

  return (
    <div className={cn("space-y-1", className)}>
      {shown.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          {loading ? "Reading on-chain trades…" : "No trades on-chain yet."}
        </p>
      ) : (
        shown.map((e) => <Row key={e.signature} e={e} />)
      )}
    </div>
  );
}
