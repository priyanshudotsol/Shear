"use client";

// Reads the connected wallet's REAL on-chain balances on Solana devnet:
// native SOL and the SPL USDC token balance. Refreshes on connect + on an interval.
import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { USDC_MINTS_DEVNET, TOKEN_PROGRAM_IDS } from "./constants";

const USDC_SET = new Set(USDC_MINTS_DEVNET);

export interface WalletBalances {
  sol: number | null;
  usdc: number | null;
  loading: boolean;
  refresh: () => void;
}

export function useWalletBalances(intervalMs = 30_000): WalletBalances {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!publicKey) {
        if (!cancelled) {
          setSol(null);
          setUsdc(null);
        }
        return;
      }
      setLoading(true);
      try {
        const lamports = await connection.getBalance(publicKey);
        if (!cancelled) setSol(lamports / 1e9);
      } catch {
        if (!cancelled) setSol(null);
      }
      try {
        // scan token accounts under both token programs, sum any known USDC mint
        const results = await Promise.all(
          TOKEN_PROGRAM_IDS.map((pid) =>
            connection
              .getParsedTokenAccountsByOwner(publicKey, { programId: new PublicKey(pid) })
              .catch(() => ({ value: [] as never[] }))
          )
        );
        let total = 0;
        for (const res of results) {
          for (const { account } of res.value) {
            const info = account.data.parsed?.info;
            if (info && USDC_SET.has(info.mint)) total += info.tokenAmount?.uiAmount ?? 0;
          }
        }
        if (!cancelled) setUsdc(total);
      } catch {
        if (!cancelled) setUsdc(0);
      }
      if (!cancelled) setLoading(false);
    };

    load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection, publicKey, intervalMs, nonce]);

  return { sol, usdc, loading, refresh };
}
