import { cn } from "@/lib/utils";

// Shear glyph: two layers sliding past each other (the mechanical metaphor).
export function ShearMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn("h-6 w-6", className)} aria-hidden>
      <path d="M3 8.5h13l-3.2-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 15.5H8l3.2 3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.65" />
    </svg>
  );
}

export function Wordmark({ className, glyphClassName }: { className?: string; glyphClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span className="grid h-8 w-8 place-items-center bg-primary/15 text-primary ring-1 ring-primary/30">
        <ShearMark className={cn("h-5 w-5", glyphClassName)} />
      </span>
      <span className="text-[1.05rem] font-semibold tracking-[0.02em]">SHEAR</span>
    </span>
  );
}
