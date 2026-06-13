"use client";

import { useMarket } from "@/context/market";
import { TvChart } from "@/components/tv-chart";

// Live ratio chart rendered full-bleed behind the hero, dimmed and edge-faded so the headline text
// reads cleanly over it. Non-interactive (pointer-events-none) — it's pure ambient motion.
export function HeroChartBg() {
  const { active } = useMarket();
  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 opacity-25 [mask-image:linear-gradient(to_bottom,transparent,black_18%,black_82%,transparent)]"
      aria-hidden
    >
      <div className="flex h-full w-full">
        <TvChart base={active.base} quote={active.quote} liveRatio={active.ratio} minimal fill />
      </div>
    </div>
  );
}
