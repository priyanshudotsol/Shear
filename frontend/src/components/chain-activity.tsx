"use client";

import { useEffect, useState } from "react";
import { useChainEvents, type ChainEvent } from "@/lib/use-chain-events";
import type { ActivityEvent } from "@/components/event-feed";
import { fetchVaultUsdc, pda } from "@/lib/chain";
import { baseTxUrl, erTxUrl, fmtUsd, fmtUsdSigned } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  ArrowDownRight,
  Flame,
  Activity,
  Coins,
  ExternalLink,
  Layers,
  Vault,
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

// One explorer-link cell. Shows the layer + short sig as a link when this event ran on that layer;
// otherwise a muted "–". Each event is a single tx on a single layer, so exactly one cell links.
function TxCell({ url, layer }: { url: string | null; layer: "L1" | "ER" }) {
  if (!url) return <span className="w-16 shrink-0 text-center font-mono text-[11px] text-muted-foreground/40">–</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex w-16 shrink-0 items-center justify-center gap-1 font-mono text-[11px] text-primary hover:underline"
      title={`View on ${layer === "L1" ? "Solana L1 (devnet)" : "MagicBlock ER"} explorer`}
    >
      {layer}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function Row({ e }: { e: ChainEvent }) {
  const { Icon, cls } = iconFor(e.label);
  return (
    <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/40">
      <Icon className={cn("h-3.5 w-3.5 shrink-0", e.err ? "text-down" : cls)} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className={cn("truncate", e.err && "text-down")}>
          {e.label}
          {e.err && " (failed)"}
        </span>
        {e.detail && (
          <span className={cn("shrink-0 font-mono text-xs tabular-nums", e.detail.startsWith("+") ? "text-up" : e.detail.startsWith("−") ? "text-down" : "text-muted-foreground")}>
            {e.detail}
          </span>
        )}
      </div>
      <TxCell layer="L1" url={e.source === "base" ? baseTxUrl(e.signature) : null} />
      <TxCell layer="ER" url={e.source === "ER" ? erTxUrl(e.signature) : null} />
      <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground/60">{ago(e.blockTime)}</span>
    </div>
  );
}

// Column header so the two link columns read clearly as L1 vs ER.
function HeaderRow() {
  return (
    <div className="flex items-center gap-2.5 px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
      <span className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">Event</span>
      <span className="w-16 shrink-0 text-center">L1</span>
      <span className="w-16 shrink-0 text-center">ER</span>
      <span className="w-8 shrink-0" />
    </div>
  );
}

// Real money + trade events: USDC moving in/out of the vault (deposits, withdrawals, LP) AND the ER
// trades — everything a reviewer needs to verify the protocol on-chain. Skips funding cranks and
// generic/unparsed program txs.
const SHOWN_LABELS = new Set([
  "Position opened",
  "Position closed",
  "Margin adjusted",
  "Liquidation",
  "Collateral deposit",
  "Collateral withdraw",
  "LP deposit",
  "LP withdraw",
]);

// Live "real USDC is custodied on-chain" proof: the vault PDA's balance + a link to the account.
function VaultBadge() {
  const [usdc, setUsdc] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetchVaultUsdc().then((v) => alive && setUsdc(v)).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return (
    <a
      href={`https://explorer.solana.com/address/${pda.vault().toBase58()}?cluster=devnet`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2.5 py-1.5 text-xs hover:bg-secondary/50"
      title="Protocol vault (PDA) holding real USDC on-chain — click to view the token account on the explorer"
    >
      <Vault className="h-3.5 w-3.5 text-primary" />
      <span className="text-muted-foreground">Vault on-chain</span>
      <span className="font-mono font-semibold text-foreground tabular-nums">{usdc == null ? "…" : fmtUsd(usdc)}</span>
      <ExternalLink className="h-3 w-3 text-muted-foreground/50" />
    </a>
  );
}

// The ER doesn't retain tx-signature history (getSignaturesForAddress drops ER txs after seconds), so
// ER trade rows would vanish from a live read. We persist every open/close signature to the DB at
// trade time, so we source TRADE rows from there (permanent) and use live on-chain reads only for the
// L1 money movements (deposits/withdrawals/LP — which the base layer retains reliably).
function useDbTradeRows(pollMs = 12_000): ChainEvent[] {
  const [rows, setRows] = useState<ChainEvent[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/activity?limit=25`);
        if (!res.ok) return;
        const j = (await res.json()) as { events?: ActivityEvent[] };
        const mapped = (j.events ?? [])
          .filter((e) => e.signature) // need a signature to link
          .map<ChainEvent>((e) => ({
            signature: e.signature as string,
            blockTime: e.ts,
            source: "ER", // opens/closes execute on the ER
            label: e.kind === "open" ? "Position opened" : e.kind === "liquidated" ? "Liquidation" : "Position closed",
            detail:
              e.kind === "open"
                ? `${fmtUsd(e.collateral)} collateral`
                : e.realizedPnl != null
                  ? fmtUsdSigned(e.realizedPnl)
                  : fmtUsd(e.notional),
            err: false,
          }));
        if (alive) setRows(mapped);
      } catch {
        /* keep last */
      }
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);
  return rows;
}

export function ChainActivity({ compact, className }: { compact?: boolean; className?: string }) {
  const { events: chainEvents, loading } = useChainEvents(15_000);
  const dbTrades = useDbTradeRows();
  // L1 money movements from live on-chain reads; ER trades from the persistent DB record.
  const money = chainEvents.filter((e) => e.source === "base" && SHOWN_LABELS.has(e.label));
  const byId = new Map<string, ChainEvent>();
  for (const e of [...dbTrades, ...money]) if (!byId.has(e.signature)) byId.set(e.signature, e);
  const shown = [...byId.values()]
    .sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0))
    .slice(0, compact ? 6 : 14);

  return (
    <div className={cn("space-y-2", className)}>
      <VaultBadge />
      <div className="space-y-1">
        {shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {loading ? "Reading on-chain activity…" : "No on-chain activity yet — open a position or add liquidity."}
          </p>
        ) : (
          <>
            <HeaderRow />
            {shown.map((e) => <Row key={e.signature} e={e} />)}
          </>
        )}
      </div>
    </div>
  );
}
