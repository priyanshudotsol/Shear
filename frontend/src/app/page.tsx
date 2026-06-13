"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/common";
import { HeroChartBg } from "@/components/landing/hero-chart-bg";
import { Reveal, Stagger, StaggerItem, GlowBlob } from "@/components/motion";
import { ArrowRight, Scale, Activity, Layers, Gauge, ShieldCheck, Zap } from "lucide-react";

const FEATURES = [
  {
    icon: Scale,
    title: "Exact market-neutrality",
    body: "uPnL = side × notional × (Rₙₒw / Rₑₙₜᵣy − 1). One synthetic ratio instrument - path-independent, zero leg drift. Being right about the matchup pays even when the market is wrong.",
  },
  {
    icon: Layers,
    title: "Oracle-priced shared pool",
    body: "Fills clear at the on-chain ratio against a single USDC LP pool - no order book, no vAMM, no price impact. The pool is the counterparty and earns fees plus funding.",
  },
  {
    icon: Activity,
    title: "Repriced continuously",
    body: "Pyth feeds divided on-chain on a MagicBlock Ephemeral Rollup. Equity, margin and liquidation re-tick at oracle cadence - the chain confirms, the UI predicts.",
  },
  {
    icon: Gauge,
    title: "Skew funding",
    body: "The heavier side of open interest pays the lighter side and the pool, pushing the book toward balance. Mark = oracle index, so there's no premium to measure.",
  },
  {
    icon: ShieldCheck,
    title: "Crank liquidation",
    body: "A per-block on-chain crank sweeps underwater positions, with a permissionless liquidate backstop. Conservative 5% maintenance margin and OI caps bound bad debt.",
  },
  {
    icon: Zap,
    title: "Gasless sessions",
    body: "One approval mints a session key - after that, open and close are popup-free and fee-free. Zero ER fees make per-block cranking and rapid repricing effectively free.",
  },
];

const STEPS = [
  { n: "01", t: "Pick a pair", d: "SOL-ETH, SOL-BTC or ETH-BTC. The instrument is the ratio R = BASE/USD ÷ QUOTE/USD." },
  { n: "02", t: "Take a side", d: "Long if you think the base outperforms the quote; short for the reverse. The market they share cancels out." },
  { n: "03", t: "Trade gaslessly", d: "Collateral and leverage in, one synthetic position out - settled on the rollup at the live ratio." },
  { n: "04", t: "Win the matchup", d: "PnL tracks the relationship, not the direction. Close any time; the pool settles instantly." },
];

const BUILT_ON = ["Solana", "MagicBlock ER", "Pyth", "USDC"];
const SECTION = "mx-auto w-full max-w-6xl px-5 sm:px-6 lg:px-8";
const fadeUp = { hidden: { opacity: 0, y: 22 }, show: { opacity: 1, y: 0 } };
const heroContainer = { hidden: {}, show: { transition: { staggerChildren: 0.1, delayChildren: 0.05 } } };

export default function Home() {
  return (
    <div className="overflow-hidden">
      {/* Hero */}
      <section className="relative isolate overflow-hidden">
        <HeroChartBg />
        <div className="pointer-events-none absolute inset-0 z-0 bg-grid radial-fade opacity-30" />
        <GlowBlob className="pointer-events-none absolute left-1/2 top-[-15%] z-0 h-[460px] w-[min(900px,95vw)] -translate-x-1/2 rounded-full bg-primary/10 blur-[130px]" />
        <div className={`${SECTION} relative z-10 py-20 sm:py-28 lg:py-36`}>
          <motion.div className="max-w-3xl" variants={heroContainer} initial="hidden" animate="show">
            <motion.h1
              variants={fadeUp}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="text-balance text-[3.25rem] font-semibold leading-[1.02] tracking-tight sm:text-7xl lg:text-[5.5rem]"
            >
              Trade the <span className="text-gradient-brand">relationship</span>, not the direction.
            </motion.h1>
            <motion.p
              variants={fadeUp}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="mt-8 max-w-xl text-pretty text-lg text-muted-foreground sm:text-xl"
            >
              SHEAR is a relative-value perpetual exchange. Long SOL, short ETH - in a single click, as
              one market-neutral position, repriced continuously on a real-time rollup.
            </motion.p>
            <motion.div
              variants={fadeUp}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-5"
            >
              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                <Button render={<Link href="/trade" />} nativeButton={false} size="lg" className="gap-2 text-lg">
                  Launch app <ArrowRight className="h-5 w-5" />
                </Button>
              </motion.div>
              <dl className="flex items-center gap-x-6 sm:gap-x-8">
                {[
                  ["50×", "max leverage"],
                  ["5ms", "block time"],
                  ["0 fees", "gasless sessions"],
                ].map(([a, b]) => (
                  <div key={a}>
                    <dt className="font-mono text-base font-semibold leading-none tracking-tight">{a}</dt>
                    <dd className="mt-1 text-xs text-muted-foreground">{b}</dd>
                  </div>
                ))}
              </dl>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Built on */}
      <section className={`${SECTION} pb-4`}>
        <Reveal className="beam-border relative overflow-hidden flex flex-wrap items-center justify-center gap-x-8 gap-y-3 rounded-2xl border border-border/60 bg-card/30 px-6 py-5">
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground/70">Built on</span>
          {BUILT_ON.map((b) => (
            <span key={b} className="text-sm font-medium text-muted-foreground">
              {b}
            </span>
          ))}
        </Reveal>
      </section>

      {/* Features */}
      <section className={`${SECTION} py-20 sm:py-28`}>
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow className="mx-auto">Why SHEAR</Eyebrow>
          <h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Quant-grade relative value, retail can touch.
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            Pairs trading has driven flows for forty years using two positions and two margin accounts.
            SHEAR collapses it into a single perp on the relationship itself.
          </p>
        </Reveal>
        <Stagger className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <StaggerItem
              key={f.title}
              hover
              className="group h-full rounded-2xl border border-border bg-card/50 p-6 transition-colors hover:border-primary/40 hover:bg-card"
            >
              <motion.div
                whileHover={{ rotate: -6, scale: 1.08 }}
                transition={{ type: "spring", stiffness: 300, damping: 15 }}
                className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20"
              >
                <f.icon className="h-5 w-5" />
              </motion.div>
              <h3 className="mt-5 font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      {/* How it works */}
      <section className={`${SECTION} py-20 sm:py-28`}>
        <Reveal>
          <div className="rounded-3xl border border-border bg-card/40 p-7 sm:p-12 lg:p-16">
            <div className="max-w-2xl">
              <Eyebrow>How it works</Eyebrow>
              <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
                Four steps from view to position.
              </h2>
            </div>
            <Stagger className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s) => (
                <StaggerItem key={s.n}>
                  <div className="font-mono text-sm font-semibold text-primary">{s.n}</div>
                  <div className="mt-3 h-px w-full bg-border/70" />
                  <h3 className="mt-4 font-semibold">{s.t}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
                </StaggerItem>
              ))}
            </Stagger>
          </div>
        </Reveal>
      </section>

      {/* Final CTA */}
      <section className={`${SECTION} pb-24 pt-4`}>
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-border bg-card/50 px-6 py-16 text-center sm:py-20">
            <div className="pointer-events-none absolute inset-0 bg-dots opacity-40" />
            <GlowBlob className="pointer-events-none absolute left-1/2 top-0 h-48 w-[min(700px,90vw)] -translate-x-1/2 rounded-full bg-primary/10 blur-[100px]" />
            <div className="relative mx-auto max-w-xl">
              <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                Take a view on the matchup.
              </h2>
              <p className="mt-4 text-pretty text-muted-foreground">
                Connect a wallet, claim test USDC, and open your first ratio perp - gasless, on devnet.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                  <Button render={<Link href="/trade" />} nativeButton={false} size="lg" className="gap-2 text-base">
                    Launch app <ArrowRight className="h-4 w-4" />
                  </Button>
                </motion.div>
                <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                  <Button render={<Link href="/pool" />} nativeButton={false} size="lg" variant="secondary" className="text-base">
                    Provide liquidity
                  </Button>
                </motion.div>
              </div>
            </div>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
