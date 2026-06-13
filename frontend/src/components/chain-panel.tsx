"use client";

import { useChainData, ONCHAIN_MARKET } from "@/lib/use-chain-data";
import { fmtUsd, fmtRatio, fmtCompact, shortKey } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RefreshCw, Database } from "lucide-react";

function Cell({ label, value, accent }: { label: string; value: React.ReactNode; accent?: "up" | "down" }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 font-mono text-sm tnum",
          accent === "up" && "text-up",
          accent === "down" && "text-down"
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function ChainPanel() {
  const { config, market, pool, userFree, positions, loading, error, refresh } = useChainData();
  const p0 = positions[0];

  return (
    <div className="rounded-2xl border border-border bg-card/60 p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Database className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Live on-chain · {ONCHAIN_MARKET}</h2>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          devnet
        </span>
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
          ER
        </span>
        {config?.paused && (
          <span className="rounded bg-down/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-down">
            paused
          </span>
        )}
        <button
          onClick={refresh}
          className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          refresh
        </button>
      </div>

      {error || (!loading && !market) ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Couldn&apos;t read on-chain state right now. The market/pool live on the MagicBlock ER - retry shortly.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <Cell label="Long OI" value={market ? fmtUsd(market.longOi, 0) : "…"} />
            <Cell label="Short OI" value={market ? fmtUsd(market.shortOi, 0) : "…"} />
            <Cell label="Max leverage" value={market ? `${market.maxLeverage}×` : "…"} />
            <Cell label="Maint. margin" value={market ? `${(market.mmrBps / 100).toFixed(0)}%` : "…"} />
            <Cell label="Pool AUM" value={pool ? fmtUsd(pool.poolUsdc, 0) : "…"} />
            <Cell label="LP shares" value={pool ? fmtCompact(pool.totalShares) : "…"} />
            <Cell label="Accrued fees" value={pool ? fmtUsd(pool.accruedFees) : "…"} />
            <Cell label="Insurance fund" value={pool ? fmtUsd(pool.insuranceFund) : "…"} />
          </div>

          <div className="mt-4 border-t border-border/60 pt-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <Cell
                label="Your free collateral"
                value={userFree == null ? "no account" : fmtUsd(userFree)}
              />
              <Cell
                label="Your positions"
                value={
                  positions.length === 0
                    ? "none"
                    : positions.length === 1
                      ? `${p0.side.toUpperCase()} · ${fmtUsd(p0.notional, 0)} @ ${fmtRatio(p0.entryRatio)}`
                      : `${positions.length} open`
                }
                accent={p0 ? (p0.side === "long" ? "up" : "down") : undefined}
              />
              <Cell
                label="Collateral mint"
                value={config ? shortKey(config.usdcMint, 4) : "…"}
              />
            </div>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Read directly from the deployed program (
            <span className="font-mono">{shortKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi", 4)}</span>). Market
            and pool are delegated to the ER; config, balances and positions are on the base layer.
          </p>
        </>
      )}
    </div>
  );
}
