"use client";

// Clickable links to a transaction on a Solana Explorer. Open/close trades execute on the MagicBlock
// ER, so they link to the ER cluster (erTxUrl); L1 txs (deposits, delegation, withdrawals) link to
// devnet (baseTxUrl). Used in the order panel toast, the positions history table, and activity feeds
// so a trader can verify every trade on-chain.
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { erTxUrl, baseTxUrl, shortKey } from "@/lib/format";

export function TxLink({
  sig,
  layer = "er",
  label,
  className,
}: {
  sig?: string | null;
  layer?: "er" | "base";
  label?: string;
  className?: string;
}) {
  if (!sig) return null;
  const href = layer === "base" ? baseTxUrl(sig) : erTxUrl(sig);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs text-primary underline-offset-2 hover:underline",
        className
      )}
    >
      {label ?? shortKey(sig, 4)}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

// Toast body for a completed ER trade: a label plus a link to the tx on the ER explorer.
export function TxToast({ label, sig }: { label: string; sig: string }) {
  return (
    <span className="flex items-center gap-2">
      <span>{label}</span>
      <span className="text-muted-foreground/60">·</span>
      <TxLink sig={sig} layer="er" label="View on-chain" />
    </span>
  );
}
