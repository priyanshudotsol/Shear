import Link from "next/link";
import { Wordmark } from "@/components/brand/logo";
import { PROGRAM_ID } from "@/lib/constants";
import { shortKey } from "@/lib/format";

export function Footer() {
  return (
    <footer className="mt-24 border-t border-border/60">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="space-y-3">
          <Wordmark />
          <p className="max-w-sm text-sm text-muted-foreground">
            Relative-value perpetuals on MagicBlock. Trade the relationship between two assets — one
            position, one margin, one liquidation.
          </p>
        </div>
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="text-foreground/70">Program</span>
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{shortKey(PROGRAM_ID, 6)}</code>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/trade" className="hover:text-foreground">Trade</Link>
            <Link href="/pool" className="hover:text-foreground">Pool</Link>
          </div>
          <p className="text-xs">Solana devnet · MagicBlock devnet ER · not financial advice.</p>
        </div>
      </div>
    </footer>
  );
}
