# Relative-Value Perpetuals on MagicBlock — SHEAR

> A Solana exchange where you trade one asset *against* another — long SOL, short ETH, in a single click — as one market-neutral position priced off a ratio that re-ticks every millisecond. One position, one margin, one liquidation, zero leg drift.

## The problem

Every retail trader has the same instinct and no clean way to express it: *"SOL is going to outperform ETH."* That is a **relative-value** view — a bet on the *ratio* SOL/ETH, not on the market going up or down. To express it today you must:

1. **Leg it manually** — open a long SOL perp and a short ETH perp, size both legs, and babysit two positions, two margins, two liquidation prices. This is **leg drift**: when SOL flash-crashes, the long-SOL leg hits *its own* liquidation and gets force-closed while the short-ETH leg keeps running naked — your "market-neutral" pair trade silently becomes a directional short on ETH, against your thesis. (The CME built one-click spread products forty years ago precisely because legged pairs break this way.)
2. **Give up and go directional** — just long SOL and eat the full market beta, so a market-wide dump liquidates you even though your SOL-vs-ETH call was *right*.

TradFi solved this decades ago — pairs / spread / statistical-arbitrage trading is a core desk strategy. Crypto barely has it. The one dedicated venue, **Pear Protocol**, runs *on top of Hyperliquid* (Arbitrum) by opening two separate perps and netting them in the UI — it raised $4.1M in 2025, which proves the demand. **On Solana there is nothing.**

The core friction is structural: a ratio reprices on *every tick of both legs*. Managing two legs at ~400ms slot times with a fee on every adjustment means the edge leaks away before you capture it. Relative-value trading needs a venue that reprices and re-margins continuously, for free.

## The solution

**SHEAR makes the ratio itself the instrument.** One market = one pair (`SOL-ETH`). One position. One collateral balance. One liquidation price.

- The market's price *is* the oracle ratio `R = price(SOL) / price(ETH)`.
- **Long `SOL-ETH`** profits when SOL outperforms ETH — regardless of whether the whole market is green or red.
- PnL is exact and path-independent: `uPnL = side × notional × (R_now / R_entry − 1)`.
- Trades fill at the live oracle ratio against a shared USDC liquidity pool — no order book, no two-leg drift, no slippage from depth.
- The ratio re-ticks every ER block (~1ms render, ~50–200ms true oracle freshness), funding accrues continuously, and an on-chain crank checks liquidations every block — none of which is affordable on L1.

You take a view on *which asset wins*. You are immune to the market they're both swimming in. That is the entire pitch, and it is a category that does not exist on Solana.

**Structural bonus — less bad debt.** A ratio mark moves only as much as the two legs move *relative to each other*. A 20% SOL crash when ETH also drops 18% moves the ratio ~2%, where a SOL/USD perp moves the full 20% and blows through margin. So for the same leverage, ratio perps liquidate less violently and accrue less bad debt than single-asset perps — a real risk advantage for the LP pool, not just a UX one.

## Why this only works on MagicBlock

| Capability | Why SHEAR needs it | L1 reality |
|---|---|---|
| **~1ms blocks / <50ms latency** | The ratio of two volatile assets moves constantly; mark, equity, and liquidation must track it live | ~400ms slots → stale ratio, late liquidations |
| **Zero fees** | Continuous funding accrual + per-block liquidation checks + free re-margining are the product | A fee on every tick/adjustment kills the strategy |
| **On-chain crank (`ScheduleTask`)** | Funding index and liquidation sweep run every block with no external keeper | Needs an off-chain bot; trust + latency + downtime |
| **Real-time oracle (Pyth Lazer)** | Two fresh feeds (SOL/USD, ETH/USD) divided on-chain into a live ratio | Sponsored push feeds update ~1/min — far too slow |
| **Session keys** | One-click, gasless open/close so the UX feels like a CEX | Per-tx wallet popups break the flow |

A relative-value perp is *defined* by continuous repricing and re-margining. That is exactly the thing only a zero-fee, ~1ms chain can do. The market neutrality is the product; MagicBlock is what makes the product affordable to run.

## Architecture

```
Base Layer (Solana devnet)            Ephemeral Rollup (MagicBlock devnet)
──────────────────────────           ────────────────────────────────────
GlobalConfig (params)                 Market PDA  (longOI, shortOI, cumFunding)
USDC vault (the LP pool)  ── delegate ─► UserBalance PDA (free collateral)
LpPosition (shares)                    Position PDA (side, notional, R_entry, ...)
                                       ephemeral-oracle feeds: SOL/USD, ETH/USD
deposit / withdraw  ◄── commit ──────  open / close / modify / liquidate
collateral & LP settlement             funding accrual + liq sweep (crank, every block)
```

Components:
1. **Anchor program** with `#[ephemeral]` — markets, LP pool, collateral, `open_position`, `close_position`, `liquidate`, `accrue_funding`. (Full list in `PROGRAM.md`.)
2. **Oracle**: MagicBlock real-time-pricing-oracle, two feeds (SOL/USD + ETH/USD) divided on-chain into the ratio (`oracle.md`).
3. **Crank**: `ScheduleTask` drives `accrue_funding` + `crank_liquidations` every N ms — no external keeper (`components.md`).
4. **Execution v0**: oracle-priced fills against a shared USDC LP pool, no price impact, 6bps taker fee.
5. **Frontend**: ratio chart (live, ms ticks), one-click long/short, position card with live equity + liquidation ratio, and the market-neutral demo panel.

The math (PnL, margin, skew-based funding, liquidation, LP accounting) is specified end-to-end in `MATH.md`.

## Demo strategy

Split screen. The pitch lands in 10 seconds: **being right about the matchup should pay even when the market is wrong.**

**Setup:** A live, scripted market move where *both* assets fall but by different amounts — e.g. SOL −8%, ETH −12% over the clip. SOL outperformed ETH, so the ratio `SOL/ETH` rose.

**Left panel — directional trader (the old way):** Long SOL 10x on a normal perp. The market dumps, SOL is down 8%, and 10x liquidates on a ~5% adverse move — so the position is **liquidated**. "You were right that SOL would outperform — and you still got wiped out."

**Right panel — SHEAR:** Long `SOL-ETH` 10x. The ratio rose ~4.5%, so at 10x the position is up ~45% on collateral — **green** through the entire dump. Market-neutral: the −8%/−12% common move cancels; only the relative move pays.

Bottom ticker: the live ratio re-ticking every ER block, the funding rate ticking continuously, and a "liquidation engine: checked 312 blocks ago → now" heartbeat from the crank. Final shot: directional PnL = −$X (liquidated), SHEAR PnL = +$Y. Same correct thesis, opposite outcome.

## Why this wins the hackathon

| Criterion | SHEAR |
|---|---|
| Eligible for the $500 trading prize | Yes — it's an exchange; you open and manage real leveraged positions |
| "Pure trading," not a game or betting | Yes — relative-value perps are a core desk strategy, no event/lottery framing |
| Load-bearing on MagicBlock | Yes — continuous repricing + funding + per-block liquidation are unaffordable on L1 |
| Unique / uncrowded | Yes — proven by Pear ($4.1M) but **zero equivalent on Solana** |
| Demo-friendly | Market-neutral PnL through a crash is a visceral, 10-second story |
| Weekend-feasible | Single synthetic instrument, oracle-priced (no order book, no matching engine) |
| Doesn't collide with SHIM / SLIP | Different lane — a relative-value venue, not an execution auction or a copy vault |

**Beyond the hackathon (one line).** The same single-instrument margin engine generalizes from a ratio (`[+SOL, −ETH]`) to baskets and sector indices (`legs: Vec<(feed, weight)>`) and calendar spreads — i.e. a margin engine for arbitrary *linear combinations* of perps, where each new instrument ships without a new contract architecture. That's the long-term wedge; the weekend build is the ratio case, end-to-end. Out of scope for v0, but the account schema shouldn't preclude it.

## Build plan (48 hours)

**Day 1 morning** — Anchor scaffold. `GlobalConfig`, `Market`, `LiquidityPool`, `UserBalance`, `Position` layouts (`PROGRAM.md`). Delegation hooks (`#[ephemeral]`, `#[delegate]`, `#[commit]`).
**Day 1 afternoon** — Pure math module (`src/math.rs`): ratio, PnL, margin, funding, liquidation. Property tests *before* wiring Anchor. This is the load-bearing code.
**Day 1 evening** — Two-feed oracle read + on-chain ratio. `open_position` / `close_position` against the LP pool.
**Day 2 morning** — `accrue_funding` + `liquidate`; wire the `ScheduleTask` crank. Collateral deposit/withdraw + LP deposit/withdraw on base layer.
**Day 2 afternoon** — Frontend: ratio chart, one-click trade, position card, LP card. Session keys for gasless trading.
**Day 2 evening** — The market-neutral demo panel (scripted dump), devnet deploy, recording, submission writeup.

## Open questions to resolve before building

- **Markets at launch:** one (`SOL-ETH`) for the demo, or two (`SOL-ETH`, `SOL-BTC`)? Start with one; the code is market-generic.
- **vAMM vs oracle-priced pool:** we chose oracle-priced LP pool for clean exact ratio PnL (see `MATH.md` §counterparty). Confirm before building; switching later is expensive.
- **Funding model:** skew-based (heavier OI side pays) vs premium-based. We chose skew-based because mark = oracle index here (no premium to measure). Confirm.
- **Liquidation:** permissionless `liquidate` + a crank sweep, or crank-only? v0 ships both (permissionless is the safety net).
- **Bad debt:** if a gap blows through maintenance margin, who eats it? v0: the LP pool, bounded by OI caps + a conservative MMR. Document, don't over-engineer.
- **Collateral:** real delegated devnet USDC vs synthetic balance? Synthetic is fine for the demo.

## Sources

- Pear Protocol (pairs trading on Hyperliquid): https://docs.pearprotocol.io/
- GMX v1 (oracle-priced pool model): https://docs.gmx.io/docs/intro/
- Drift (funding, lazy settlement, liquidations): https://docs.drift.trade/
- Hyperliquid (funding rate spec): https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding
- MagicBlock docs: https://docs.magicblock.gg/
- MagicBlock real-time pricing oracle: https://github.com/magicblock-labs/real-time-pricing-oracle
- Pyth Lazer: https://www.pyth.network/blog/introducing-pyth-lazer-launching-defi-into-real-time
