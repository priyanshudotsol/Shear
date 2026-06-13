# SHEAR Program — Plan

Anchor program with `ephemeral-rollups-sdk`. A relative-value (pairs) perpetual exchange: one synthetic market per asset pair, trades fill at the oracle ratio against a shared USDC LP pool. This file is the **overview**; the build-ready detail lives in: `state.md` (exact account layouts + L1/ER placement), `instructions.md` (per-instruction step logic), `lifecycle.md` (delegation/session/crank flows), `edge-cases.md` (security + invariants), `MATH.md` (all formulas). If this overview and those disagree, **they win**.

## Scope (v0, weekend cut)

- **One market live for demo:** `SOL-ETH` (`R = SOL/USD ÷ ETH/USD`). Code is market-generic; a second market (`SOL-BTC`) is config-only.
- **Single synthetic ratio instrument** — not two legs (see `MATH.md` §8).
- **Oracle-priced fills** against a shared USDC pool — no order book, no matching engine, no price impact.
- **Leverage** up to 10x; long or short.
- **Continuous skew funding** + **per-block crank liquidation** + permissionless `liquidate`.
- **Synthetic USDC collateral** (mock mint) is fine for the demo; real delegated USDC is a stretch.
- Out of scope for v0: limit/stop orders, multi-collateral, cross-margin (positions are isolated-margin), partial liquidation (full close only), protocol fee split.

## Accounts

| Name | Purpose | Where |
|---|---|---|
| `GlobalConfig` | Singleton. Admin, fee/penalty params, funding interval, oracle program id, staleness bounds, paused flag | base |
| `Market` | Per pair. `base_feed`, `quote_feed`, expo binding, `long_oi`, `short_oi`, `cum_funding (i128)`, `last_funding_ts`, params (`max_leverage`, `mmr`, `k_funding`, `f_max`, OI caps), `status` | base + ER |
| `LiquidityPool` | Per market. `total_shares`, `pool_usdc` (synthetic), `accrued_fees`, `insurance_fund`. Pool risk gated live by `net_oi` — no stored `reserved` (see `state.md`) | base + ER |
| `LpPosition` | Per (LP, pool). `shares`, `cost_basis` | base + ER |
| `UserBalance` | Per trader. `free_collateral` (USDC available for margin), bump | base + ER |
| `Position` | Per (trader, market). `side`, `notional`, `entry_ratio (u128)`, `collateral`, `entry_cum_funding (i128)`, `opened_ts`, `status` | base + ER |
| `ShearVault` | Program-owned USDC token account (the actual pool funds + collateral custody) | base |

Isolated margin: one `Position` per (trader, market). Opening a second position in the same market while one is open is rejected in v0 (`PositionExists`) — keeps margin math trivial.

## Enums

- `Side` — `Long` (+1), `Short` (−1).
- `MarketStatus` — `Active`, `ReduceOnly`, `Halted`.
- `PositionStatus` — `Open`, `Closed`, `Liquidated`.

## Instructions

| Name | Layer | Caller | Purpose |
|---|---|---|---|
| `initialize_config` | base | admin | once — set params, oracle program id |
| `create_market` | base | admin | bind two feeds, set market params, init `Market` + `LiquidityPool` |
| `set_market_status` | either | admin | circuit breaker (`Active`/`ReduceOnly`/`Halted`) |
| `deposit_liquidity` | base | LP | USDC → pool, mint shares at NAV |
| `request_withdraw_liquidity` | base/ER | LP | queue withdraw (respects `free_liquidity`) |
| `withdraw_liquidity` | base | LP | burn shares → USDC |
| `deposit_collateral` | base | trader | USDC → `UserBalance.free_collateral` |
| `withdraw_collateral` | base | trader | `free_collateral` → wallet |
| `delegate_session` | base | trader/LP | delegate `UserBalance` + `Position` (+ `Market`) to ER |
| `commit_and_undelegate_session` | ER | trader/LP | settle ER state back to base, end session |
| `open_position` | **ER** | trader | lock collateral, fill at oracle ratio, update OI, snapshot funding |
| `close_position` | **ER** | trader | settle uPnL + funding + fees vs pool, release collateral |
| `add_collateral` / `remove_collateral` | **ER** | trader | adjust isolated margin (remove gated by resulting health) |
| `accrue_funding` | **ER** | crank / anyone | advance `Market.cum_funding` from current skew (see `MATH.md` §7) |
| `liquidate` | **ER** | anyone / crank | if `equity < MMR*N`, force-close, pay penalty split |
| `crank_liquidations` | **ER** | crank task | scan a bounded set of positions, liquidate the underwater ones |

`open_position`, `close_position`, and `liquidate` are the only instructions with non-trivial behavior. Everything else is bookkeeping or session/settlement plumbing.

### `open_position` — control flow

1. Assert `Market.status == Active`, not `Halted`.
2. Read both oracle feeds, compute `R_t` with staleness + confidence guards (`oracle.md`). This is `entry_ratio`.
3. Validate `L <= max_leverage`, `C >= MIN_COLLATERAL`, `C <= UserBalance.free_collateral`.
4. `N = C * L`. Check OI caps (`MATH.md` §6) → else `OICapExceeded`.
5. `open_fee = N * TAKER_FEE / BPS`; debit from `C` (or require extra) → credit `pool.accrued_fees`.
6. Move `C` from `UserBalance.free_collateral` into the `Position`.
7. Write `Position{ side, notional: N, entry_ratio: R_t, collateral: C', entry_cum_funding: Market.cum_funding, opened_ts, Open }`.
8. `Market.long_oi/short_oi += N` on the correct side.
9. Emit `PositionOpened`.

### `close_position` — control flow

1. Read oracle → `R_t` (staleness guard; on stale, reject so user retries, never misprice).
2. `uPnL = s * N * (R_t/R_e − 1)` (`MATH.md` §4).
3. `funding_owed = s * N * (cum_funding_now − entry_cum_funding) / FUNDING_PRECISION` (§7).
4. `close_fee = N * TAKER_FEE / BPS`.
5. `settlement = C + uPnL − funding_owed − close_fee`.
6. Pool side: `pool_usdc −= uPnL` (pool pays profit / receives loss); route `close_fee` (insurance cut to `insurance_fund`, remainder to `pool_usdc`, `accrued_fees += close_fee`); `pool_usdc += funding_owed` (residual folded in).
7. `UserBalance.free_collateral += max(settlement, 0)`; if `settlement < 0` the loss was already capped at `C` (isolated margin) — pool keeps the difference; bad-debt path only via liquidation gap.
8. `Market` OI `−= N`. Mark `Position.status = Closed`. Emit `PositionClosed`.

### `liquidate` — control flow

1. Read oracle → `R_t`; compute `equity` incl. funding/fees.
2. Require `equity < MMR * N` → else `PositionHealthy`.
3. `penalty = N * LIQ_PENALTY / BPS`; `liquidator_reward = penalty * LIQ_REWARD_SHARE`.
4. Settle like `close_position` but route `penalty` per `MATH.md` §10; `trader_gets = max(equity − penalty, 0)`.
5. If `equity < penalty` → `trader_gets = 0`, pool absorbs shortfall (bad debt, bounded). Emit `Liquidated{ bad_debt }`.
6. OI `−= N`; `Position.status = Liquidated`.

## Events

Lifecycle: `MarketCreated`, `MarketStatusChanged`, `LiquidityDeposited`, `LiquidityWithdrawn`, `CollateralDeposited`, `CollateralWithdrawn`.
Trading: `PositionOpened`, `PositionClosed`, `PositionModified`, `Liquidated`, `FundingAccrued{ market, skew, funding_rate, cum_funding }`.
Safety: `OracleStaleSkipped`, `OICapHit`, `BadDebtIncurred`. Fields finalized at emit sites.

## Errors

Grouped: **auth** (`Unauthorized`), **market state** (`MarketHalted`, `ReduceOnly`), **position** (`PositionExists`, `PositionNotOpen`, `PositionHealthy`), **margin** (`LeverageTooHigh`, `BelowMinCollateral`, `InsufficientCollateral`, `WouldBeLiquidatable`), **capacity** (`OICapExceeded`, `InsufficientLiquidity`), **oracle** (`OracleStale`, `OracleUncertain`, `FeedMismatch`), **math** (`MathOverflow`).

Important non-error: a stale/uncertain oracle in `open_position`/`close_position`/`liquidate` **rejects** the action (`OracleStale`/`OracleUncertain`) rather than pricing off a bad ratio. The caller retries on the next tick. No silent mispricing — same discipline as SHIM.

## Core-logic decisions

- **Single ratio instrument, oracle-priced, isolated margin.** The three choices that keep v0 small and the math exact (`MATH.md` §8, §9). No vAMM, no order book, no cross-margin.
- **Lazy funding.** `Market.cum_funding` advances on a crank tick; positions settle funding only when touched (open/close/modify/liquidate) via the entry-snapshot diff. No per-position writes per tick — scales to many positions cheaply (Drift pattern).
- **Permissionless liquidation + crank backstop.** Anyone can call `liquidate` for a reward; the crank (`crank_liquidations`) also sweeps so the demo doesn't depend on an external bot. Zero ER fees make per-block sweeps free.
- **Pool is the counterparty.** Pool earns fees + funding residual + net trader losses; risk = net trader profit, bounded by OI caps + reserve (`MATH.md` §6, §9). Funding actively pushes the book toward balance.
- **Math is a pure module.** All formulas in `src/math.rs`, no Anchor types, fully unit-tested (property tests in `MATH.md` §13) before any instruction is wired.

The pure math module is the only place with real logic. Files: `src/math.rs` (formulas), `src/state.rs` (accounts/enums), `src/instructions/*.rs`, `src/oracle.rs` (two-feed ratio read), `src/error.rs`.

## Open questions

- **Pool: per-market or global?** v0 per-market (simplest accounting). One pool shared across markets is a v1 capital-efficiency upgrade.
- **`add/remove_collateral` in v0?** Nice for the demo (rescue a position live), but `close`+reopen covers it. Ship if time allows.
- **Partial liquidation?** v0 full-close only. Partial is fairer but adds math; defer.
- **Funding params.** `K_FUNDING`/`F_MAX` need tuning so the demo shows visible-but-not-punishing funding. Calibrate against the scripted move.
- **Collateral custody.** Synthetic balance vs real delegated USDC token account — synthetic is the safe demo choice.

## Risks

- **Oracle stall → everything rejects.** Same dependency as SHIM/SLIP. Pre-flight the pusher before any demo; consider a `last_known_ratio` fallback with a wider stale window for *display only* (never for execution).
- **Bad debt on a gap-through.** A violent ratio gap can blow past MMR. Mitigated by conservative MMR (5%), OI caps, and the per-block crank catching positions early. Accept residual for v0.
- **CU budget on `crank_liquidations`.** Scanning many positions per tick can blow compute. Bound the scan to N positions/tick (or a heap of nearest-to-liquidation); profile early.
- **Single-market single-oracle demo** — one feed failure stops the show. Acceptable for the weekend; pre-flight.
- **Precision/overflow** in `N * (R_t − R_e) / R_e` — use `i128`, divide last, property-test the extremes (`MATH.md` §13.7).

## Build order

1. `src/math.rs` — ratio, PnL, margin, funding, liquidation. Pure functions + property tests. **Do this first.**
2. `src/state.rs` — accounts + enums.
3. `src/oracle.rs` — two-feed read → `R_t` with guards.
4. Instructions: `initialize_config` → `create_market` → `deposit_collateral` → `deposit_liquidity` → `open_position` → `close_position` → `liquidate` → `accrue_funding` → crank.
5. Delegation + ER routing in the client (`delegate_session` / `commit_and_undelegate_session`).
6. Wire `ScheduleTask` crank for `accrue_funding` + `crank_liquidations`. Profile CU; bound the scan.
7. Tune funding/OI-cap params against the scripted demo move.
