// TS port of crates/shear-math (the on-chain engine). Works in human USDC + plain ratio.
// Mirrors the exact formulas so the UI's predicted PnL/equity/liq match what the chain settles.
import { PARAMS, BPS } from "./constants";

export type Side = "long" | "short";
export const sign = (s: Side) => (s === "long" ? 1 : -1);

export const ratio = (priceBase: number, priceQuote: number) =>
  priceQuote > 0 ? priceBase / priceQuote : 0;

// Volatility-amplified relative-value index (mirror of shear_math::amplify_ratio).
// R_amp = R_0 + (ampBps/1e4) * (R_raw - R_0). ampBps === 1e4 is 1x (identity); ref <= 0 or
// ampBps === 0 pass raw through. Floored just above 0 so a deep drawdown stays positive.
export function amplifyRatio(raw: number, ref: number, ampBps = PARAMS.volAmpBps): number {
  if (ref <= 0 || ampBps === 0 || ampBps === BPS) return raw;
  const amped = ref + (raw - ref) * (ampBps / BPS);
  return amped > 0 ? amped : raw * 1e-9;
}

export const notional = (collateral: number, leverage: number) => collateral * leverage;

// uPnL = side * N * (R_t / R_e - 1)
export function unrealizedPnl(side: Side, n: number, entryRatio: number, curRatio: number): number {
  if (entryRatio <= 0) return 0;
  return sign(side) * n * (curRatio / entryRatio - 1);
}

// funding_owed = side * N * (cum_now - cum_entry). cum is a fractional index.
export function fundingOwed(side: Side, n: number, cumNow: number, cumEntry: number): number {
  return sign(side) * n * (cumNow - cumEntry);
}

// equity = collateral + uPnL - funding_owed - fees
export const equity = (collateral: number, upnl: number, funding: number, fees = 0) =>
  collateral + upnl - funding - fees;

export const maintenanceMargin = (n: number, mmrBps = PARAMS.mmrBps) => (n * mmrBps) / BPS;

export const isLiquidatable = (eq: number, n: number, mmrBps = PARAMS.mmrBps) =>
  eq < maintenanceMargin(n, mmrBps);

// R_liq = R_e * (1e4 + s*(mmr - imr)) / 1e4 ; imr_bps = 1e4 / leverage.
export function liquidationRatio(side: Side, entryRatio: number, leverage: number, mmrBps = PARAMS.mmrBps): number {
  const imrBps = BPS / leverage;
  const factor = (BPS + sign(side) * (mmrBps - imrBps)) / BPS;
  return entryRatio * factor;
}

// Taker fee, rounded up against the user.
export const takerFee = (n: number, feeBps = PARAMS.takerFeeBps) => (n * feeBps) / BPS;

// skew = (long - short) / max(gross, eps), clamped to [-1, 1].
export function skew(longOi: number, shortOi: number): number {
  const gross = longOi + shortOi;
  if (gross === 0) return 0;
  return Math.max(-1, Math.min(1, (longOi - shortOi) / gross));
}

// funding rate per hour (fraction) = clamp(k/1e4 * skew, ±f_max/1e4).
export function fundingRate(sk: number, kBps = PARAMS.kFundingBps, fMaxBps = PARAMS.fMaxBps): number {
  const rate = (kBps / BPS) * sk;
  const fMax = fMaxBps / BPS;
  return Math.max(-fMax, Math.min(fMax, rate));
}

// LP shares minted for a deposit (first deposit locks MIN_LIQUIDITY ~ negligible in USDC units).
export function sharesForDeposit(deposit: number, totalShares: number, aum: number): number {
  if (totalShares === 0) return Math.max(0, deposit - 1e-3);
  if (aum === 0) return 0;
  return (deposit * totalShares) / aum;
}

export function usdcForShares(shares: number, totalShares: number, aum: number): number {
  if (totalShares === 0) return 0;
  return (aum * shares) / totalShares;
}

// |net_oi| <= pool_usdc * max_net_util / 1e4
export function withinNetUtil(longOi: number, shortOi: number, poolUsdc: number, maxNetUtilBps = PARAMS.maxNetUtilBps): boolean {
  const net = Math.abs(longOi - shortOi);
  return net <= (poolUsdc * maxNetUtilBps) / BPS;
}

export const netUtilization = (longOi: number, shortOi: number, poolUsdc: number) =>
  poolUsdc > 0 ? Math.abs(longOi - shortOi) / poolUsdc : 0;

// Pool AUM = pool_usdc - net trader uPnL owed (counterparty mark-to-market).
// Health helpers used by the position card.
export interface PositionMetrics {
  upnl: number;
  funding: number;
  fees: number;
  equity: number;
  maintenance: number;
  marginRatio: number; // equity / notional
  liqRatio: number;
  distanceToLiqPct: number; // how far current ratio is from liq, fraction of entry
  pnlPct: number; // uPnL / collateral
  healthy: boolean;
}

export function positionMetrics(args: {
  side: Side;
  notional: number;
  collateral: number;
  entryRatio: number;
  curRatio: number;
  cumNow: number;
  cumEntry: number;
}): PositionMetrics {
  const { side, notional: n, collateral, entryRatio, curRatio, cumNow, cumEntry } = args;
  const upnl = unrealizedPnl(side, n, entryRatio, curRatio);
  const funding = fundingOwed(side, n, cumNow, cumEntry);
  const fees = takerFee(n); // close fee estimate
  const eq = equity(collateral, upnl, funding, 0);
  const maintenance = maintenanceMargin(n);
  const liqRatio = liquidationRatio(side, entryRatio, n / collateral);
  const distanceToLiqPct = entryRatio > 0 ? (curRatio - liqRatio) / entryRatio : 0;
  return {
    upnl,
    funding,
    fees,
    equity: eq,
    maintenance,
    marginRatio: n > 0 ? eq / n : 0,
    liqRatio,
    distanceToLiqPct: side === "long" ? distanceToLiqPct : -distanceToLiqPct,
    pnlPct: collateral > 0 ? upnl / collateral : 0,
    healthy: eq >= maintenance,
  };
}
