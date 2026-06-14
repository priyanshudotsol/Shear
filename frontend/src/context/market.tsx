"use client";

import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { ShearEngine, type Snapshot, type ClosedPosition, type RatioPoint, type MarketSnap } from "@/lib/market-engine";
import type { Side } from "@/lib/shear-math";
import { subscribePyth, fetchLatestPyth } from "@/lib/pyth";
import { useChainData, type ChainData, ONCHAIN_MARKET } from "@/lib/use-chain-data";
import { useLiquidationCrank } from "@/lib/use-liquidation-crank";
import { scheduleLiquidationCrankER } from "@/lib/chain-trade";
import { DEFAULT_MARKET } from "@/lib/constants";

export type { RatioPoint, MarketSnap };

const storeKey = (addr: string) => `shear:v2:${addr}`;
const ACTIVE_KEY = "shear:v2:active";

interface MarketCtx extends Snapshot {
  activeMarket: string;
  setActiveMarket: (symbol: string) => void;
  active: MarketSnap;
  chain: ChainData;
  sessionActive: boolean;
  startSession: () => void;
  faucet: (amount?: number) => void;
  canDeposit: (amount: number) => string | null;
  canDepositLiquidity: (amount: number) => string | null;
  deposit: (amount: number) => void;
  withdraw: (amount: number) => void;
  depositLiquidity: (amount: number) => number;
  withdrawLiquidity: (shares: number) => number;
  canOpen: (symbol: string, side: Side, collateral: number, leverage: number) => string | null;
  open: (symbol: string, side: Side, collateral: number, leverage: number) => void;
  close: (symbol: string) => ClosedPosition | null;
  addCollateral: (symbol: string, amount: number) => void;
  removeCollateral: (symbol: string, amount: number) => void;
}

const Ctx = createContext<MarketCtx | null>(null);
const TICK_MS = 250;

export function MarketProvider({ children }: { children: React.ReactNode }) {
  const [engine] = useState(() => {
    const e = new ShearEngine();
    e.seed();
    return e;
  });
  const [snap, setSnap] = useState<Snapshot>(() => engine.snapshot());
  const [sessionActive, setSessionActive] = useState(false);
  const [activeMarket, setActiveMarketState] = useState(DEFAULT_MARKET);
  const { publicKey } = useWallet();
  const addrRef = useRef<string | null>(null);
  const histLenRef = useRef(0);

  const persist = useCallback(() => {
    if (typeof window === "undefined" || !addrRef.current) return;
    try {
      window.localStorage.setItem(storeKey(addrRef.current), engine.serialize());
    } catch {
      /* storage unavailable */
    }
  }, [engine]);

  const refresh = useCallback(() => {
    setSnap(engine.snapshot());
    persist();
  }, [engine, persist]);

  // restore the last-selected market (after hydration to avoid an SSR mismatch)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(ACTIVE_KEY);
    if (saved && saved !== activeMarket && engine.markets[saved]) {
      queueMicrotask(() => setActiveMarketState(saved));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const setActiveMarket = useCallback((symbol: string) => {
    setActiveMarketState(symbol);
    if (typeof window !== "undefined") window.localStorage.setItem(ACTIVE_KEY, symbol);
  }, []);

  // load (or initialise) this wallet's trading record on connect / switch
  useEffect(() => {
    const addr = publicKey?.toBase58() ?? null;
    addrRef.current = addr;
    if (addr && typeof window !== "undefined") {
      const saved = window.localStorage.getItem(storeKey(addr));
      if (saved) {
        engine.hydrate(saved);
      } else {
        engine.resetUser();
        engine.faucet();
        persist();
      }
      histLenRef.current = engine.history.length;
    }
  }, [publicKey, engine, persist]);

  useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const t = performance.now();
      engine.step(t - last);
      last = t;
      setSnap(engine.snapshot());
      if (engine.history.length !== histLenRef.current) {
        histLenRef.current = engine.history.length;
        persist();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [engine, persist]);

  // live SOL/ETH/BTC from Pyth (1s poll + SSE stream)
  useEffect(() => {
    let cancelled = false;
    const pull = () =>
      fetchLatestPyth().then((p) => {
        if (!cancelled && Object.keys(p).length) engine.setPrices(p);
      });
    pull();
    // SSE stream below pushes live updates; this poll is just a slow fallback (avoid Hermes 429s).
    const poll = setInterval(pull, 5000);
    const unsub = subscribePyth((p) => engine.setPrices(p));
    return () => {
      cancelled = true;
      clearInterval(poll);
      unsub();
    };
  }, [engine]);

  const chain = useChainData();
  const anchorWallet = useAnchorWallet();
  const active = snap.markets.find((m) => m.symbol === activeMarket) ?? snap.markets[0];

  // Liquidation keeper: force-close any on-chain position that crosses its liq ratio. Runs against
  // the SOL-ETH market (the only one deployed on-chain), checked against the live oracle ratio.
  // This is the visible browser-side fallback; the authoritative path is the native on-chain crank.
  useLiquidationCrank({
    enabled: !!chain.market?.delegated && chain.positions.length > 0,
    symbol: ONCHAIN_MARKET,
    snap: snap.markets.find((m) => m.symbol === ONCHAIN_MARKET),
    cumFunding: chain.market?.cumFunding ?? 0,
    positions: chain.positions,
    wallet: anchorWallet ?? null,
    owner: publicKey?.toBase58() ?? null,
    refresh: chain.refresh,
  });

  // Tier 2: ensure this trader's native on-chain liquidation crank is scheduled on the ER once a
  // session is live and they hold positions — covers books opened before this build (the open path
  // also schedules it). Fires once per wallet; best-effort (duplicate/old-program schedules no-op).
  const crankScheduled = useRef<string | null>(null);
  useEffect(() => {
    const owner = anchorWallet?.publicKey.toBase58() ?? null;
    if (!anchorWallet || !owner) return;
    if (!chain.market?.delegated || chain.positions.length === 0) return;
    if (crankScheduled.current === owner) return;
    crankScheduled.current = owner;
    scheduleLiquidationCrankER(anchorWallet, ONCHAIN_MARKET).catch(() => {});
  }, [anchorWallet, chain.market?.delegated, chain.positions.length]);

  const value: MarketCtx = {
    ...snap,
    activeMarket,
    setActiveMarket,
    active,
    chain,
    sessionActive,
    startSession: () => setSessionActive(true),
    faucet: (a) => {
      engine.faucet(a);
      refresh();
    },
    canDeposit: (a) => engine.canDeposit(a),
    canDepositLiquidity: (a) => engine.canDepositLiquidity(a),
    deposit: (a) => {
      engine.deposit(a);
      refresh();
    },
    withdraw: (a) => {
      engine.withdraw(a);
      refresh();
    },
    depositLiquidity: (a) => {
      const shares = engine.depositLiquidity(a);
      refresh();
      return shares;
    },
    withdrawLiquidity: (s) => {
      const usdc = engine.withdrawLiquidity(s);
      refresh();
      return usdc;
    },
    canOpen: (symbol, side, c, l) => engine.canOpen(symbol, side, c, l),
    open: (symbol, side, c, l) => {
      engine.openPosition(symbol, side, c, l);
      setSessionActive(true);
      refresh();
    },
    close: (symbol) => {
      const closed = engine.closePosition(symbol);
      refresh();
      return closed;
    },
    addCollateral: (symbol, a) => {
      engine.addCollateral(symbol, a);
      refresh();
    },
    removeCollateral: (symbol, a) => {
      engine.removeCollateral(symbol, a);
      refresh();
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMarket() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMarket must be used within MarketProvider");
  return c;
}
