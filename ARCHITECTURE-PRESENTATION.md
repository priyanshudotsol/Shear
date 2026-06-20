# SHEAR — Architecture & MagicBlock Integration (Presentation Brief)

> **One line:** SHEAR is a relative-value (ratio) perpetuals DEX on Solana. You long one asset *against* another — e.g. **long SOL-ETH** — as a single market-neutral position priced off the live ratio `R = price(SOL)/price(ETH)`. It runs on a **MagicBlock Ephemeral Rollup** so the position reprices, re-margins, accrues funding, and gets liquidation-checked **every ~1 ms block, with zero gas** — which is impossible on Solana L1 at ~400 ms slots with a fee per tick.

This document is the source of truth for the presentation: what the product is, the full architecture, exactly where and how MagicBlock is used (delegation, ephemeral rollups, session keys, commit/undelegate, the **crank/cron**, and the real-time oracle), the end-to-end trade lifecycle, and the demo script. It is written from the actual deployed code, not the spec.

- **Deployed program ID (devnet):** `6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi`
- **Market live:** `SOL-ETH`
- **Networks:** Solana devnet (base / L1) + MagicBlock devnet ER (`https://devnet.magicblock.app`)

---

## 1. The product in 30 seconds

Every trader has the instinct *"SOL will outperform ETH."* That is a **relative-value** view — a bet on the *ratio*, not on the market going up or down. Today you must "leg it" — open a long-SOL perp and a short-ETH perp — and babysit two positions, two margins, two liquidation prices. When the market dumps, the long-SOL leg hits *its own* liquidation and gets force-closed while the short-ETH leg runs naked. Your "market-neutral" trade silently becomes a directional bet **against your own thesis**. This is *leg drift*.

**SHEAR makes the ratio itself the instrument.** One market = one pair. One position. One collateral balance. One liquidation price.

- Market price **is** the oracle ratio `R = price(SOL) / price(ETH)`.
- **Long SOL-ETH** profits when SOL outperforms ETH — regardless of overall market direction.
- PnL is exact and path-independent: `uPnL = side × notional × (R_now / R_entry − 1)`.
- Fills at the live oracle ratio against a **shared USDC LP pool** (GMX-v1 style) — no order book, no matching engine, no two-leg drift.
- **Structural bonus:** a ratio mark moves only as much as the two legs move *relative to each other*. A 20% SOL crash when ETH drops 18% moves the ratio ~2%, vs. 20% for a SOL/USD perp. So for the same leverage, ratio perps liquidate **less violently** → less bad debt for the LP pool.

Proven demand: **Pear Protocol** ($4.1M raised, 2025) does pairs trading on top of Hyperliquid (Arbitrum). **There is zero equivalent on Solana.** SHEAR is that, native.

---

## 2. The three-layer architecture (big picture)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  CLIENT  —  Next.js app (shear/frontend), browser + Phantom wallet                 │
│                                                                                    │
│   • Live ratio chart (Pyth Hermes SSE, ~250ms)   • One-click long/short            │
│   • Local SESSION KEY in localStorage (gasless ER signing — no wallet popups)      │
│   • Client liquidation keeper (safety-net, fires crank_liquidate_one)              │
│   • Mirrors the on-chain math (shear-math.ts) to render live PnL / equity / liq    │
└───────────────┬──────────────────────────────────────────────┬─────────────────────┘
                │ wallet-signed (rare: deposit/delegate/withdraw)│ session-key-signed (every trade)
                ▼                                                ▼
┌────────────────────────────────────┐  delegate   ┌──────────────────────────────────────┐
│  BASE LAYER  —  Solana devnet (L1)  │ ──────────► │  EPHEMERAL ROLLUP  —  MagicBlock devnet │
│  Owner: SHEAR Anchor program        │             │  ~1ms blocks · zero gas · 1 validator   │
│                                     │  ◄────────  │                                          │
│  GlobalConfig (params)              │  commit /   │  Market PDA  (longOI, shortOI, funding) │
│  USDC VAULT (real SPL custody) ─────│  undelegate │  LiquidityPool PDA (synthetic USDC)     │
│  LpPosition (LP shares)             │             │  UserBalance PDA (free collateral)      │
│  Faucet (devnet test-USDC mint)     │             │  PositionBook PDA (8 isolated slots)    │
│                                     │             │                                          │
│  deposit / withdraw collateral      │             │  open / close / modify / liquidate      │
│  deposit / withdraw liquidity       │             │  accrue_funding   (crank, every ~1s)    │
│  init / delegate / undelegate       │             │  crank_liquidate_book (crank, ~400ms)   │
│                                     │             │  reads MagicBlock real-time oracle      │
└────────────────────────────────────┘             └──────────────────────────────────────┘
                │                                                ▲
                │                                                │ two Pyth-Lazer feeds, divided on-chain
                ▼                                                │
        Real USDC never leaves L1                 ┌──────────────────────────────────┐
        (vault custody = trust anchor)            │  MagicBlock Real-Time Oracle      │
                                                  │  SOL/USD (200ms) · ETH/USD (50ms) │
                                                  │  PriCems5tHihc6UDXDjzjeawomAwBduW…│
                                                  └──────────────────────────────────┘

  OFF-CHAIN INDEXING (read-only): Next.js API routes + Prisma/Postgres persist trade log,
  candles, and an activity feed by parsing emitted Anchor events from both chains.
```

**The core idea of the split:**
- **Real money (USDC) stays on L1, always.** The program-owned vault holds real SPL USDC and is *never* delegated. This is the security anchor — funds can only move via L1 `deposit/withdraw` instructions.
- **Trading state runs on the ER.** `Market`, `LiquidityPool`, `UserBalance`, `PositionBook` are *delegated* to the ER, where they're updated at ~1 ms with no fees. Balances on the ER are **synthetic** (just `u64`/`i128` numbers); they reconcile to real USDC only when committed back to L1.
- **MagicBlock guarantees** the ER state can always be replayed/settled to L1 (commit + undelegate), so the synthetic numbers are backed by the real vault.

---

## 3. Where SHEAR uses MagicBlock (the 6 primitives)

This is the heart of the presentation. Every MagicBlock primitive is **load-bearing** — remove it and the product breaks.

| # | MagicBlock primitive | Where in SHEAR | Code |
|---|---|---|---|
| 1 | **Delegation** (`#[delegate]`, `delegate_pda`) | Move Market/Pool (session) + UserBalance/PositionBook (per trader) into the ER | `instructions/session.rs` |
| 2 | **Ephemeral Rollup execution** | All trading: `open/close/modify/liquidate/accrue_funding` run on the ER | `instructions/trade.rs`, `funding.rs`, `liquidation.rs` |
| 3 | **Session keys (gasless)** | A browser-local keypair signs every ER trade — no wallet popup per trade | `frontend/lib/session.ts`, `authorize()` in `trade.rs` |
| 4 | **Commit / Undelegate** (`MagicIntentBundleBuilder`) | Settle ER state back to L1 for withdrawals + LP ops | `instructions/session.rs` |
| 5 | **Crank / Cron** (`ScheduleTask`) | Autonomous on-chain keepers: funding (~1s) + liquidation (~400ms) | `funding.rs`, `liquidation.rs` |
| 6 | **Real-time oracle** (`PriceUpdateV2`) | Two feeds (SOL/USD, ETH/USD) divided on-chain into the live ratio | `oracle.rs`, `vendored_pyth.rs` |

### 3.1 Delegation — the L1 ↔ ER boundary

An account starts owned by the SHEAR program on L1. **Delegating** it transfers ownership to MagicBlock's delegation program and "clones" it into the ER, where SHEAR becomes the effective owner and can mutate it at ER speed.

- **Shared accounts** (`Market`, `LiquidityPool`) are delegated **once per session** by an operator (`scripts/session-start.ts`).
- **Per-trader accounts** (`UserBalance`, `PositionBook`) are delegated by the trader when they first trade (`provisionTrader` in `chain-trade.ts`).
- **Critical co-delegation rule:** every account an ER instruction touches must be delegated **to the same validator**. `open_position` touches Market + Pool + UserBalance + PositionBook → all four are pinned to one ER validator (`DelegateConfig.validator`).
- Delegation carries `commit_frequency_ms` (SHEAR uses 30s) so ER state auto-checkpoints to L1 — bounding replay distance if the ER halts.

```rust
// session.rs — delegate a PDA to the ER, pinning one validator
ctx.accounts.delegate_market(&ctx.accounts.payer, &[MARKET_SEED, &symbol],
    DelegateConfig { commit_frequency_ms: 30_000, validator: Some(VALIDATOR) })?;
```

### 3.2 Ephemeral Rollup execution — the "fast" part

Once delegated, the same Anchor instructions run **on the ER** instead of L1. Because the ER is a fast single-sequencer rollup, `open_position` confirms in milliseconds and costs no gas. The program code is identical; only *where* it executes changes. Typed `Account<Market>` still works because the ER runtime makes SHEAR the effective owner of the delegated account.

### 3.3 Session keys — gasless, one-click trading (the CEX feel)

The browser wallet (Phantom) cannot simulate ER transactions (foreign blockhash) and would warn/block on every trade. SHEAR solves this with the canonical MagicBlock session-key pattern:

1. On first trade, the client generates a **local keypair** and stores it in `localStorage` (`session.ts`).
2. In the L1 provisioning tx, the owner calls `set_session_key(sessionPubkey)`, recording it on `UserBalance.session_authority` — **one wallet popup**.
3. The owner transfers a little SOL to the session key so it can pay ER fees.
4. Thereafter **every ER trade is signed by the session key only** — no wallet popups. The program's `authorize()` accepts the registered `session_authority` as a valid signer.

```rust
// trade.rs — authorize: owner OR registered session key OR a SessionTokenV2
if signer == owner { return Ok(()); }
if signer == session_authority && *session_authority != Pubkey::default() { return Ok(()); }
```

This is what makes the demo feel like a CEX: click long → position opens in ~1ms, no popup, no gas.

### 3.4 Commit / Undelegate — settling back to L1

To move real USDC (withdraw collateral, LP deposit/withdraw), the ER state must return to L1. SHEAR uses the current `MagicIntentBundleBuilder` API:

- `commit(&[...])` — push latest ER state to L1, **stay delegated** (checkpoint).
- `commit_and_undelegate(&[...])` — push state **and** return ownership to L1 (end of session / before withdraw).

```rust
// session.rs — settle the trader's accounts back to L1
ctx.accounts.user_balance.exit(&crate::ID)?;   // serialize Anchor account first (REQUIRED)
MagicIntentBundleBuilder::new(payer, magic_context, magic_program)
    .commit_and_undelegate(&[user_balance, position])
    .build_and_invoke()?;
```

The client (`settleTraderToL1`) then **polls L1** until the account is program-owned again before calling `withdraw_collateral`, which transfers real USDC out of the vault.

### 3.5 The Crank / Cron — autonomous on-chain keepers (`ScheduleTask`) ⭐

This is the standout MagicBlock feature for SHEAR. A perpetual exchange needs two recurring jobs that normally require an off-chain bot/keeper (trust + latency + downtime). MagicBlock's **`ScheduleTask`** lets the program schedule **a recurring instruction that the ER runtime fires itself**, forever, with no external infrastructure.

```rust
// The arg struct sent to the Magic program (Magic1111…) via invoke_signed:
ScheduleTaskArgs {
    task_id: i64,
    execution_interval_millis: i64,   // how often the ER re-fires the instruction
    iterations: i64,                  // how many times
    instructions: Vec<Instruction>,   // the FROZEN instruction to re-run each tick
}
```

SHEAR registers **two cranks**:

**(a) Funding crank — `accrue_funding`, every ~1000 ms** (`funding.rs::schedule_funding_crank`, scheduled in `session-start.ts`)
- Touches **only the `Market` PDA** → a perfect crank fit: the embedded instruction `(program=SHEAR, accounts=[Market], data=accrue_funding)` is frozen at schedule time and re-fires every second.
- Uses **skew-based funding**: the heavier-OI side pays the lighter side + pool. Because mark = oracle index, there's no premium to measure — funding just balances the book. No oracle read needed, so the account set never changes.
- Result: **fully keeper-free continuous funding.** Scheduled once at session start with `iterations = 86400` (a day of seconds).

```rust
// funding.rs — build the recurring inner instruction and schedule it
let inner = Instruction { program_id: crate::ID,
    accounts: vec![AccountMeta::new(market.key(), false)],
    data: AccrueFunding {}.data() };
let data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(
    ScheduleTaskArgs { task_id, execution_interval_millis: 1000, iterations: 86400,
                       instructions: vec![inner] }))?;
invoke_signed(&Instruction::new_with_bytes(MAGIC_PROGRAM_ID, &data, …), …)?;
```

**(b) Liquidation crank — `crank_liquidate_book`, every ~400 ms** (`liquidation.rs::schedule_liquidation_crank`, scheduled per-trader on first open)
- One recurring task **per trader book**. Each tick reads the ratio **once**, then sweeps all 8 slots and force-closes any underwater position.
- The crank instruction is **frozen** (MagicBlock has no `UpdateTask`), so the embedded accounts are fixed at schedule time: `[Market, Pool, UserBalance, PositionBook, base_feed, quote_feed]`. A per-trader task keeps that set fixed and valid.
- **Fail-safe, not fail-loud:** on a stale/uncertain oracle it emits `OracleStaleSkipped` and returns `Ok` (skips the tick) rather than reverting. Healthy slots are skipped (`PositionHealthy`). The liquidator reward is routed **back into the pool** (no external liquidator), preserving conservation.
- Scheduled from the client on first `open_position` (`scheduleLiquidationCrankER`, `interval=400ms`, `iterations=200_000`), fire-and-forget.

**Three-tier liquidation defense (important to mention):**
1. **Native ER crank** (`crank_liquidate_book`) — the autonomous on-chain keeper, primary path.
2. **Client keeper** (`use-liquidation-crank.ts`) — the browser watches positions against the 250ms oracle and fires `crank_liquidate_one` the moment one goes unhealthy. Safety net while the tab is open.
3. **Permissionless `liquidate`** — anyone (any searcher/bot) can call it on any underwater position and earn the reward. The always-correct backstop.

All three call into the *same* on-chain engine, which **re-checks health on-chain** and no-ops if the position is actually healthy — so firing early is always safe; the chain is the source of truth.

### 3.6 Real-time oracle — the live ratio

SHEAR reads MagicBlock's **real-time pricing oracle** (Pyth-Lazer feeds), program `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`:

- **Two feeds** (SOL/USD pushes ~200ms, ETH/USD ~50ms), divided **on-chain** into the ratio.
- `oracle.rs::read_ratio` deserializes a vendored `PriceUpdateV2` (we hand-ported ~80 lines to avoid a dependency conflict — see §6), checks staleness on **both** legs, asserts matching exponents, computes a **composite confidence** in bps, and rejects if confidence exceeds the configured gate.
- The `feed_id` is the price account's own pubkey bytes (a MagicBlock-specific detail), and feeds are **bound to the market** via Anchor `address =` constraints so a wrong feed can't be substituted.

```rust
// oracle.rs — single read path for entry, mark, PnL, and liquidation
let pb = base.get_price_no_older_than(&clock, max_age, &base_ai.key().to_bytes())?;
let pq = quote.get_price_no_older_than(&clock, max_age, &quote_ai.key().to_bytes())?;
require!(pb.exponent == pq.exponent, FeedMismatch);
let conf_bps = pb.conf*1e4/pb.price + pq.conf*1e4/pq.price;   // additive (conservative)
require!(conf_bps <= max_conf_bps, OracleUncertain);
let r = compute_ratio(pb.price, pq.price)?;                   // R scaled 1e9
```

The **frontend** separately streams Pyth Hermes over SSE (`pyth.ts`, ~250ms) purely to render the live chart and predict PnL — the on-chain oracle is the settlement truth.

---

## 4. Why this is only possible on MagicBlock (the "fast" argument)

| Capability SHEAR needs | Why | Solana L1 reality | MagicBlock ER |
|---|---|---|---|
| **~1ms blocks / <50ms latency** | A ratio of two volatile assets moves constantly; mark/equity/liq must track live | ~400ms slots → stale ratio, late liquidations | ✅ ~1ms blocks |
| **Zero fees** | Continuous funding accrual + per-block liq checks + free re-margining *are* the product | A fee on every tick kills the strategy | ✅ gasless on the ER |
| **On-chain cron** | Funding index + liquidation sweep must run every block with no keeper | Needs an off-chain bot (trust/latency/downtime) | ✅ `ScheduleTask` |
| **Real-time oracle** | Two fresh feeds divided into a live ratio | Sponsored push feeds update ~1/min | ✅ Pyth-Lazer 50–200ms |
| **Session keys** | One-click gasless open/close = CEX UX | Per-tx wallet popups break the flow | ✅ session keys |

> **The pitch:** a relative-value perp is *defined* by continuous repricing and re-margining. That is exactly the thing only a zero-fee, ~1 ms chain can do. The market-neutrality is the product; **MagicBlock is what makes the product affordable to run.**

---

## 5. End-to-end trade lifecycle (what actually happens on a click)

```
PROVISION (L1, ONE wallet popup — batched via signAllTransactions)
  ├─ fund session key with SOL (ER fees)
  ├─ deposit_collateral        → real USDC → vault; UserBalance.free_collateral += amount
  ├─ init_position             → create PositionBook (8 Closed slots)
  ├─ set_session_key(sessionPk)→ register the browser key as an allowed ER signer
  ├─ delegate_user_balance     → UserBalance → ER
  └─ delegate_position         → PositionBook → ER
        (Market + Pool already delegated by the session operator)

OPEN  (ER, session-key-signed, NO popup, ~1ms)
  open_position(slot, side, collateral, leverage)
    ├─ read_ratio() from the two oracle feeds            (oracle.rs)
    ├─ authorize(signer == owner | session_authority)    (trade.rs)
    ├─ shear_math::engine::open_position(...)            (fee, margin, OI caps, R_entry)
    ├─ move collateral free→locked; bump long/short OI; emit PositionOpened
    └─ also fire-and-forget scheduleLiquidationCrankER() (native keeper for this trader)

LIVE  (no transactions — pure reads + cron)
    ├─ client streams Pyth (250ms) → renders live ratio, PnL, equity, liq-ratio
    ├─ funding crank fires accrue_funding every ~1s      (updates cum_funding)
    ├─ liquidation crank fires crank_liquidate_book ~400ms (sweeps underwater slots)
    └─ client keeper + permissionless liquidate stand by as backstops

CLOSE (ER, session-key-signed)
  close_position(slot)
    ├─ read_ratio(); settle uPnL + funding vs the pool   (engine::close_position)
    └─ settled equity → UserBalance.free_collateral (in the ER); emit PositionClosed

SETTLE + WITHDRAW (ER → L1, wallet-signed for the final withdraw)
  undelegate_trader → commit_and_undelegate(UserBalance, PositionBook)
    → poll L1 until program-owned again
  withdraw_collateral(amount) → real USDC out of the vault → wallet
```

Most of the friction (delegation, settlement) is hidden: the client auto-provisions, batches popups, recovers orphaned/mismatched accounts, and only the rare money-moving steps touch the wallet. Steady-state trading is **pure session-key ER calls** = instant + gasless.

---

## 6. On-chain program internals (Anchor, Path A)

- **Dependency stack (Path A):** `anchor-lang 1.0.2` + `ephemeral-rollups-sdk 0.14.3` + `magicblock-magic-program-api 0.10.1` + `session-keys 3.1.1`. The oracle's `PriceUpdateV2` reader is **vendored** (`vendored_pyth.rs`, ~80 lines) because no `pyth-solana-receiver-sdk` release targets anchor 1.0.x — vendoring removes the conflict entirely while keeping the crank, commit builder, and session keys. **Confirmed: `cargo build-sbf` resolves the full tree.**
- **Thin handlers over a tested math core:** every instruction is a thin wrapper — *read oracle → authorize → load engine structs → call `shear-math::engine` → store back → emit event*. All the money math (PnL, margin, skew funding, liquidation, LP/insurance accounting, fixed-point, conservation) lives in the standalone **`shear-math`** crate, unit-tested offline (30 tests). `engine_glue.rs` converts on-chain accounts ↔ plain engine structs.
- **Accounts** (`state.rs`):
  - `GlobalConfig` — singleton params (L1 only).
  - `Market` — one per pair; carries a **snapshot** of config params so the ER is self-contained (it can't read `GlobalConfig`, which isn't delegated). Holds `long_oi`, `short_oi`, `cum_funding`. L1 → ER.
  - `LiquidityPool` — synthetic USDC counterparty capital + `accrued_fees` + `insurance_fund`. L1 → ER.
  - `UserBalance` — `free_collateral` + `session_authority`. L1 → ER.
  - `PositionBook` — **8 isolated-margin `PositionSlot`s** per (trader, market), each with own side/notional/entry_ratio/collateral/funding-snapshot. Created on L1, then opened/closed repeatedly in the ER (avoids creating accounts inside the ER). L1 → ER.
  - `LpPosition` — LP shares (L1 only). Vault — single program-owned USDC token account, **never delegated** (real custody).
- **Risk controls:** maintenance-margin ratio, gross OI cap, net-utilization cap, taker fee (6 bps), liquidation penalty (1%) split between liquidator/insurance, confidence-widened liquidation band, bad-debt waterfall (insurance fund → socialized to pool). See `MATH.md` / `edge-cases.md`.

---

## 7. Off-chain layer (read-only indexing — no custody, no trust)

- **Live prices:** `pyth.ts` streams Pyth Hermes SSE for the chart and client-side PnL prediction.
- **On-chain reads:** `chain.ts` reads accounts from the **ER first** (fresh, delegated) and falls back to L1; it detects delegation by checking whether the account is still program-owned on L1.
- **Event indexing:** Anchor events (`PositionOpened`, `Liquidated`, `FundingAccrued`, …) are parsed from tx logs on **both** chains (`use-chain-events.ts`) and persisted to **Postgres via Prisma** through Next.js API routes (`/api/trades`, `/api/candles`, `/api/activity`, `/api/events`) for the trade log, candle history, and activity feed. This layer is purely cosmetic/analytical — it never holds funds.

---

## 8. The demo (10-second story)

Split screen, scripted market move where **both** assets fall but by different amounts — SOL −8%, ETH −12%. SOL outperformed ETH, so the ratio `SOL/ETH` rose ~4.5%.

- **Left — the old way (directional):** Long SOL 10x on a normal perp. SOL is down 8%, 10x liquidates on a ~5% adverse move → **LIQUIDATED**. *"You were right that SOL would outperform — and you still got wiped out."*
- **Right — SHEAR:** Long `SOL-ETH` 10x. The ratio rose ~4.5%, so at 10x the position is **+45% on collateral — green through the entire dump.** The −8%/−12% common move cancels; only the *relative* move pays.
- **Bottom ticker:** the live ratio re-ticking every ER block, the funding rate ticking, and a "liquidation engine: checked N ms ago" heartbeat from the crank.
- **Final shot:** directional PnL = −$X (liquidated), SHEAR PnL = +$Y. **Same correct thesis, opposite outcome.**

That single image — *being right about the matchup should pay even when the market is wrong* — is the whole pitch, and every piece of it (live reprice, continuous funding, instant liquidation) is what MagicBlock makes possible.

---

## 9. Status / what's working

- ✅ Anchor program deployed to devnet (`6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi`), `SOL-ETH` market live.
- ✅ Full delegation ↔ commit/undelegate lifecycle; per-account independent delegation.
- ✅ Session-key gasless trading (provision in one popup, then no popups).
- ✅ Two MagicBlock cranks live: funding (~1s) + per-trader liquidation (~400ms), plus client keeper + permissionless backstop.
- ✅ Real-time oracle read (vendored `PriceUpdateV2`), two feeds → on-chain ratio.
- ✅ Real USDC custody on L1 vault + devnet faucet; LP deposit/withdraw with live-session pause/resume.
- ✅ Next.js frontend: live chart, one-click trade, position cards, pool/LP, activity feed, DB-backed trade log.
- ⚠️ **Volatility amplification is 1x (raw ratio):** the deployed program uses the raw ratio; the frontend's `volAmpBps` is set to `10_000` (1x) to match. Enabling 10x amplification (to make ratio moves more visually dramatic) requires a program redeploy with `amp_bps` set on-chain, then bumping the client constant to match.

---

### Appendix: file map for "show me the code" moments

| Concern | File |
|---|---|
| Program entry / instruction list | `programs/shear/src/lib.rs` |
| Account layouts (L1 vs ER) | `programs/shear/src/state.rs` |
| Delegation / commit / undelegate | `programs/shear/src/instructions/session.rs` |
| Open / close / modify trade | `programs/shear/src/instructions/trade.rs` |
| **Funding crank (`ScheduleTask`)** | `programs/shear/src/instructions/funding.rs` |
| **Liquidation crank + permissionless** | `programs/shear/src/instructions/liquidation.rs` |
| Real USDC custody (L1) + faucet | `programs/shear/src/instructions/collateral.rs` |
| Two-feed oracle ratio read | `programs/shear/src/oracle.rs` + `vendored_pyth.rs` |
| Money math (tested offline) | `crates/shear-math/src/engine.rs` |
| Client trade orchestration | `frontend/src/lib/chain-trade.ts` |
| Session keys (browser) | `frontend/src/lib/session.ts` |
| Client liquidation keeper | `frontend/src/lib/use-liquidation-crank.ts` |
| RPC endpoints / feeds / params | `frontend/src/lib/constants.ts` |
| Session bootstrap (delegate + funding crank) | `scripts/session-start.ts` |
</content>
</invoke>
