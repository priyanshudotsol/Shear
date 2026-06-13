"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarket } from "@/context/market";
import { WalletButton } from "@/components/wallet-button";
import { Button } from "@/components/ui/button";
import { PnlText, PageBackdrop } from "@/components/common";
import { Reveal } from "@/components/motion";
import { EventFeed } from "@/components/event-feed";
import { getTrades, hydrateTrades, tradeStats, type ClosedTrade } from "@/lib/trade-log";
import * as M from "@/lib/shear-math";
import { fmtUsd, fmtUsdSigned, fmtPctRaw, fmtRatio, fmtNum, shortKey } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Copy, UserRound, ArrowRight, Trophy, Flame, TrendingUp, Wallet, Coins, Activity, Layers } from "lucide-react";

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
      <div className="relative mx-auto flex min-h-[70vh] max-w-2xl items-center px-4 py-12 sm:px-6">
        <Reveal className="relative w-full overflow-hidden rounded-3xl border border-border bg-card/60 p-8 text-center shadow-sm sm:p-12">
          <div className="pointer-events-none absolute -left-24 -top-28 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 -right-20 h-52 w-52 rounded-full bg-primary/5 blur-3xl" />

          <div className="relative mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-primary/25 to-primary/5 ring-1 ring-primary/20">
            <Wallet className="h-7 w-7 text-primary" />
          </div>

          <h1 className="relative mt-6 text-2xl font-semibold tracking-tight">Connect your wallet</h1>
          <p className="relative mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Your trade history, realized PnL and performance stats are tied to your wallet - connect to see your full profile.
          </p>

          <div className="relative mt-6 flex justify-center">
            <WalletButton />
          </div>

          <div className="relative mt-9 grid grid-cols-1 gap-3 border-t border-border/60 pt-7 text-left sm:grid-cols-3">
            <FeaturePeek icon={Activity} label="Trade history" sub="Every close, recorded" />
            <FeaturePeek icon={TrendingUp} label="PnL & win rate" sub="Realized performance" />
            <FeaturePeek icon={Wallet} label="Account value" sub="Balances & LP" />
          </div>
        </Reveal>
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
    <div className="relative mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <PageBackdrop />
      {/* header */}
      <Reveal className="relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-card/60 p-5 shadow-sm sm:flex-row sm:items-center">
        <div className="pointer-events-none absolute -left-16 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative shrink-0">
          <Identicon seed={addr} className="h-16 w-16 ring-1 ring-white/10" />
        </div>
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
        <div className="relative text-right">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Account value</div>
          <div className="mt-0.5 font-mono text-3xl font-semibold tnum">{fmtUsd(accountTotal)}</div>
        </div>
      </Reveal>

      {/* account breakdown - real chain state */}
      <Reveal delay={0.05} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <BalanceCard icon={Wallet} label="Wallet balance" value={fmtUsd(walletUsdc)} sub="USDC (devnet)" />
        <BalanceCard icon={Coins} label="Free collateral" value={fmtUsd(free)} sub="deposited, unlocked" />
        <BalanceCard
          icon={Activity}
          label="Open positions"
          value={chain.positions.length ? <PnlText value={openEquity} withSign={false} /> : "-"}
          sub={chain.positions.length ? `${chain.positions.length} open · live equity` : "no open positions"}
        />
        <BalanceCard icon={Layers} label="LP value" value={fmtUsd(lpValue)} sub={`${fmtNum(chain.lpShares, 2)} shares`} />
      </Reveal>

      {/* performance stats */}
      <SectionTitle className="mt-8 mb-3">Performance</SectionTitle>
      <Reveal className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Trades" value={fmtNum(s.trades)} />
        <Metric label="Win rate" value={fmtPctRaw(s.winRate, 0)} accent={s.winRate >= 0.5 && s.trades > 0 ? "up" : undefined} />
        <Metric label="Realized PnL" value={fmtUsdSigned(s.realizedPnl)} accent={s.trades === 0 ? undefined : pnlPositive ? "up" : "down"} />
        <Metric label="Volume" value={fmtUsd(s.volume, 0)} />
        <Metric label="Avg / trade" value={fmtUsdSigned(s.avgPnl)} accent={s.trades === 0 ? undefined : s.avgPnl >= 0 ? "up" : "down"} />
        <Metric label="Liquidations" value={fmtNum(s.liquidations)} accent={s.liquidations > 0 ? "down" : undefined} />
      </Reveal>

      {/* pnl + side split */}
      {s.trades > 0 && (
        <Reveal delay={0.05} className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card/60 p-5">
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

          <div className="rounded-2xl border border-border bg-card/60 p-5">
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
        </Reveal>
      )}

      {/* recent activity (opens + closes) from the DB event log */}
      <div className="mt-8">
        <SectionTitle>Recent activity</SectionTitle>
        <div className="mt-3 rounded-2xl border border-border bg-card/60 p-2">
          <EventFeed owner={addr} limit={12} />
        </div>
      </div>

      {/* trade history */}
      <SectionTitle
        className="mt-8"
        action={
          <Button render={<Link href="/trade" />} nativeButton={false} variant="secondary" size="sm" className="gap-2">
            New trade <ArrowRight className="h-4 w-4" />
          </Button>
        }
      >
        Trade history
      </SectionTitle>
      {history.length === 0 ? (
        <p className="mt-3 rounded-2xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          No trades yet. Close a position and it&apos;ll be recorded here with its realized PnL.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-2xl border border-border">
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
                <tr key={h.id} className="border-t border-border/60 transition-colors hover:bg-secondary/20">
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

function FeaturePeek({ icon: Icon, label, sub }: { icon: typeof Wallet; label: string; sub: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-secondary text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: "up" | "down" }) {
  return (
    <div className="rounded-2xl border border-border bg-card/60 p-4 transition-colors hover:border-primary/40">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1.5 font-mono text-xl font-semibold tnum", accent === "up" && "text-up", accent === "down" && "text-down")}>
        {value}
      </div>
    </div>
  );
}

function BalanceCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Wallet;
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="group rounded-2xl border border-border bg-card/60 p-4 transition-colors hover:border-primary/40 hover:bg-card">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <Icon className="h-3.5 w-3.5 text-muted-foreground/50 transition-colors group-hover:text-primary" />
      </div>
      <div className="mt-2 font-mono text-xl font-semibold tnum">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SectionTitle({
  children,
  action,
  className,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="h-3.5 w-1 rounded-full bg-primary/70" />
        {children}
      </h2>
      {action}
    </div>
  );
}
