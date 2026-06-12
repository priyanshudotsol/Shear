"use client";

import Link from "next/link";
import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { useMarket, type MarketSnap } from "@/context/market";
import { WalletButton } from "@/components/wallet-button";
import { Button } from "@/components/ui/button";
import { Stat, PnlText } from "@/components/common";
import type { ChainData } from "@/lib/use-chain-data";
import type { ChainPosition } from "@/lib/chain";
import { closePositionER, settleAndWithdraw } from "@/lib/chain-trade";
import { recordTrade } from "@/lib/trade-log";
import { fmtUsd, fmtUsdSigned, fmtRatio, fmtPct } from "@/lib/format";
import * as M from "@/lib/shear-math";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Inbox, ArrowRight, X, Zap } from "lucide-react";

export default function PositionsPage() {
  const { connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { active, chain } = useMarket();
  const positions = chain.positions; // all open positions for the connected wallet
  const usdcMint = chain.config?.usdcMint;
  const [busy, setBusy] = useState<string | null>(null);
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function withdrawAll() {
    if (!anchorWallet || !usdcMint) return toast.error("Connect a wallet");
    const owner = anchorWallet.publicKey.toBase58();
    // snapshot the positions being closed (with realized PnL) so we can log them after success
    const toRecord = positions.map((p) => {
      const m = M.positionMetrics({ side: p.side, notional: p.notional, collateral: p.collateral, entryRatio: p.entryRatio, curRatio: active.ratio, cumNow: chain.market?.cumFunding ?? 0, cumEntry: p.entryCumFunding });
      return { symbol: active.symbol, side: p.side, notional: p.notional, collateral: p.collateral, leverage: p.collateral > 0 ? p.notional / p.collateral : 0, entryRatio: p.entryRatio, exitRatio: active.ratio, realizedPnl: m.upnl, status: "closed" as const };
    });
    try {
      const { closed, withdrawn } = await settleAndWithdraw(anchorWallet, new PublicKey(usdcMint), active.symbol, setBusy);
      toRecord.slice(0, closed).forEach((t) => recordTrade(owner, t));
      if (withdrawn <= 0) toast.message(closed ? `Closed ${closed}; nothing to withdraw` : "Nothing to withdraw");
      else toast.success(`Closed ${closed} · withdrew ${fmtUsd(withdrawn)} to your wallet`);
      setTimeout(chain.refresh, 1500);
    } catch (e) {
      toast.error(`Settle failed: ${errMsg(e).slice(0, 140)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Positions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Isolated margin · up to 8 concurrent positions · settled against the LP pool · live on the MagicBlock ER.
          </p>
        </div>
        <Button render={<Link href="/trade" />} nativeButton={false} variant="secondary" size="sm" className="gap-2">
          Trade <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-6">
        {!connected ? (
          <Empty title="Connect your wallet" body="Connect to view and manage your open positions." action={<WalletButton />} />
        ) : positions.length === 0 ? (
          <Empty
            title="No open positions"
            body="Open a ratio perp on SOL-ETH to get started — hold up to 8 longs/shorts at once."
            action={
              <Button render={<Link href="/trade" />} nativeButton={false} className="gap-2">
                Open a position <ArrowRight className="h-4 w-4" />
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{positions.length} open position{positions.length > 1 ? "s" : ""}</span>
              <Button onClick={withdrawAll} disabled={!!busy} variant="secondary" size="sm">
                {busy ?? "Close all & withdraw to wallet"}
              </Button>
            </div>
            {positions.map((p) => (
              <RealPositionCard key={p.slot} pos={p} active={active} chain={chain} disabled={!!busy} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RealPositionCard({ pos: p, active, chain, disabled }: { pos: ChainPosition; active: MarketSnap; chain: ChainData; disabled: boolean }) {
  const anchorWallet = useAnchorWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const leverage = p.collateral > 0 ? p.notional / p.collateral : 0;
  const m = M.positionMetrics({
    side: p.side,
    notional: p.notional,
    collateral: p.collateral,
    entryRatio: p.entryRatio,
    curRatio: active.ratio,
    cumNow: chain.market?.cumFunding ?? 0,
    cumEntry: p.entryCumFunding,
  });
  const long = p.side === "long";
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function close() {
    if (!anchorWallet) return toast.error("Connect a wallet");
    try {
      setBusy("Closing on the ER…");
      const sig = await closePositionER(anchorWallet, active.symbol, p.slot);
      recordTrade(anchorWallet.publicKey.toBase58(), {
        symbol: active.symbol, side: p.side, notional: p.notional, collateral: p.collateral,
        leverage: p.collateral > 0 ? p.notional / p.collateral : 0, entryRatio: p.entryRatio,
        exitRatio: active.ratio, realizedPnl: m.upnl, status: "closed", signature: sig,
      });
      toast.success(`Closed ${p.side} · settled to free collateral · ${sig.slice(0, 8)}`);
      setTimeout(chain.refresh, 1500);
    } catch (e) {
      toast.error(`Close failed: ${errMsg(e).slice(0, 140)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card/70">
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className={cn("rounded-md px-2 py-1 text-xs font-bold uppercase tracking-wide", long ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
            {p.side}
          </span>
          <span className="font-semibold">{active.symbol}</span>
          <span className="font-mono text-sm text-muted-foreground">{leverage.toFixed(1)}×</span>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-primary">
          <Zap className="h-3 w-3" /> on the ER
        </span>
      </div>

      <div className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
        <Stat
          label="Live equity"
          value={<PnlText value={m.equity} withSign={false} />}
          sub={<span className={m.upnl >= 0 ? "text-up" : "text-down"}>{fmtUsdSigned(m.upnl)} ({fmtPct(m.pnlPct)})</span>}
        />
        <Stat label="Notional" value={fmtUsd(p.notional)} sub={`collateral ${fmtUsd(p.collateral)}`} />
        <Stat label="Entry ratio" value={fmtRatio(p.entryRatio)} sub={`now ${fmtRatio(active.ratio)}`} />
        <Stat label="Liquidation" value={fmtRatio(m.liqRatio)} sub={m.healthy ? "healthy" : "at risk"} />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 p-4">
        <span className="text-xs text-muted-foreground">slot {p.slot}</span>
        <Button onClick={close} disabled={disabled || !!busy} variant="destructive" className="ml-auto gap-2">
          <X className="h-4 w-4" /> {busy ?? "Close"}
        </Button>
      </div>
    </div>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-secondary text-muted-foreground">
        <Inbox className="h-6 w-6" />
      </div>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      <div className="mt-5">{action}</div>
    </div>
  );
}
