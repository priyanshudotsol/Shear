"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletButton } from "@/components/wallet-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Stat } from "@/components/common";
import { useMarket } from "@/context/market";
import { ONCHAIN_MARKET } from "@/lib/use-chain-data";
import { CIRCLE_FAUCET_URL } from "@/lib/constants";
import { depositLiquidityLive, withdrawLiquidityLive } from "@/lib/chain-trade";
import * as M from "@/lib/shear-math";
import { fmtUsd, fmtPctRaw, fmtNum, fmtCompact, shortKey } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Layers, ShieldCheck, TrendingUp, Info, RefreshCw, AlertTriangle, Database } from "lucide-react";

export default function PoolPage() {
  const { connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { config, market, pool, mockUsdc, lpShares, poolDelegated, loading, error, refresh } = useMarket().chain;

  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const n = parseFloat(amt) || 0;

  const aum = pool?.poolUsdc ?? 0;
  const navPerShare = pool && pool.totalShares > 0 ? aum / pool.totalShares : 1;
  const yourValue = pool ? M.usdcForShares(lpShares, pool.totalShares, aum) : 0;
  const util = pool && market ? M.netUtilization(market.longOi, market.shortOi, pool.poolUsdc) : 0;
  const usdcMint = config?.usdcMint;

  const depositMax = mockUsdc;
  const depositErr =
    !connected
      ? null
      : tab === "deposit" && n > 0 && n > mockUsdc
        ? "Insufficient USDC balance."
        : null;

  async function submit() {
    if (!anchorWallet || !usdcMint) return toast.error("Connect a wallet");
    if (n <= 0) return toast.error("Enter an amount");
    try {
      const mint = new PublicKey(usdcMint);
      const sig =
        tab === "deposit"
          ? await depositLiquidityLive(anchorWallet, mint, ONCHAIN_MARKET, n, setBusy)
          : await withdrawLiquidityLive(anchorWallet, mint, ONCHAIN_MARKET, n, setBusy);
      toast.success(`${tab === "deposit" ? "Deposited" : "Withdrew"} on-chain · ${shortKey(sig, 6)}`);
      setAmt("");
      setTimeout(refresh, 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Transaction failed: ${msg.slice(0, 120)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Liquidity pool</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Real on-chain SOL-ETH pool — the counterparty to every trade. Read live from the deployed program;
            deposits and withdrawals are real transactions.
          </p>
        </div>
        <button
          onClick={refresh}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded bg-secondary px-2 py-1 text-muted-foreground">
          <Database className="h-3 w-3 text-primary" /> {shortKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi", 4)}
        </span>
        <span className="rounded bg-secondary px-2 py-1 text-muted-foreground">devnet</span>
        <span className="rounded bg-primary/10 px-2 py-1 text-primary">{poolDelegated ? "pool on ER" : "pool on base"}</span>
        {config?.paused && <span className="rounded bg-down/15 px-2 py-1 text-down">paused</span>}
      </div>

      {error || (!loading && !pool) ? (
        <div className="mt-6 rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          Couldn&apos;t read the on-chain pool right now (it lives on the MagicBlock ER). Hit refresh shortly.
        </div>
      ) : (
        <>
          {/* real metrics */}
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard icon={Layers} label="Pool AUM" value={fmtUsd(aum, 0)} sub={`${fmtCompact(pool?.totalShares ?? 0)} shares`} />
            <MetricCard icon={TrendingUp} label="NAV / share" value={navPerShare.toFixed(4)} sub="USDC per share" />
            <MetricCard
              icon={Info}
              label="Net-OI utilization"
              value={fmtPctRaw(util, 1)}
              sub={`OI ${fmtUsd((market?.longOi ?? 0) + (market?.shortOi ?? 0), 0)}`}
              warn={util > 0.45}
            />
            <MetricCard icon={ShieldCheck} label="Insurance fund" value={fmtUsd(pool?.insuranceFund ?? 0, 0)} sub="bad-debt backstop" />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_360px]">
            {/* your position */}
            <div className="rounded-xl border border-border bg-card/70 p-5">
              <h2 className="text-sm font-semibold">Your position</h2>
              <div className="mt-4 grid grid-cols-2 gap-5 sm:grid-cols-3">
                <Stat label="Your shares" value={fmtNum(lpShares, 2)} />
                <Stat label="Value" value={fmtUsd(yourValue)} />
                <Stat
                  label="Pool share"
                  value={fmtPctRaw(pool && pool.totalShares > 0 ? lpShares / pool.totalShares : 0, 2)}
                />
              </div>
              <div className="mt-5 space-y-2 rounded-lg border border-border/70 bg-secondary/20 p-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Accrued fees (pool)</span>
                  <span className="font-mono">{fmtUsd(pool?.accruedFees ?? 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Collateral mint</span>
                  <span className="font-mono">{usdcMint ? shortKey(usdcMint, 4) : "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Your collateral balance</span>
                  <span className="font-mono">{fmtUsd(mockUsdc)}</span>
                </div>
              </div>
              <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                The pool settles in <span className="font-medium">Circle devnet USDC</span>
                ({usdcMint ? shortKey(usdcMint, 4) : "—"}). Deposits move real USDC into the vault and are fully
                withdrawable. Need USDC? Get it from Circle&apos;s faucet.
              </p>
              <a
                href={CIRCLE_FAUCET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-border bg-secondary py-2 text-sm font-medium hover:bg-accent"
              >
                Get devnet USDC ↗
              </a>
            </div>

            {/* deposit / withdraw — real tx */}
            <div className="rounded-xl border border-border bg-card/70 p-4 lg:sticky lg:top-20 lg:self-start">
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-secondary/40 p-1">
                {(["deposit", "withdraw"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setTab(t);
                      setAmt("");
                    }}
                    className={cn(
                      "rounded-md py-2 text-sm font-semibold capitalize transition-colors",
                      tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-medium text-muted-foreground">
                    {tab === "deposit" ? "Amount (USDC)" : "Shares"}
                  </span>
                  <button
                    className="font-mono text-muted-foreground hover:text-foreground"
                    onClick={() => setAmt(String(tab === "deposit" ? Math.floor(depositMax) : Math.floor(lpShares)))}
                  >
                    Max: {tab === "deposit" ? fmtUsd(depositMax) : fmtNum(lpShares, 2)}
                  </button>
                </div>
                <Input
                  type="number"
                  value={amt}
                  onChange={(e) => setAmt(e.target.value)}
                  placeholder="0.00"
                  className="h-11 font-mono text-base"
                />
                {depositErr && tab === "deposit" && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-xs text-down">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {depositErr}
                  </p>
                )}
              </div>

              <div className="mt-3 space-y-1.5 rounded-lg border border-border/70 bg-secondary/20 p-3 text-sm">
                {tab === "deposit" ? (
                  <Row
                    label="Shares minted"
                    value={pool ? fmtNum(M.sharesForDeposit(n, pool.totalShares, aum), 2) : "—"}
                  />
                ) : (
                  <Row label="USDC returned" value={pool ? fmtUsd(M.usdcForShares(n, pool.totalShares, aum)) : "—"} />
                )}
                <Row label="NAV / share" value={navPerShare.toFixed(4)} />
              </div>

              <div className="mt-4">
                {!connected ? (
                  <div className="w-full [&>button]:w-full">
                    <WalletButton size="lg" />
                  </div>
                ) : (
                  <Button
                    onClick={submit}
                    size="lg"
                    className="w-full"
                    disabled={!!busy || n <= 0 || (tab === "deposit" && !!depositErr) || (tab === "withdraw" && n > lpShares)}
                  >
                    {busy ?? (tab === "deposit" ? "Deposit liquidity" : "Withdraw liquidity")}
                  </Button>
                )}
              </div>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {poolDelegated
                  ? "A live session is on — this briefly pauses trading to settle the pool to L1, then resumes."
                  : `Signs a real ${tab === "deposit" ? "deposit_liquidity" : "withdraw_liquidity"} transaction on devnet.`}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  warn,
}: {
  icon: typeof Layers;
  label: string;
  value: string;
  sub: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/70 p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className={cn("mt-2 font-mono text-2xl font-semibold tnum", warn && "text-down")}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
