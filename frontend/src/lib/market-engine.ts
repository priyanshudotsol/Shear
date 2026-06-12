// SHEAR live market engine (client simulation faithful to the on-chain shear-math engine).
// Multi-market: each market is a Pyth-priced asset pair (BASE/USD ÷ QUOTE/USD) with its own
// OI, skew funding, ratio chart and (isolated-margin) position. Collateral, the wallet balance
// and the LP pool are shared across markets (v0 single shared pool).
import { PARAMS, SPOT, FAUCET_AMOUNT, MARKETS } from "./constants";
import * as M from "./shear-math";
import type { Side } from "./shear-math";

export interface OpenPosition {
  id: string;
  symbol: string;
  side: Side;
  notional: number;
  collateral: number;
  entryRatio: number;
  entryCumFunding: number;
  openedTs: number;
  leverage: number;
}

export interface ClosedPosition {
  id: string;
  symbol: string;
  side: Side;
  notional: number;
  collateral: number;
  entryRatio: number;
  exitRatio: number;
  realizedPnl: number;
  settlement: number;
  status: "closed" | "liquidated";
  openedTs: number;
  closedTs: number;
}

export type FeedEvent = {
  id: string;
  ts: number;
  kind: "opened" | "closed" | "liquidated" | "funding" | "deposit" | "withdraw" | "crank";
  text: string;
  amount?: number;
};

export interface RatioPoint {
  time: number; // unix seconds
  value: number;
}

// Per-market view exposed to the UI.
export interface MarketSnap {
  symbol: string;
  base: string;
  quote: string;
  basePrice: number;
  quotePrice: number;
  ratio: number;
  ratioOpen: number;
  ratioChange: number;
  longOi: number;
  shortOi: number;
  skew: number;
  fundingRatePerHr: number;
  cumFunding: number;
  position: OpenPosition | null;
  chart: RatioPoint[];
}

export interface Snapshot {
  prices: Record<string, number>;
  markets: MarketSnap[];
  pool: { poolUsdc: number; totalShares: number; accruedFees: number; insuranceFund: number };
  lpShares: number;
  walletBalance: number;
  freeCollateral: number;
  history: ClosedPosition[];
  events: FeedEvent[];
  oracleStale: boolean;
  crankTick: number;
  priceLive: boolean;
}

interface MarketState {
  symbol: string;
  base: string;
  quote: string;
  longOi: number;
  shortOi: number;
  cumFunding: number;
  lastFundingTs: number;
  ratioOpen: number;
  chart: RatioPoint[];
  position: OpenPosition | null;
}

let idc = 0;
const nid = () => `${Date.now()}-${idc++}`;

export class ShearEngine {
  prices: Record<string, number> = { ...SPOT };
  markets: Record<string, MarketState> = {};
  pool = { poolUsdc: 0, totalShares: 0, accruedFees: 0, insuranceFund: 0 };
  lpShares = 0;
  walletBalance = 0; // synthetic test-USDC held in the wallet (devnet faucet)
  freeCollateral = 0;
  history: ClosedPosition[] = [];
  events: FeedEvent[] = [];
  oracleStale = false;
  crankTick = 0;
  lastPriceTs = 0; // unix seconds of the last live (Pyth) price
  priceInitialized = false;
  private seeded = false;

  constructor() {
    for (const m of MARKETS) {
      this.markets[m.symbol] = {
        symbol: m.symbol,
        base: m.base,
        quote: m.quote,
        longOi: m.seedLongOi,
        shortOi: m.seedShortOi,
        cumFunding: 0,
        lastFundingTs: Date.now() / 1000,
        ratioOpen: this.ratioOf(m.base, m.quote),
        chart: [],
        position: null,
      };
    }
  }

  symbols() {
    return MARKETS.map((m) => m.symbol);
  }
  market(symbol: string): MarketState {
    return this.markets[symbol];
  }
  price(asset: string) {
    return this.prices[asset] ?? 0;
  }
  ratioOf(base: string, quote: string) {
    return M.ratio(this.price(base), this.price(quote));
  }
  ratio(symbol: string) {
    const m = this.markets[symbol];
    return m ? this.ratioOf(m.base, m.quote) : 0;
  }
  // The tradeable relative-value index: the raw ratio with its deviation from the session anchor
  // (ratioOpen = R_0) amplified by PARAMS.volAmpBps. Used everywhere a mark/entry/exit ratio is
  // needed (chart, PnL, liquidation) so the whole engine stays in one amplified frame, exactly
  // like the on-chain read_ratio. ratioOf stays raw — it's what anchors R_0.
  marked(m: MarketState) {
    return M.amplifyRatio(this.ratioOf(m.base, m.quote), m.ratioOpen);
  }

  private pushEvent(e: Omit<FeedEvent, "id" | "ts">) {
    this.events.unshift({ id: nid(), ts: Date.now(), ...e });
    if (this.events.length > 40) this.events.length = 40;
  }

  private accrueFees(fee: number) {
    const ins = (fee * PARAMS.insuranceCutBps) / 10_000;
    this.pool.accruedFees += fee;
    this.pool.insuranceFund += ins;
    this.pool.poolUsdc += fee - ins;
  }

  seed() {
    if (this.seeded) return;
    this.seeded = true;
    // chart starts empty and fills from real Pyth ticks (no synthetic backfill)
  }

  private pushChart(m: MarketState) {
    const sec = Math.floor(Date.now() / 1000);
    const v = this.marked(m);
    const last = m.chart[m.chart.length - 1];
    if (last && last.time === sec) last.value = v;
    else {
      m.chart.push({ time: sec, value: v });
      if (m.chart.length > 600) m.chart.shift();
    }
  }

  // Live USD prices from Pyth (asset -> price). On the first real price we anchor each
  // market's session-open ratio and rebuild its chart backfill so there's no jump.
  setPrices(p: Record<string, number>) {
    for (const [asset, v] of Object.entries(p)) {
      if (v && v > 0) this.prices[asset] = v;
    }
    this.lastPriceTs = Date.now() / 1000;
    this.oracleStale = false;
    if (!this.priceInitialized) {
      this.priceInitialized = true;
      for (const sym of this.symbols()) {
        const m = this.markets[sym];
        m.ratioOpen = this.ratioOf(m.base, m.quote);
        m.chart = [{ time: Math.floor(Date.now() / 1000), value: this.ratioOf(m.base, m.quote) }];
      }
    }
  }

  // Accrue funding per market + run the crank + sample charts. Prices come from Pyth;
  // if the live feed stalls we fall back to a gentle random walk so the demo stays alive.
  step(dtMs: number) {
    const dt = dtMs / 1000;
    const now = Date.now() / 1000;
    const fresh = this.lastPriceTs > 0 && now - this.lastPriceTs < 5;
    if (this.priceInitialized && !fresh) {
      const mkt = (Math.random() - 0.5) * 0.0016;
      for (const asset of Object.keys(this.prices)) {
        const idio = (Math.random() - 0.5) * 0.0018;
        this.prices[asset] = Math.max(1, this.prices[asset] * (1 + mkt + idio));
      }
      this.oracleStale = true;
    }

    this.crankTick++;
    for (const sym of this.symbols()) {
      const m = this.markets[sym];
      const rate = M.fundingRate(M.skew(m.longOi, m.shortOi));
      m.cumFunding += (rate * dt) / PARAMS.fundingIntervalSecs;
      m.lastFundingTs = now;
      if (m.position && !M.positionMetrics(this.posArgs(m)).healthy) {
        this.liquidatePosition(m);
      }
      this.pushChart(m);
    }
  }

  private posArgs(m: MarketState) {
    const p = m.position!;
    return {
      side: p.side,
      notional: p.notional,
      collateral: p.collateral,
      entryRatio: p.entryRatio,
      curRatio: this.marked(m),
      cumNow: m.cumFunding,
      cumEntry: p.entryCumFunding,
    };
  }

  // ---- devnet faucet ----
  faucet(amount = FAUCET_AMOUNT) {
    this.walletBalance += amount;
    this.pushEvent({ kind: "deposit", text: `Claimed test USDC from devnet faucet`, amount });
  }

  // ---- trader collateral (shared, L1) ----
  canDeposit(amount: number): string | null {
    if (amount <= 0) return "Enter an amount.";
    if (amount > this.walletBalance) return "Insufficient wallet balance.";
    return null;
  }
  deposit(amount: number) {
    if (this.canDeposit(amount)) return;
    this.walletBalance -= amount;
    this.freeCollateral += amount;
    this.pushEvent({ kind: "deposit", text: `Deposited collateral`, amount });
  }
  withdraw(amount: number) {
    const a = Math.min(amount, this.freeCollateral);
    this.freeCollateral -= a;
    this.walletBalance += a;
    this.pushEvent({ kind: "withdraw", text: `Withdrew collateral`, amount: a });
  }

  // ---- LP (shared pool) ----
  aum() {
    let owed = 0;
    for (const sym of this.symbols()) {
      const m = this.markets[sym];
      if (m.position) owed += M.positionMetrics(this.posArgs(m)).upnl;
    }
    return this.pool.poolUsdc - owed;
  }
  private netOiOk(poolUsdc: number) {
    // every market must remain within the net-utilisation gate
    return this.symbols().every((sym) => {
      const m = this.markets[sym];
      return M.withinNetUtil(m.longOi, m.shortOi, poolUsdc);
    });
  }
  canDepositLiquidity(amount: number): string | null {
    if (amount <= 0) return "Enter an amount.";
    if (amount > this.walletBalance) return "Insufficient wallet balance.";
    return null;
  }
  depositLiquidity(amount: number) {
    if (this.canDepositLiquidity(amount)) return 0;
    const shares = M.sharesForDeposit(amount, this.pool.totalShares, this.aum());
    this.walletBalance -= amount;
    this.pool.totalShares += shares;
    this.pool.poolUsdc += amount;
    this.lpShares += shares;
    this.pushEvent({ kind: "deposit", text: `LP deposited → pool`, amount });
    return shares;
  }
  withdrawLiquidity(shares: number) {
    const s = Math.min(shares, this.lpShares);
    const usdc = M.usdcForShares(s, this.pool.totalShares, this.aum());
    if (!this.netOiOk(this.pool.poolUsdc - usdc)) return 0;
    this.pool.totalShares -= s;
    this.pool.poolUsdc -= usdc;
    this.lpShares -= s;
    this.walletBalance += usdc;
    this.pushEvent({ kind: "withdraw", text: `LP withdrew from pool`, amount: usdc });
    return usdc;
  }

  // ---- trading (ER), per market ----
  canOpen(symbol: string, side: Side, collateral: number, leverage: number): string | null {
    const m = this.markets[symbol];
    if (!m) return "Unknown market.";
    if (m.position) return "A position is already open in this market (isolated margin).";
    if (collateral < PARAMS.minCollateral) return `Minimum collateral is ${PARAMS.minCollateral} USDC.`;
    if (collateral > this.freeCollateral) return "Insufficient free collateral — deposit first.";
    if (leverage < 1 || leverage > PARAMS.maxLeverage) return `Leverage must be 1–${PARAMS.maxLeverage}x.`;
    const n = M.notional(collateral, leverage);
    if (n < PARAMS.minPositionNotional) return `Minimum notional is ${PARAMS.minPositionNotional} USDC.`;
    const newLong = m.longOi + (side === "long" ? n : 0);
    const newShort = m.shortOi + (side === "short" ? n : 0);
    if (newLong + newShort > PARAMS.oiCapAbs) return "OI cap exceeded.";
    if (!M.withinNetUtil(newLong, newShort, this.pool.poolUsdc)) return "Pool net-utilization cap exceeded.";
    if (this.oracleStale) return "Oracle stale — trade rejected. Retry next tick.";
    return null;
  }

  openPosition(symbol: string, side: Side, collateral: number, leverage: number): OpenPosition | null {
    const m = this.markets[symbol];
    if (!m || this.canOpen(symbol, side, collateral, leverage)) return null;
    const n = M.notional(collateral, leverage);
    const fee = M.takerFee(n);
    const c = collateral - fee;
    this.freeCollateral -= collateral;
    this.accrueFees(fee);
    if (side === "long") m.longOi += n;
    else m.shortOi += n;
    const pos: OpenPosition = {
      id: nid(),
      symbol,
      side,
      notional: n,
      collateral: c,
      entryRatio: this.marked(m),
      entryCumFunding: m.cumFunding,
      openedTs: Date.now() / 1000,
      leverage,
    };
    m.position = pos;
    this.pushEvent({
      kind: "opened",
      text: `You opened ${side.toUpperCase()} ${symbol} ${leverage}x · notional ${n.toFixed(0)}`,
      amount: n,
    });
    return pos;
  }

  closePosition(symbol: string): ClosedPosition | null {
    const m = this.markets[symbol];
    if (!m || !m.position) return null;
    const p = m.position;
    const mt = M.positionMetrics(this.posArgs(m));
    const fee = M.takerFee(p.notional);
    const settlement = Math.max(0, mt.equity - fee);
    const realized = settlement - p.collateral;
    this.freeCollateral += settlement;
    this.pool.poolUsdc -= mt.upnl;
    this.pool.poolUsdc += mt.funding;
    this.accrueFees(fee);
    if (p.side === "long") m.longOi -= p.notional;
    else m.shortOi -= p.notional;
    const closed: ClosedPosition = {
      id: p.id,
      symbol,
      side: p.side,
      notional: p.notional,
      collateral: p.collateral,
      entryRatio: p.entryRatio,
      exitRatio: this.marked(m),
      realizedPnl: realized,
      settlement,
      status: "closed",
      openedTs: p.openedTs,
      closedTs: Date.now() / 1000,
    };
    this.history.unshift(closed);
    m.position = null;
    this.pushEvent({ kind: "closed", text: `You closed ${symbol} · settle ${settlement.toFixed(2)}`, amount: settlement });
    return closed;
  }

  private liquidatePosition(m: MarketState) {
    if (!m.position) return;
    const p = m.position;
    const mt = M.positionMetrics(this.posArgs(m));
    const penalty = (p.notional * PARAMS.liqPenaltyBps) / 10_000;
    const traderGets = Math.max(0, mt.equity - penalty);
    this.freeCollateral += traderGets;
    this.pool.poolUsdc -= mt.upnl;
    this.pool.insuranceFund += (penalty * PARAMS.insuranceCutBps) / 10_000;
    if (p.side === "long") m.longOi -= p.notional;
    else m.shortOi -= p.notional;
    this.history.unshift({
      id: p.id,
      symbol: m.symbol,
      side: p.side,
      notional: p.notional,
      collateral: p.collateral,
      entryRatio: p.entryRatio,
      exitRatio: this.marked(m),
      realizedPnl: traderGets - p.collateral,
      settlement: traderGets,
      status: "liquidated",
      openedTs: p.openedTs,
      closedTs: Date.now() / 1000,
    });
    m.position = null;
    this.pushEvent({ kind: "liquidated", text: `${m.symbol} liquidated by crank · penalty ${penalty.toFixed(2)}`, amount: penalty });
  }

  addCollateral(symbol: string, amount: number) {
    const m = this.markets[symbol];
    if (!m?.position) return;
    const a = Math.min(amount, this.freeCollateral);
    this.freeCollateral -= a;
    m.position.collateral += a;
  }
  removeCollateral(symbol: string, amount: number) {
    const m = this.markets[symbol];
    if (!m?.position) return;
    if (amount >= m.position.collateral) return;
    m.position.collateral -= amount;
    this.freeCollateral += amount;
  }

  // ---- per-wallet persistence (localStorage) ----
  serialize(): string {
    const positions: Record<string, OpenPosition | null> = {};
    for (const sym of this.symbols()) positions[sym] = this.markets[sym].position;
    return JSON.stringify({
      v: 2,
      history: this.history,
      freeCollateral: this.freeCollateral,
      lpShares: this.lpShares,
      walletBalance: this.walletBalance,
      positions,
    });
  }

  hydrate(raw: string | null) {
    if (!raw) return;
    try {
      const d = JSON.parse(raw);
      if (d?.v !== 2) return; // v1 was single-market; ignore
      this.history = Array.isArray(d.history) ? d.history : [];
      this.freeCollateral = typeof d.freeCollateral === "number" ? d.freeCollateral : 0;
      this.lpShares = typeof d.lpShares === "number" ? d.lpShares : 0;
      this.walletBalance = typeof d.walletBalance === "number" ? d.walletBalance : 0;
      const positions = d.positions ?? {};
      for (const sym of this.symbols()) {
        this.markets[sym].position = positions[sym] ?? null;
      }
    } catch {
      /* ignore corrupt state */
    }
  }

  resetUser() {
    this.history = [];
    this.freeCollateral = 0;
    this.lpShares = 0;
    this.walletBalance = 0;
    for (const sym of this.symbols()) this.markets[sym].position = null;
  }

  private marketSnap(m: MarketState): MarketSnap {
    const ratio = this.marked(m);
    return {
      symbol: m.symbol,
      base: m.base,
      quote: m.quote,
      basePrice: this.price(m.base),
      quotePrice: this.price(m.quote),
      ratio,
      ratioOpen: m.ratioOpen,
      ratioChange: m.ratioOpen > 0 ? (ratio - m.ratioOpen) / m.ratioOpen : 0,
      longOi: m.longOi,
      shortOi: m.shortOi,
      skew: M.skew(m.longOi, m.shortOi),
      fundingRatePerHr: M.fundingRate(M.skew(m.longOi, m.shortOi)),
      cumFunding: m.cumFunding,
      position: m.position ? { ...m.position } : null,
      chart: [...m.chart],
    };
  }

  snapshot(): Snapshot {
    return {
      prices: { ...this.prices },
      markets: this.symbols().map((sym) => this.marketSnap(this.markets[sym])),
      pool: { ...this.pool },
      lpShares: this.lpShares,
      walletBalance: this.walletBalance,
      freeCollateral: this.freeCollateral,
      history: this.history,
      events: this.events,
      oracleStale: this.oracleStale,
      crankTick: this.crankTick,
      priceLive: this.priceInitialized,
    };
  }
}
