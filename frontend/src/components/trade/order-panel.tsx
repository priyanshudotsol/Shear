"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { useMarket } from "@/context/market";
import { WalletButton } from "@/components/wallet-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { fmtUsd, fmtRatio } from "@/lib/format";
import { TxToast } from "@/components/tx-link";
import { PARAMS } from "@/lib/constants";
import * as M from "@/lib/shear-math";
import type { Side } from "@/lib/shear-math";
import { provisionTrader, openPositionER } from "@/lib/chain-trade";
import { recordOpen } from "@/lib/trade-log";
import { fetchFreeSlot, MAX_POSITIONS } from "@/lib/chain";
import { toast } from "sonner";
import { Zap, Info, Minus, Plus } from "lucide-react";

// Preset leverage ticks shown under the slider (clamped to the on-chain max), deduped + sorted.
const LEV_PRESETS = [...new Set([1, 5, 10, 25, PARAMS.maxLeverage])].filter((l) => l <= PARAMS.maxLeverage).sort((a, b) => a - b);
const clampLev = (l: number) => Math.max(1, Math.min(PARAMS.maxLeverage, l));

export function OrderPanel() {
  const { connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { active, chain } = useMarket();
  const ratio = active.ratio;
  const positions = chain.positions; // all open positions for the connected wallet
  const freeCollateral = chain.userFree ?? 0; // real on-chain free collateral
  const usdcMint = chain.config?.usdcMint;
  const sessionLive = chain.market?.delegated ?? false; // market+pool delegated to the ER
  const bookFull = positions.length >= MAX_POSITIONS;
  const [side, setSide] = useState<Side>("long");
  const [collateral, setCollateral] = useState("10");
  const [leverage, setLeverage] = useState(2);
  const [busy, setBusy] = useState<string | null>(null);

  const c = parseFloat(collateral) || 0;
  const n = M.notional(c, leverage);
  const fee = M.takerFee(n);
  const liqRatio = c > 0 ? M.liquidationRatio(side, ratio, leverage) : 0;

  // Pool capacity: a position's notional can't push net OI past maxNetUtil% of pool liquidity.
  const poolUsdc = chain.pool?.poolUsdc ?? 0;
  const netOi = Math.abs((chain.market?.longOi ?? 0) - (chain.market?.shortOi ?? 0));
  const availNotional = Math.max(0, poolUsdc * (PARAMS.maxNetUtilBps / 1e4) - netOi);
  const exceedsPool = n > availNotional;

  function errMsg(e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  async function handleOpen() {
    if (!anchorWallet || !usdcMint) return toast.error("Connect a wallet");
    if (!sessionLive) return toast.error("Trading session isn't live (run scripts/session-start.cjs)");
    if (c < PARAMS.minCollateral) return toast.error(`Minimum collateral is ${PARAMS.minCollateral} USDC`);
    if (exceedsPool) return toast.error(`Position too large for the pool - max ~${availNotional.toFixed(0)} USDC notional. Add liquidity or size down.`);
    try {
      const slot = await fetchFreeSlot(anchorWallet.publicKey, active.symbol);
      if (slot < 0) return toast.error(`Max ${MAX_POSITIONS} positions open - close one first.`);
      setBusy("Provisioning collateral…");
      await provisionTrader(anchorWallet, new PublicKey(usdcMint), active.symbol, c, leverage);
      setBusy("Opening on the ER…");
      const sig = await openPositionER(anchorWallet, active.symbol, slot, side, c, leverage);
      recordOpen(anchorWallet.publicKey.toBase58(), { symbol: active.symbol, side, notional: n, collateral: c, leverage, entryRatio: ratio, signature: sig });
      toast.success(<TxToast label={`Opened ${side} ${leverage}×`} sig={sig} />);
      setTimeout(chain.refresh, 1500);
    } catch (e) {
      toast.error(`Open failed: ${errMsg(e).slice(0, 140)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col border border-border bg-card/60">
      {/* header bar */}
      <div className="flex h-10 items-center justify-between border-b border-border px-4">
        <span className="text-xs font-medium text-foreground">
          Market · {active.base}/{active.quote}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{fmtRatio(ratio)}</span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        {/* side toggle - flat, full-width */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setSide("long")}
            className={cn(
              "border py-2.5 text-sm font-semibold transition-colors",
              side === "long"
                ? "border-up bg-up/15 text-up"
                : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
            )}
          >
            Long
          </button>
          <button
            onClick={() => setSide("short")}
            className={cn(
              "border py-2.5 text-sm font-semibold transition-colors",
              side === "short"
                ? "border-down bg-down/15 text-down"
                : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
            )}
          >
            Short
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {side === "long"
            ? `Profit if ${active.base} outperforms ${active.quote} - regardless of market direction.`
            : `Profit if ${active.quote} outperforms ${active.base} - regardless of market direction.`}
        </p>

        {/* collateral */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Collateral</span>
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setCollateral(String(Math.floor(freeCollateral)))}
            >
              Free <span className="font-mono text-foreground">{fmtUsd(freeCollateral)}</span>
            </button>
          </div>
          <div className="relative">
            <Input
              type="number"
              inputMode="decimal"
              value={collateral}
              onChange={(e) => setCollateral(e.target.value)}
              className="h-11 rounded-none pr-20 font-mono text-base"
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-2">
              <button
                onClick={() => setCollateral(String(Math.floor(freeCollateral)))}
                className="rounded-none bg-secondary px-2 py-1 text-[10px] font-medium hover:bg-accent"
              >
                MAX
              </button>
              <span className="border-l border-border pl-2 text-xs text-muted-foreground">USDC</span>
            </div>
          </div>
        </div>

        {/* leverage */}
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Leverage</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setLeverage((l) => clampLev(l - 1))}
                disabled={leverage <= 1}
                className="grid h-6 w-6 place-items-center rounded-none border border-border bg-secondary/40 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                aria-label="Decrease leverage"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-12 text-center font-mono text-sm font-semibold text-primary">{leverage}×</span>
              <button
                onClick={() => setLeverage((l) => clampLev(l + 1))}
                disabled={leverage >= PARAMS.maxLeverage}
                className="grid h-6 w-6 place-items-center rounded-none border border-border bg-secondary/40 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                aria-label="Increase leverage"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <Slider
            value={[leverage]}
            min={1}
            max={PARAMS.maxLeverage}
            step={1}
            onValueChange={(v) => setLeverage(Array.isArray(v) ? v[0] : v)}
          />
          <div className="relative mt-2 h-4">
            {LEV_PRESETS.map((l) => (
              <button
                key={l}
                onClick={() => setLeverage(l)}
                style={{ left: `${((l - 1) / (PARAMS.maxLeverage - 1)) * 100}%` }}
                className={cn(
                  "absolute -translate-x-1/2 font-mono text-[10px] transition-colors",
                  leverage === l ? "font-semibold text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {l}×
              </button>
            ))}
          </div>
        </div>

        {/* summary */}
        <div className="mt-5 space-y-2.5 border-t border-border pt-4 text-xs font-mono">
          <Row label="Notional" value={fmtUsd(n)} />
          <Row label="Entry ratio" value={fmtRatio(ratio)} />
          <Row label="Liquidation ratio" value={fmtRatio(liqRatio)} valueClass="text-down" />
          <Row label="Est. open fee" value={fmtUsd(fee)} sub={`${PARAMS.takerFeeBps} bps`} />
          <Row label="Maintenance margin" value={`${(PARAMS.mmrBps / 100).toFixed(0)}%`} />
          <Row
            label="Pool capacity"
            value={fmtUsd(availNotional, 0)}
            valueClass={exceedsPool ? "text-down" : undefined}
            sub="max notional"
          />
        </div>

        {/* action */}
        <div className="mt-4">
          {!connected ? (
            <div className="space-y-2">
              <div className="w-full [&>button]:w-full">
                <WalletButton size="lg" />
              </div>
              <p className="text-center text-xs text-muted-foreground">Connect a wallet to trade.</p>
            </div>
          ) : (
            <>
              <Button
                onClick={handleOpen}
                size="lg"
                disabled={!!busy || !sessionLive || c < PARAMS.minCollateral || bookFull || exceedsPool}
                className={cn(
                  "w-full gap-2 rounded-none text-base font-semibold text-white",
                  side === "long" ? "bg-up hover:bg-up/90" : "bg-down hover:bg-down/90"
                )}
              >
                <Zap className="h-4 w-4" />
                {busy ?? (bookFull ? `Max ${MAX_POSITIONS} positions open` : `Open ${side === "long" ? "Long" : "Short"} ${leverage}×`)}
              </Button>
              <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                {!sessionLive
                  ? "Trading session isn't live yet - an admin must delegate the market to the ER (scripts/session-start.cjs)."
                  : positions.length > 0
                    ? `${positions.length} open position${positions.length > 1 ? "s" : ""} - open another, or manage them on the Positions page. Free collateral: ${fmtUsd(freeCollateral)}.`
                    : `Opens a new position on the ER. You can hold up to ${MAX_POSITIONS} at once. Free collateral: ${fmtUsd(freeCollateral)}.`}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-sans text-muted-foreground">{label}</span>
      <span className={cn("text-foreground", valueClass)}>
        {value}
        {sub && <span className="ml-1 text-muted-foreground">{sub}</span>}
      </span>
    </div>
  );
}
