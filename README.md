# SHEAR — Relative-Value Perpetuals on MagicBlock

> Trade one asset *against* another — long SOL, short ETH, in a single click — as one market-neutral position, repriced continuously on a MagicBlock Ephemeral Rollup.

A pairs / relative-value perpetual exchange for the MagicBlock "Solana Blitz v5" trading hackathon. You take a view on *which asset wins*; the market they're both in cancels out. Proven demand (Pear Protocol, $4.1M) with **zero equivalent on Solana**.

## The one-liner mechanics

- A market is a pair, e.g. `SOL-ETH`, priced by the ratio `R = price(SOL)/price(ETH)`.
- **Long `SOL-ETH`** profits when SOL outperforms ETH — regardless of market direction.
- `uPnL = side × notional × (R_now / R_entry − 1)` — exact, path-independent market-neutrality.
- Oracle-priced fills against a shared USDC LP pool (no order book), continuous skew funding, per-block crank liquidation.

## Spec documents

**Why & what** (read first)
| Doc | What it covers |
|---|---|
| [`concept.md`](./concept.md) | Vision, problem, why-MagicBlock, architecture, demo, why-it-wins, 48h build plan |
| [`naming.md`](./naming.md) | Branding rubric → the name **SHEAR** (fallback SKEW), positioning, sub-brands |

**The spec** (source of truth for building)
| Doc | What it covers |
|---|---|
| [`MATH.md`](./MATH.md) | **Source of truth** — ratio, PnL, margin, skew funding, liquidation, LP/insurance accounting, fixed-point, worked example, property tests |
| [`state.md`](./state.md) | Every account: fields, byte sizes, PDA seeds, L1-vs-ER placement, the token-settlement architecture |
| [`instructions.md`](./instructions.md) | Per-instruction reference — signature, accounts, step logic, checks, errors, events |
| [`PROGRAM.md`](./PROGRAM.md) | Program overview — scope, account/enum/instruction summary, core decisions, build order |
| [`oracle.md`](./oracle.md) | Two-feed ratio read, staleness/confidence guards, code, WS subscription, latency reality |
| [`lifecycle.md`](./lifecycle.md) | L1↔ER delegation, session keys (gasless), crank, deposit/trade/withdraw/liquidation flows |
| [`magicblock-integration.md`](./magicblock-integration.md) | **Verified** map of where SHEAR uses MagicBlock — exact APIs confirmed against the real examples, the dependency-stack decision (Path A/B/C), and the spike-time TODOs |
| [`edge-cases.md`](./edge-cases.md) | Exhaustive edge-case + security checklist + protocol invariants + mitigations |

**Build**
| Doc | What it covers |
|---|---|
| [`build-guide.md`](./build-guide.md) | Pinned deps (Anchor 1.0.2, Path A), repo layout, exact external APIs, build order, deploy, test plan |
| [`components.md`](./components.md) | Build stack by layer, mapped to the real `magicblock-engine-examples/` folders; demo infra |
| [`frontend.md`](./frontend.md) | Screens, data flow, session-key UX, the demo screen |

If any number conflicts between docs, **`MATH.md` wins** (math/economics) and **`state.md`/`instructions.md` win** (on-chain shape).

## Key decisions (finalized)

1. **Single synthetic ratio instrument**, not two real perp legs → exact, path-independent PnL (`MATH.md` §8).
2. **Oracle-priced shared LP pool** (GMX-v1 style), not a vAMM or order book → cleanest math, no matching engine to build.
3. **Skew-based continuous funding** (heavier OI side pays) → mark = oracle index, so there's no premium to measure; funding balances the book and pays the pool.
4. **On-chain crank** (`ScheduleTask`) for funding + liquidation, plus permissionless `liquidate` backstop.
5. **MagicBlock real-time oracle** (two Pyth-Lazer feeds divided on-chain).

## Build order (load-bearing first)

`src/math.rs` + property tests → `state.rs` → `oracle.rs` → instructions (`open`→`close`→`liquidate`→`accrue_funding`) → delegation/ER routing → crank → param tuning → frontend → demo.

## The demo in one sentence

Long `SOL-ETH` 10x; the market dumps (SOL −8%, ETH −12%); a directional long-SOL 10x gets liquidated while SHEAR is up ~45% on collateral, because being right about the matchup pays even when the market is wrong.

## Status

Spec / planning phase. Target: Solana devnet + MagicBlock devnet ER. No mainnet for the hackathon.
