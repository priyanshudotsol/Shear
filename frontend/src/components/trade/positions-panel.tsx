"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { useMarket, type MarketSnap } from "@/context/market";
import { Button } from "@/components/ui/button";
import { WalletButton } from "@/components/wallet-button";
import type { ChainData } from "@/lib/use-chain-data";
import type { ChainPosition } from "@/lib/chain";
import { closePositionER, settleAndWithdraw } from "@/lib/chain-trade";
import { recordTrade, getTrades, hydrateTrades, type ClosedTrade } from "@/lib/trade-log";
import { fmtUsd, fmtUsdSigned, fmtRatio, fmtPct } from "@/lib/format";
import * as M from "@/lib/shear-math";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Inbox } from "lucide-react";

type Tab = "positions" | "orders" | "history";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PositionsPanel() {
  const { connected, publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { active, chain } = useMarket();
  const positions = chain.positions;
  const usdcMint = chain.config?.usdcMint;
  const [tab, setTab] = useState<Tab>("positions");
  const [busy, setBusy] = useState<string | null>(null);

  // closed-trade history (localStorage) — re-read when the open book changes (a close adds a row)
  const owner = publicKey?.toBase58() ?? null;
  const [history, setHistory] = useState<ClosedTrade[]>([]);
  useEffect(() => {
    if (!owner) return setHistory([]);
    setHistory(getTrades(owner)); // instant from localStorage
    hydrateTrades(owner).then(setHistory).catch(() => {}); // then the durable DB copy
  }, [owner, positions.length, busy]);

  async function closeAll() {
    if (!anchorWallet || !usdcMint) return toast.error("Connect a wallet");
    const snap = positions.map((p) => {
      const m = metrics(p, active, chain);
      return { symbol: active.symbol, side: p.side, notional: p.notional, collateral: p.collateral, leverage: p.collateral > 0 ? p.notional / p.collateral : 0, entryRatio: p.entryRatio, exitRatio: active.ratio, realizedPnl: m.upnl, status: "closed" as const };
    });
    try {
      const { closed, withdrawn } = await settleAndWithdraw(anchorWallet, new PublicKey(usdcMint), active.symbol, setBusy);
      snap.slice(0, closed).forEach((t) => recordTrade(owner!, t));
      if (withdrawn <= 0) toast.message(closed ? `Closed ${closed}; nothing to withdraw` : "Nothing to withdraw");
      else toast.success(`Closed ${closed} · withdrew ${fmtUsd(withdrawn)} to your wallet`);
      setTimeout(chain.refresh, 1500);
    } catch (e) {
      toast.error(`Close all failed: ${errMsg(e).slice(0, 140)}`);
    } finally {
      setBusy(null);
    }
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "positions", label: "Positions", count: positions.length },
    { id: "orders", label: "Open Orders", count: 0 },
    { id: "history", label: "History", count: history.length },
  ];

  return (
    <div className="rounded-2xl border border-border bg-card/60">
      {/* tab bar */}
      <div className="flex items-center justify-between border-b border-border/60 px-4">
        <div className="flex items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "relative flex items-center gap-1.5 px-3 py-3 text-sm font-medium transition-colors",
                tab === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{t.count}</span>
              )}
              {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
            </button>
          ))}
        </div>
        {tab === "positions" && positions.length > 0 && (
          <Button onClick={closeAll} disabled={!!busy} variant="secondary" size="sm" className="h-7 text-xs">
            {busy ?? "Close All"}
          </Button>
        )}
      </div>

      {!connected ? (
        <Empty title="Connect your wallet" body="Connect to view your positions and trade history.">
          <WalletButton />
        </Empty>
      ) : tab === "positions" ? (
        positions.length === 0 ? (
          <Empty title="No open positions" body="Open a ratio perp from the panel on the right to get started." />
        ) : (
          <PositionsTable positions={positions} active={active} chain={chain} busy={!!busy} owner={owner!} />
        )
      ) : tab === "orders" ? (
        <Empty title="No open orders" body="SHEAR fills at the live oracle ratio — every order is a market order, so there are no resting limit orders." />
      ) : history.length === 0 ? (
        <Empty title="No trade history" body="Closed and liquidated positions will appear here." />
      ) : (
        <HistoryTable trades={history} symbol={active.symbol} />
      )}
    </div>
  );
}

function metrics(p: ChainPosition, active: MarketSnap, chain: ChainData) {
  return M.positionMetrics({
    side: p.side,
    notional: p.notional,
    collateral: p.collateral,
    entryRatio: p.entryRatio,
    curRatio: active.ratio,
    cumNow: chain.market?.cumFunding ?? 0,
    cumEntry: p.entryCumFunding,
  });
}

function PositionsTable({ positions, active, chain, busy, owner }: { positions: ChainPosition[]; active: MarketSnap; chain: ChainData; busy: boolean; owner: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <Th>Position</Th>
            <Th className="text-right">Net Value</Th>
            <Th className="hidden text-right sm:table-cell">Entry / Mark</Th>
            <Th className="hidden text-right md:table-cell">Liq. Ratio</Th>
            <Th className="hidden text-right sm:table-cell">Size</Th>
            <Th className="hidden text-right md:table-cell">Collateral</Th>
            <Th className="text-right">Close</Th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <PositionRow key={p.slot} pos={p} active={active} chain={chain} busy={busy} owner={owner} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionRow({ pos: p, active, chain, busy, owner }: { pos: ChainPosition; active: MarketSnap; chain: ChainData; busy: boolean; owner: string }) {
  const anchorWallet = useAnchorWallet();
  const [closing, setClosing] = useState(false);
  const m = metrics(p, active, chain);
  const long = p.side === "long";
  const leverage = p.collateral > 0 ? p.notional / p.collateral : 0;

  async function close() {
    if (!anchorWallet) return toast.error("Connect a wallet");
    try {
      setClosing(true);
      const sig = await closePositionER(anchorWallet, active.symbol, p.slot);
      recordTrade(owner, { symbol: active.symbol, side: p.side, notional: p.notional, collateral: p.collateral, leverage: p.collateral > 0 ? p.notional / p.collateral : 0, entryRatio: p.entryRatio, exitRatio: active.ratio, realizedPnl: m.upnl, status: "closed", signature: sig });
      toast.success(`Closed ${p.side} · ${sig.slice(0, 8)}`);
      setTimeout(chain.refresh, 1500);
    } catch (e) {
      toast.error(`Close failed: ${errMsg(e).slice(0, 140)}`);
    } finally {
      setClosing(false);
    }
  }

  return (
    <tr className="border-b border-border/30 last:border-0 hover:bg-secondary/20">
      <Td>
        <div className="flex items-center gap-2">
          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold uppercase", long ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
            {long ? "Long" : "Short"}
          </span>
          <span className="font-semibold">{active.symbol}</span>
          <span className="font-mono text-xs text-muted-foreground">{leverage.toFixed(1)}×</span>
        </div>
        {!m.healthy && <span className="mt-0.5 block text-[10px] font-medium text-down">at liquidation risk</span>}
      </Td>
      <Td className="text-right">
        <div className="font-mono tnum">{fmtUsd(m.equity)}</div>
        <div className={cn("font-mono text-xs tnum", m.upnl >= 0 ? "text-up" : "text-down")}>
          {fmtUsdSigned(m.upnl)} ({fmtPct(m.pnlPct)})
        </div>
      </Td>
      <Td className="hidden text-right font-mono tnum sm:table-cell">
        <div>{fmtRatio(p.entryRatio)}</div>
        <div className="text-xs text-muted-foreground">{fmtRatio(active.ratio)}</div>
      </Td>
      <Td className="hidden text-right font-mono tnum text-down md:table-cell">{fmtRatio(m.liqRatio)}</Td>
      <Td className="hidden text-right font-mono tnum sm:table-cell">{fmtUsd(p.notional)}</Td>
      <Td className="hidden text-right font-mono tnum md:table-cell">{fmtUsd(p.collateral)}</Td>
      <Td className="text-right">
        <Button onClick={close} disabled={busy || closing} variant="destructive" size="sm" className="h-7 text-xs">
          {closing ? "Closing…" : "Close"}
        </Button>
      </Td>
    </tr>
  );
}

function HistoryTable({ trades, symbol }: { trades: ClosedTrade[]; symbol: string }) {
  const rows = useMemo(() => trades.slice(0, 50), [trades]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <Th>Position</Th>
            <Th className="hidden text-right sm:table-cell">Entry → Exit</Th>
            <Th className="hidden text-right sm:table-cell">Size</Th>
            <Th className="text-right">Realized PnL</Th>
            <Th className="text-right">Status</Th>
            <Th className="hidden text-right md:table-cell">Closed</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const long = t.side === "long";
            const liq = t.status === "liquidated";
            return (
              <tr key={t.id} className="border-b border-border/30 last:border-0 hover:bg-secondary/20">
                <Td>
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold uppercase", long ? "bg-up/15 text-up" : "bg-down/15 text-down")}>
                      {long ? "Long" : "Short"}
                    </span>
                    <span className="font-semibold">{symbol}</span>
                  </div>
                </Td>
                <Td className="hidden text-right font-mono text-xs tnum text-muted-foreground sm:table-cell">
                  {fmtRatio(t.entryRatio)} → {fmtRatio(t.exitRatio)}
                </Td>
                <Td className="hidden text-right font-mono tnum sm:table-cell">{fmtUsd(t.notional)}</Td>
                <Td className={cn("text-right font-mono tnum", t.realizedPnl >= 0 ? "text-up" : "text-down")}>{fmtUsdSigned(t.realizedPnl)}</Td>
                <Td className="text-right">
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase", liq ? "bg-down/15 text-down" : "bg-secondary text-muted-foreground")}>
                    {liq ? "Liquidated" : "Closed"}
                  </span>
                </Td>
                <Td className="hidden text-right text-xs text-muted-foreground md:table-cell">
                  {new Date(t.closedTs * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn("px-4 py-2.5 font-medium", className)}>{children}</th>;
}
function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cn("px-4 py-3 align-middle", className)}>{children}</td>;
}

function Empty({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-secondary text-muted-foreground">
        <Inbox className="h-5 w-5" />
      </div>
      <h3 className="mt-3 text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">{body}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
