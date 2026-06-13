"use client";

import { useState } from "react";
import { useMarket } from "@/context/market";
import type { MarketSnap } from "@/lib/market-engine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Stat, PnlText } from "@/components/common";
import { cn } from "@/lib/utils";
import { fmtUsd, fmtUsdSigned, fmtRatio, fmtPct } from "@/lib/format";
import * as M from "@/lib/shear-math";
import { toast } from "sonner";
import { X, Plus, Minus, Zap } from "lucide-react";

export function PositionCard({ market }: { market: MarketSnap }) {
  const { close } = useMarket();
  const p = market.position;
  if (!p) return null;
  const m = M.positionMetrics({
    side: p.side,
    notional: p.notional,
    collateral: p.collateral,
    entryRatio: p.entryRatio,
    curRatio: market.ratio,
    cumNow: market.cumFunding,
    cumEntry: p.entryCumFunding,
  });

  const span = Math.abs(p.entryRatio - m.liqRatio) || 1;
  const dist = p.side === "long" ? market.ratio - m.liqRatio : m.liqRatio - market.ratio;
  const health = Math.max(0, Math.min(1, dist / span));
  const long = p.side === "long";

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card/60">
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wide",
              long ? "bg-up/15 text-up" : "bg-down/15 text-down"
            )}
          >
            {p.side}
          </span>
          <span className="font-semibold">{market.symbol}</span>
          <span className="font-mono text-sm text-muted-foreground">{p.leverage}×</span>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-primary">
          <Zap className="h-3 w-3" /> gasless
        </span>
      </div>

      <div className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
        <Stat
          label="Live equity"
          value={<PnlText value={m.equity} withSign={false} />}
          sub={
            <span className={m.upnl >= 0 ? "text-up" : "text-down"}>
              {fmtUsdSigned(m.upnl)} ({fmtPct(m.pnlPct)})
            </span>
          }
        />
        <Stat label="Notional" value={fmtUsd(p.notional)} sub={`collateral ${fmtUsd(p.collateral)}`} />
        <Stat label="Entry ratio" value={fmtRatio(p.entryRatio)} sub={`now ${fmtRatio(market.ratio)}`} />
        <Stat
          label="Margin ratio"
          value={`${(m.marginRatio * 100).toFixed(2)}%`}
          sub={`maint. ${((M.maintenanceMargin(p.notional) / p.notional) * 100).toFixed(0)}%`}
          valueClassName={m.marginRatio < 0.08 ? "text-down" : ""}
        />
      </div>

      <div className="px-5 pb-5">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Distance to liquidation</span>
          <span className="font-mono">
            liq {fmtRatio(m.liqRatio)} · {(health * 100).toFixed(0)}% buffer
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full transition-all duration-300",
              health > 0.5 ? "bg-up" : health > 0.2 ? "bg-amber-400" : "bg-down"
            )}
            style={{ width: `${Math.max(2, health * 100)}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
          <span>liquidation</span>
          <span>entry</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border/60 p-4">
        <ModifyDialog symbol={market.symbol} mode="add" collateral={p.collateral} />
        <ModifyDialog symbol={market.symbol} mode="remove" collateral={p.collateral} />
        <Button
          variant="destructive"
          className="ml-auto gap-2"
          onClick={() => {
            const closed = close(market.symbol);
            const pnl = closed?.realizedPnl ?? 0;
            toast.success(`Closed ${market.symbol} · settle ${fmtUsd(closed?.settlement ?? 0)} (${fmtUsdSigned(pnl)})`);
          }}
        >
          <X className="h-4 w-4" /> Close position
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border/60 text-sm sm:grid-cols-3">
        <Sub label="Accrued funding" value={<PnlText value={-m.funding} />} />
        <Sub label="Est. close fee" value={fmtUsd(m.fees)} />
        <Sub label="Status" value={<span className="text-up">{m.healthy ? "Healthy" : "At risk"}</span>} />
      </div>
    </div>
  );
}

function Sub({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-card px-5 py-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono">{value}</div>
    </div>
  );
}

function ModifyDialog({ symbol, mode, collateral }: { symbol: string; mode: "add" | "remove"; collateral: number }) {
  const { addCollateral, removeCollateral, freeCollateral } = useMarket();
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState("");
  const n = parseFloat(amt) || 0;
  const isAdd = mode === "add";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="gap-1.5">
            {isAdd ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
            {isAdd ? "Add" : "Remove"} margin
          </Button>
        }
      />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {isAdd ? "Add" : "Remove"} collateral · {symbol}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {isAdd
            ? "Lower effective leverage and push liquidation further away."
            : "Free up margin - keep resulting equity above maintenance."}
        </p>
        <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3 text-sm">
          <span className="text-muted-foreground">{isAdd ? "Free collateral" : "Position collateral"}</span>
          <span className="font-mono">{fmtUsd(isAdd ? freeCollateral : collateral)}</span>
        </div>
        <Input
          type="number"
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          placeholder="0.00"
          className="font-mono"
        />
        <Button
          onClick={() => {
            if (n <= 0) return toast.error("Enter an amount");
            if (isAdd) {
              if (n > freeCollateral) return toast.error("Exceeds free collateral");
              addCollateral(symbol, n);
              toast.success(`Added ${fmtUsd(n)} margin`);
            } else {
              removeCollateral(symbol, n);
              toast.success(`Removed ${fmtUsd(n)} margin`);
            }
            setAmt("");
            setOpen(false);
          }}
        >
          Confirm
        </Button>
      </DialogContent>
    </Dialog>
  );
}
