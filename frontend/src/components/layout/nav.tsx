"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/brand/logo";
import { WalletButton } from "@/components/wallet-button";
import { OracleHealth, SessionBadge } from "@/components/status-badges";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/trade", label: "Trade" },
  { href: "/positions", label: "Positions" },
  { href: "/pool", label: "Pool" },
  { href: "/profile", label: "Profile" },
];

export function Nav() {
  const pathname = usePathname();
  // Transparent over the hero at the top; fade in the dark glass once the page scrolls under it.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-[background-color,border-color,box-shadow] duration-300",
        scrolled
          ? "glass border-b border-border/60 shadow-[0_10px_30px_-22px_rgba(0,0,0,0.9)]"
          : "border-b border-transparent bg-transparent"
      )}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="shrink-0">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium transition-colors",
                  active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div className="hidden items-center gap-2 sm:flex">
            <SessionBadge />
            <OracleHealth />
          </div>
          <WalletButton size="sm" />
        </div>
      </div>

      {/* mobile nav */}
      <nav
        className={cn(
          "flex items-center gap-1 overflow-x-auto border-t px-3 py-2 md:hidden transition-colors duration-300",
          scrolled ? "border-border/60" : "border-transparent"
        )}
      >
        {LINKS.map((l) => {
          const active = pathname === l.href || pathname.startsWith(l.href + "/");
          return (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "whitespace-nowrap px-3 py-1.5 text-sm font-medium",
                active ? "bg-secondary text-foreground" : "text-muted-foreground"
              )}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
