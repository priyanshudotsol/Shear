"use client";

// Real on-chain activity feed: recent transactions touching the SHEAR program on
// both the base layer and the MagicBlock ER, with the emitted anchor event parsed
// from the transaction logs where available.
import { useEffect, useRef, useState, useCallback } from "react";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import idl from "./idl/shear.json";
import { baseConn, erConn, programId } from "./chain";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parser = new EventParser(programId, new BorshCoder(idl as any));

const LABELS: Record<string, string> = {
  PositionOpened: "Position opened",
  PositionClosed: "Position closed",
  PositionModified: "Margin adjusted",
  Liquidated: "Liquidation",
  FundingAccrued: "Funding accrued",
  LiquidityDeposited: "LP deposit",
  LiquidityWithdrawn: "LP withdraw",
  CollateralDeposited: "Collateral deposit",
  CollateralWithdrawn: "Collateral withdraw",
  MarketCreated: "Market created",
  MarketStatusChanged: "Market status changed",
  BadDebtIncurred: "Bad debt",
  OracleStaleSkipped: "Oracle stale (skipped)",
};

export interface ChainEvent {
  signature: string;
  blockTime: number | null;
  source: "base" | "ER";
  label: string;
  err: boolean;
}

async function parseLabel(conn: Connection, signature: string): Promise<string | null> {
  try {
    const tx = await conn.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    const logs = tx?.meta?.logMessages;
    if (!logs) return null;
    for (const ev of parser.parseLogs(logs)) {
      if (LABELS[ev.name]) return LABELS[ev.name];
    }
    return null;
  } catch {
    return null;
  }
}

export function useChainEvents(intervalMs = 30_000): { events: ChainEvent[]; loading: boolean } {
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const labelCache = useRef<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    try {
      const [baseSigs, erSigs] = await Promise.all([
        baseConn.getSignaturesForAddress(programId, { limit: 8 }).catch(() => []),
        erConn.getSignaturesForAddress(programId, { limit: 8 }).catch(() => []),
      ]);
      const merged = [
        ...baseSigs.map((s) => ({ ...s, source: "base" as const, conn: baseConn })),
        ...erSigs.map((s) => ({ ...s, source: "ER" as const, conn: erConn })),
      ]
        .sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0))
        .slice(0, 16);

      // parse labels for any new signatures (cached)
      await Promise.all(
        merged.map(async (s) => {
          if (!labelCache.current.has(s.signature)) {
            const label = await parseLabel(s.conn, s.signature);
            labelCache.current.set(s.signature, label ?? "Program transaction");
          }
        })
      );

      setEvents(
        merged.map((s) => ({
          signature: s.signature,
          blockTime: s.blockTime ?? null,
          source: s.source,
          label: labelCache.current.get(s.signature) ?? "Program transaction",
          err: !!s.err,
        }))
      );
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, intervalMs);
    return () => clearInterval(id);
  }, [load, intervalMs]);

  return { events, loading };
}
