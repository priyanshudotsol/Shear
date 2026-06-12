"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarket } from "@/context/market";
import { WalletButton } from "@/components/wallet-button";
import { Button } from "@/components/ui/button";
import { Stat, PnlText } from "@/components/common";
import { getTrades, hydrateTrades, tradeStats, type ClosedTrade } from "@/lib/trade-log";
import * as M from "@/lib/shear-math";
import { fmtUsd, fmtUsdSigned, fmtPctRaw, fmtRatio, fmtNum, shortKey } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Copy, UserRound, ArrowRight, Trophy, Flame, TrendingUp, Wallet } from "lucide-react";

function Identicon({ seed, className }: { seed: string; className?: string }) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  const h2 = (h + 90) % 360;
  return (
    <div
      className={cn("grid place-items-center rounded-xl text-white shadow-inner", className)}
      style={{ background: `linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${h2} 70% 40%))` }}
    >
      <UserRound className="h-1/2 w-1/2 opacity-90" />
    </div>
  );
}

export default function ProfilePage() {
  const { connected, publicKey } = useWallet();
  const { active, chain } = useMarket();

  // Render localStorage instantly, then hydrate from the durable Postgres copy (survives clears,
  // syncs across devices). Hooks run before the early return to satisfy the rules of hooks.
  const walletAddr = publicKey?.toBase58() ?? null;
  const [history, setHistory] = useState<ClosedTrade[]>([]);
  useEffect(() => {
    if (!walletAddr) return setHistory([]);
    setHistory(getTrades(walletAddr));
    hydrateTrades(walletAddr).then(setHistory).catch(() => {});
  }, [walletAddr]);

  if (!connected || !publicKey) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border py-16 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-secondary text-muted-foreground">
            <Wallet className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-xl font-semibold">Connect to see your profile</h1>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Your trade history, PnL and stats are tied to your wallet.
          </p>
          <div className="mt-5">
            <WalletButton />
          </div>
        </div>
      </div>
    );
  }

  const addr = publicKey.toBase58();
  const s = tradeStats(history, chain.market?.takerFeeBps ?? 6);

  // real on-chain account state
  const walletUsdc = chain.mockUsdc; // wallet balance of the protocol's USDC (Circle devnet USDC)
  const free = chain.userFree ?? 0;
  const lpValue = chain.pool ? M.usdcForShares(chain.lpShares, chain.pool.totalShares, chain.pool.poolUsdc) : 0;
  const openEquity = chain.positions.reduce(
    (sum, p) =>
      sum +
      M.positionMetrics({
        side: p.side,
        notional: p.notional,
        collateral: p.collateral,
        entryRatio: p.entryRatio,
        curRatio: active.ratio,
        cumNow: chain.market?.cumFunding ?? 0,
        cumEntry: p.entryCumFunding,
      }).equity,
    0
  );
  const accountTotal = walletUsdc + free + openEquity + lpValue;
  const pnlPositive = s.realizedPnl >= 0;
  const lossAbs = Math.abs(s.totalLoss);
  const pnlSplit = s.totalProfit + lossAbs;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      {/* header */}
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card/70 p-5 sm:flex-row sm:items-center">
        <Identicon seed={addr} className="h-16 w-16 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-mono text-lg font-semibold">{shortKey(addr, 6)}</h1>
            <button
              onClick={() => {
                navigator.clipboard.writeText(addr);
                toast.success("Address copied");
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded bg-secondary px-1.5 py-0.5">Solana devnet</span>
            {chain.market?.delegated && <span className="rounded bg-up/15 px-1.5 py-0.5 text-up">trading live</span>}
            {s.firstTradeTs && <span>Trading since {new Date(s.firstTradeTs * 1000).toLocaleDateString()}</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Account value</div>
          <div className="font-mono text-2xl font-semibold tnum">{fmtUsd(accountTotal)}</div>
        </div>
      </div>

      {/* account breakdown — real chain state */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card/70 p-4">
          <Stat label="Wallet balance" value={fmtUsd(walletUsdc)} sub="USDC (devnet)" />
        </div>
        <div className="rounded-xl border border-border bg-card/70 p-4">
          <Stat label="Free collateral" value={fmtUsd(free)} sub="deposited, unlocked" />
        </div>
        <div className="rounded-xl border border-border bg-card/70 p-4">
          <Stat
            label="Open positions"
            value={chain.positions.length ? <PnlText value={openEquity} withSign={false} /> : "—"}
            sub={chain.positions.length ? `${chain.positions.length} open · live equity` : "no open positions"}
          />
        </div>
        <div className="rounded-xl border border-border bg-card/70 p-4">
          <Stat label="LP value" value={fmtUsd(lpValue)} sub={`${fmtNum(chain.lpShares, 2)} shares`} />
        </div>
      </div>

      {/* performance stats */}
      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Performance</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Trades" value={fmtNum(s.trades)} />
        <Metric label="Win rate" value={fmtPctRaw(s.winRate, 0)} accent={s.winRate >= 0.5 && s.trades > 0 ? "up" : undefined} />
        <Metric label="Realized PnL" value={fmtUsdSigned(s.realizedPnl)} accent={s.trades === 0 ? undefined : pnlPositive ? "up" : "down"} />
        <Metric label="Volume" value={fmtUsd(s.volume, 0)} />
        <Metric label="Avg / trade" value={fmtUsdSigned(s.avgPnl)} accent={s.trades === 0 ? undefined : s.avgPnl >= 0 ? "up" : "down"} />
        <Metric label="Liquidations" value={fmtNum(s.liquidations)} accent={s.liquidations > 0 ? "down" : undefined} />
      </div>

      {/* pnl + side split */}
      {s.trades > 0 && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-card/70 p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <TrendingUp className="h-4 w-4 text-primary" /> Profit vs loss
            </div>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-secondary">
              <div className="bg-up" style={{ width: `${pnlSplit > 0 ? (s.totalProfit / pnlSplit) * 100 : 0}%` }} />
              <div className="bg-down" style={{ width: `${pnlSplit > 0 ? (lossAbs / pnlSplit) * 100 : 0}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-xs">
              <span className="text-up">Profit {fmtUsd(s.totalProfit)}</span>
              <span className="text-down">Loss {fmtUsd(lossAbs)}</span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2">
                <Trophy className="h-4 w-4 text-up" />
                <span className="text-muted-foreground">Best</span>
                <span className="ml-auto"><PnlText value={s.bestTrade?.realizedPnl ?? 0} /></span>
              </div>
              <div className="flex items-center gap-2">
                <Flame className="h-4 w-4 text-down" />
                <span className="text-muted-foreground">Worst</span>
                <span className="ml-auto"><PnlText value={s.worstTrade?.realizedPnl ?? 0} /></span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card/70 p-5">
            <div className="mb-3 text-sm font-semibold">Direction & costs</div>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-secondary">
              <div className="bg-up/70" style={{ width: `${s.trades ? (s.longCount / s.trades) * 100 : 0}%` }} />
              <div className="bg-down/70" style={{ width: `${s.trades ? (s.shortCount / s.trades) * 100 : 0}%` }} />
            </div>
            <div className="mt-2 flex justify-between text-xs">
              <span className="text-up">Long {s.longCount}</span>
              <span className="text-down">Short {s.shortCount}</span>
            </div>
            <div className="mt-4 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Wins / Losses</span>
                <span className="font-mono">{s.wins} / {s.losses}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Est. fees paid</span>
                <span className="font-mono">{fmtUsd(s.estFees)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* trade history */}
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Trade history</h2>
        <Button render={<Link href="/trade" />} nativeButton={false} variant="secondary" size="sm" className="gap-2">
          New trade <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
      {history.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          No trades yet. Close a position and it&apos;ll be recorded here with its realized PnL.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Date</th>
                <th className="px-4 py-2.5 text-left font-medium">Side</th>
                <th className="px-4 py-2.5 text-right font-medium">Notional</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Entry → Exit</th>
                <th className="px-4 py-2.5 text-right font-medium">PnL</th>
                <th className="px-4 py-2.5 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-border/60">
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(h.closedTs * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    <span className="ml-1 opacity-50">
                      {new Date(h.closedTs * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn("font-semibold uppercase", h.side === "long" ? "text-up" : "text-down")}>{h.side}</span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{fmtUsd(h.notional)}</td>
                  <td className="hidden px-4 py-3 text-right font-mono text-muted-foreground sm:table-cell">
                    {fmtRatio(h.entryRatio)} → {fmtRatio(h.exitRatio)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PnlText value={h.realizedPnl} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-xs",
                        h.status === "liquidated" ? "bg-down/15 text-down" : "bg-secondary text-muted-foreground"
                      )}
                    >
                      {h.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: "up" | "down" }) {
  return (
    <div className="rounded-xl border border-border bg-card/70 p-4">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1.5 font-mono text-xl font-semibold tnum", accent === "up" && "text-up", accent === "down" && "text-down")}>
        {value}
      </div>
    </div>
  );
}
