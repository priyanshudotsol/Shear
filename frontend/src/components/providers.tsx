"use client";

import { Buffer } from "buffer";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter } from "@solana/wallet-adapter-base";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { MarketProvider } from "@/context/market";
import { ENDPOINTS } from "@/lib/constants";
import "@solana/wallet-adapter-react-ui/styles.css";

if (typeof window !== "undefined") {
  // web3.js / wallet-adapter expect a global Buffer in the browser.
  (window as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Phantom, Solflare, Backpack register themselves via the Wallet Standard.
  const wallets = useMemo<Adapter[]>(() => [], []);

  return (
    <ConnectionProvider endpoint={ENDPOINTS.base}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <MarketProvider>
            <TooltipProvider delay={150}>
              {children}
              <Toaster position="bottom-right" />
            </TooltipProvider>
          </MarketProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
