"use client";

// Polls real on-chain SHEAR state for the deployed market (SOL-ETH) and the
// connected wallet. Config/UserBalance/Position from base; Market+Pool from the ER.
import { useEffect, useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  fetchConfig,
  fetchMarket,
  fetchPool,
  fetchUserBalance,
  fetchPositions,
  fetchTokenBalance,
  fetchLpShares,
  isPoolDelegated,
  pda,
  type ChainMarket,
  type ChainPool,
  type ChainPosition,
} from "./chain";

// Only this market is actually deployed on-chain.
export const ONCHAIN_MARKET = "SOL-ETH";

export interface ChainConfig {
  admin: string;
  usdcMint: string;
  paused: boolean;
  takerFeeBps: number;
}

export interface ChainData {
  config: ChainConfig | null;
  market: ChainMarket | null;
  pool: ChainPool | null;
  userFree: number | null; // connected wallet's free collateral (USDC), null = no account
  positions: ChainPosition[]; // all OPEN positions in the trader's book
  mockUsdc: number; // connected wallet's balance of the program's collateral mint
  lpShares: number; // connected wallet's LP shares in this pool
  poolDelegated: boolean; // pool currently delegated to the ER (base deposits paused)
  loading: boolean;
  error: boolean;
  refresh: () => void;
}

export function useChainData(intervalMs = 20_000): ChainData {
  const { publicKey } = useWallet();
  const [config, setConfig] = useState<ChainConfig | null>(null);
  const [market, setMarket] = useState<ChainMarket | null>(null);
  const [pool, setPool] = useState<ChainPool | null>(null);
  const [userFree, setUserFree] = useState<number | null>(null);
  const [positions, setPositions] = useState<ChainPosition[]>([]);
  const [mockUsdc, setMockUsdc] = useState(0);
  const [lpShares, setLpShares] = useState(0);
  const [poolDelegated, setPoolDelegated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let cancelled = false;
    const owner = publicKey ?? null;

    const load = async () => {
      try {
        const [cfg, mkt, delegated] = await Promise.all([
          fetchConfig(),
          fetchMarket(ONCHAIN_MARKET),
          isPoolDelegated(ONCHAIN_MARKET),
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setMarket(mkt);
        setPoolDelegated(delegated);
        const poolData = await fetchPool(pda.market(ONCHAIN_MARKET));
        if (cancelled) return;
        setPool(poolData);
        if (owner) {
          const [free, pos, lp] = await Promise.all([
            fetchUserBalance(owner),
            fetchPositions(owner, ONCHAIN_MARKET),
            fetchLpShares(owner, ONCHAIN_MARKET),
          ]);
          const mock = cfg ? await fetchTokenBalance(owner, new PublicKey(cfg.usdcMint)) : 0;
          if (cancelled) return;
          setUserFree(free);
          setPositions(pos);
          setLpShares(lp);
          setMockUsdc(mock);
        } else {
          setUserFree(null);
          setPositions([]);
          setLpShares(0);
          setMockUsdc(0);
        }
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [publicKey, intervalMs, nonce]);

  return { config, market, pool, userFree, positions, mockUsdc, lpShares, poolDelegated, loading, error, refresh };
}
