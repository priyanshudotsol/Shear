// Aggregate trading stats derived from the engine's closed-trade history.
import type { ClosedPosition, OpenPosition } from "./market-engine";
import * as M from "./shear-math";

export interface ProfileStats {
  trades: number;
  wins: number;
  losses: number;
  liquidations: number;
  winRate: number; // 0..1
  realizedPnl: number;
  volume: number; // sum of notional traded
  estFees: number; // round-trip taker fees
  avgPnl: number;
  bestTrade: ClosedPosition | null;
  worstTrade: ClosedPosition | null;
  longCount: number;
  shortCount: number;
  totalProfit: number; // sum of positive realized PnL
  totalLoss: number; // sum of negative realized PnL (negative number)
  firstTradeTs: number | null;
}

export function profileStats(history: ClosedPosition[]): ProfileStats {
  let wins = 0,
    losses = 0,
    liquidations = 0,
    realizedPnl = 0,
    volume = 0,
    estFees = 0,
    longCount = 0,
    shortCount = 0,
    totalProfit = 0,
    totalLoss = 0;
  let best: ClosedPosition | null = null;
  let worst: ClosedPosition | null = null;
  let firstTradeTs: number | null = null;

  for (const h of history) {
    realizedPnl += h.realizedPnl;
    volume += h.notional;
    estFees += M.takerFee(h.notional) * 2; // open + close
    if (h.realizedPnl > 0) {
      wins++;
      totalProfit += h.realizedPnl;
    } else if (h.realizedPnl < 0) {
      losses++;
      totalLoss += h.realizedPnl;
    }
    if (h.status === "liquidated") liquidations++;
    if (h.side === "long") longCount++;
    else shortCount++;
    if (!best || h.realizedPnl > best.realizedPnl) best = h;
    if (!worst || h.realizedPnl < worst.realizedPnl) worst = h;
    if (firstTradeTs === null || h.openedTs < firstTradeTs) firstTradeTs = h.openedTs;
  }

  const trades = history.length;
  return {
    trades,
    wins,
    losses,
    liquidations,
    winRate: trades > 0 ? wins / trades : 0,
    realizedPnl,
    volume,
    estFees,
    avgPnl: trades > 0 ? realizedPnl / trades : 0,
    bestTrade: best,
    worstTrade: worst,
    longCount,
    shortCount,
    totalProfit,
    totalLoss,
    firstTradeTs,
  };
}

// Live account value: free collateral + open-position equity + LP value.
export function accountValue(args: {
  freeCollateral: number;
  position: OpenPosition | null;
  ratio: number;
  cumFunding: number;
  lpValue: number;
}): { openEquity: number; total: number } {
  const { freeCollateral, position, ratio, cumFunding, lpValue } = args;
  let openEquity = 0;
  if (position) {
    openEquity = M.positionMetrics({
      side: position.side,
      notional: position.notional,
      collateral: position.collateral,
      entryRatio: position.entryRatio,
      curRatio: ratio,
      cumNow: cumFunding,
      cumEntry: position.entryCumFunding,
    }).equity;
  }
  return { openEquity, total: freeCollateral + openEquity + lpValue };
}
