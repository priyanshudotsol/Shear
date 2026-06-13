import Link from "next/link";
import { Wordmark } from "@/components/brand/logo";

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const PRODUCT_LINKS = [
  { href: "/trade", label: "Trade" },
  { href: "/pool", label: "Pool" },
];

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-border/60">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="flex flex-col gap-8 md:flex-row md:justify-between">
          <div className="max-w-sm space-y-3">
            <Wordmark />
            <p className="text-sm leading-relaxed text-muted-foreground">
              Relative-value perpetuals on MagicBlock. Trade the relationship between two assets —
              one position, one margin, one liquidation.
            </p>
          </div>

          <div className="flex gap-16 sm:gap-24">
            <div className="flex flex-col gap-3 text-sm">
              <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
                Product
              </span>
              {PRODUCT_LINKS.map((l) => (
                <Link key={l.href} href={l.href} className="text-muted-foreground transition-colors hover:text-foreground">
                  {l.label}
                </Link>
              ))}
            </div>

            <div className="flex flex-col gap-3 text-sm">
              <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
                Connect
              </span>
              <Link
                href="https://x.com/priyanshudotsol"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <XIcon className="h-3.5 w-3.5" />
                @priyanshudotsol
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-3 border-t border-border/60 pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} SHEAR. Solana devnet · MagicBlock devnet ER.</p>
          <p>Not financial advice.</p>
        </div>
      </div>
    </footer>
  );
}
