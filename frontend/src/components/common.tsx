"use client";

import { cn } from "@/lib/utils";

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
