"use client";

import { useState } from "react";
import { useMarket } from "@/context/market";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtUsd } from "@/lib/format";
import { FAUCET_AMOUNT } from "@/lib/constants";
import { toast } from "sonner";
import { Coins } from "lucide-react";

export function CollateralDialog({ trigger }: { trigger: React.ReactNode }) {
  const { walletBalance, freeCollateral, deposit, withdraw, canDeposit, faucet } = useMarket();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amt, setAmt] = useState("");
  const n = parseFloat(amt) || 0;
  const max = tab === "deposit" ? walletBalance : freeCollateral;
  const depositErr = tab === "deposit" && n > 0 ? canDeposit(n) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Collateral</DialogTitle>
          <DialogDescription>
            USDC custody settles on the <span className="text-foreground">base layer</span>. Deposits move
            funds from your wallet into free collateral, available for margin.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <div className="text-xs text-muted-foreground">Wallet balance</div>
            <div className="mt-0.5 font-mono font-semibold">{fmtUsd(walletBalance)}</div>
          </div>
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <div className="text-xs text-muted-foreground">Free collateral</div>
            <div className="mt-0.5 font-mono font-semibold">{fmtUsd(freeCollateral)}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-lg bg-secondary/40 p-1">
          {(["deposit", "withdraw"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setAmt("");
              }}
              className={
                "rounded-md py-1.5 text-sm font-semibold capitalize transition-colors " +
                (tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")
              }
            >
              {t}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Amount (USDC)</span>
            <button className="font-mono text-muted-foreground hover:text-foreground" onClick={() => setAmt(String(Math.floor(max)))}>
              Max: {fmtUsd(max)}
            </button>
          </div>
          <Input
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            className="font-mono"
          />
          {depositErr && <p className="text-xs text-down">{depositErr}</p>}
        </div>

        {tab === "deposit" ? (
          <Button
            disabled={!!depositErr || n <= 0}
            onClick={() => {
              const err = canDeposit(n);
              if (err) return toast.error(err);
              deposit(n);
              toast.success(`Deposited ${fmtUsd(n)} to collateral`);
              setAmt("");
            }}
          >
            Deposit to collateral
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={n <= 0 || n > freeCollateral}
            onClick={() => {
              if (n > freeCollateral) return toast.error("Exceeds free collateral");
              withdraw(n);
              toast.success(`Withdrew ${fmtUsd(n)} to wallet`);
              setAmt("");
            }}
          >
            Withdraw to wallet
          </Button>
        )}

        <div className="flex items-center justify-between rounded-lg border border-dashed border-border/70 p-3">
          <div className="text-xs text-muted-foreground">
            Out of test funds? Claim more on devnet.
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              faucet(FAUCET_AMOUNT);
              toast.success(`Claimed ${fmtUsd(FAUCET_AMOUNT)} test USDC`);
            }}
          >
            <Coins className="h-3.5 w-3.5" /> Faucet +{(FAUCET_AMOUNT / 1000).toFixed(0)}k
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
