"use client";

import { cn } from "@/lib/utils";
import { GlowBlob } from "@/components/motion";

/** Shared card surface — matches the landing page's soft, rounded panels. */
export const PANEL = "rounded-2xl border border-border bg-card/60";

/** Subtle grid + brand glow at the top of a page, tying every route to the landing canvas.
 *  Drop inside a `relative` page wrapper. */
export function PageBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[440px] overflow-hidden">
      <div className="absolute inset-0 bg-grid radial-fade opacity-[0.35]" />
      <GlowBlob className="absolute left-1/2 top-[-30%] h-[360px] w-[min(900px,95vw)] -translate-x-1/2 rounded-full bg-primary/10 blur-[130px]" />
    </div>
  );
}

/** Consistent page header: eyebrow pill + title + subtitle, with an optional right-aligned action. */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div>
        {eyebrow != null && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle != null && <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  className,
  valueClassName,
  mono = true,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
  valueClassName?: string;
  mono?: boolean;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-semibold tnum", mono && "font-mono", valueClassName)}>{value}</div>
      {sub != null && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs font-medium text-muted-foreground",
        className
      )}
    >
      {children}
    </div>
  );
}

export function PnlText({ value, className, withSign = true }: { value: number; className?: string; withSign?: boolean }) {
  const pos = value >= 0;
  return (
    <span className={cn("tnum font-mono", pos ? "text-up" : "text-down", className)}>
      {withSign && pos ? "+" : ""}
      {value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}
