"use client";

// Client-side liquidation keeper. The on-chain program exposes a permissionless `crank_liquidate_one`
// instruction but nothing was ever calling it, so positions that crossed their liq ratio just sat
// there underwater. This hook watches every open chain position against the live (250ms) oracle
// ratio and, the moment one goes unhealthy, fires the crank on the ER to force-close it. The program
// re-checks health and no-ops if the slot is actually still healthy, so firing early is harmless.
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { MarketSnap } from "./market-engine";
import type { ChainPosition } from "./chain";
import { fetchPositions } from "./chain";
import * as M from "./shear-math";
import { crankLiquidateER } from "./chain-trade";
import type { SignerWallet } from "./chain-write";
import { recordTrade } from "./trade-log";

interface CrankInputs {
  enabled: boolean;
  symbol: string;
  snap: MarketSnap | undefined;
  cumFunding: number;
  positions: ChainPosition[];
  wallet: SignerWallet | null;
  owner: string | null;
  refresh: () => void;
}

const CHECK_MS = 2000;
// After an attempt on a slot, wait this long before trying again - covers the case where we fired a
// touch early (program no-op) without spamming the ER, and gives a real liquidation time to settle.
const RETRY_COOLDOWN_MS = 5000;

export function useLiquidationCrank(inputs: CrankInputs) {
  const ref = useRef(inputs);
  useEffect(() => {
    ref.current = inputs;
  });
  // slot -> timestamp it may next be attempted (acts as both in-flight guard and cooldown)
  const cooldownUntil = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    let stopped = false;

    const attempt = async (p: ChainPosition, snap: MarketSnap, wallet: SignerWallet, symbol: string, owner: string | null, refresh: () => void) => {
      cooldownUntil.current.set(p.slot, Number.MAX_SAFE_INTEGER); // in-flight: block re-entry
      try {
        await crankLiquidateER(wallet, symbol, p.slot);
        // The crank may have no-op'd (still healthy on-chain). Only treat it as a real liquidation if
        // the slot is actually gone from the book now.
        const still = await fetchPositions(wallet.publicKey, symbol);
        const liquidated = !still.some((q) => q.slot === p.slot);
        if (liquidated) {
          if (owner) {
            recordTrade(owner, {
              symbol,
              side: p.side,
              notional: p.notional,
              collateral: p.collateral,
              leverage: p.collateral > 0 ? p.notional / p.collateral : 0,
              entryRatio: p.entryRatio,
              exitRatio: snap.ratio,
              realizedPnl: M.unrealizedPnl(p.side, p.notional, p.entryRatio, snap.ratio),
              status: "liquidated",
            });
          }
          toast.error(`${symbol} ${p.side.toUpperCase()} liquidated · position force-closed`);
          refresh();
        }
      } catch {
        /* transient ER/RPC error - retry after the cooldown */
      } finally {
        if (!stopped) cooldownUntil.current.set(p.slot, Date.now() + RETRY_COOLDOWN_MS);
      }
    };

    const tick = () => {
      const { enabled, symbol, snap, cumFunding, positions, wallet, owner, refresh } = ref.current;
      if (!enabled || !wallet || !snap || positions.length === 0) return;
      const now = Date.now();
      for (const p of positions) {
        if ((cooldownUntil.current.get(p.slot) ?? 0) > now) continue;
        const m = M.positionMetrics({
          side: p.side,
          notional: p.notional,
          collateral: p.collateral,
          entryRatio: p.entryRatio,
          curRatio: snap.ratio,
          cumNow: cumFunding,
          cumEntry: p.entryCumFunding,
        });
        if (m.healthy) continue;
        void attempt(p, snap, wallet, symbol, owner, refresh);
      }
    };

    const id = setInterval(tick, CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);
}
