"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Wallet, ChevronDown, LogOut, Copy, RefreshCw } from "lucide-react";
import { shortKey } from "@/lib/format";
import { useWalletBalances } from "@/lib/use-wallet-balances";
import { toast } from "sonner";

export function WalletButton({ size = "default" }: { size?: "sm" | "default" | "lg" }) {
  const { publicKey, connected, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const { sol, usdc, loading, refresh } = useWalletBalances();

  if (!connected || !publicKey) {
    return (
      <Button size={size} onClick={() => setVisible(true)} disabled={connecting} className="gap-2 font-medium">
        <Wallet className="h-4 w-4" />
        {connecting ? "Connecting…" : "Connect Wallet"}
      </Button>
    );
  }

  const addr = publicKey.toBase58();
  const fmt = (n: number | null, dp: number) => (n === null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="secondary" size={size} className="gap-2 font-mono text-xs" />}
      >
        <span className="h-2 w-2 rounded-full bg-up" />
        <span className="hidden sm:inline">{fmt(usdc, 2)} USDC</span>
        <span className="hidden h-3 w-px bg-border sm:inline-block" />
        {shortKey(addr)}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <div className="px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              On-chain · devnet
            </span>
            <button
              onClick={(e) => {
                e.preventDefault();
                refresh();
              }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Refresh balances"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
          <div className="flex items-center justify-between py-0.5 text-sm">
            <span className="text-muted-foreground">USDC</span>
            <span className="font-mono">{fmt(usdc, 2)}</span>
          </div>
          <div className="flex items-center justify-between py-0.5 text-sm">
            <span className="text-muted-foreground">SOL</span>
            <span className="font-mono">{fmt(sol, 4)}</span>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            navigator.clipboard.writeText(addr);
            toast.success("Address copied");
          }}
        >
          <Copy className="mr-2 h-4 w-4" /> Copy address
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => disconnect()} className="text-down focus:text-down">
          <LogOut className="mr-2 h-4 w-4" /> Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
