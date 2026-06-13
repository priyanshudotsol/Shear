import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Resolve any CSS color expression (incl. `var(--x)`, oklch, color-mix) to an sRGB hex/rgba string.
// Canvas-based consumers (lightweight-charts, the TradingView library) can't parse oklch/lab, and
// browsers now serialize computed `color` in its own space - so we rasterize a pixel and read it back.
export function resolveCssColor(expr: string, fallback = "#000000"): string {
  if (typeof window === "undefined") return fallback
  const probe = document.createElement("span")
  probe.style.color = expr
  probe.style.display = "none"
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  if (!computed) return fallback
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!ctx) return computed
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = computed
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
}

// Resolve a theme CSS variable (e.g. "--brand") to an sRGB color string.
export const themeVar = (name: string, fallback?: string): string =>
  resolveCssColor(`var(${name})`, fallback)
