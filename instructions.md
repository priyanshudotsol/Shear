# SHEAR — Instruction Reference

Build-ready per-instruction spec: signature, accounts, args, step-by-step logic with the exact checks, errors, and events. Math symbols are defined in `MATH.md`; account fields in `state.md`. **Rounding rule (everywhere): round in favor of the pool / against the user** — fees up, payouts down, margin requirements up. All arithmetic `checked_*` on `i128`/`u128` intermediates.

Layer legend: **[L1]** runs on base Solana, **[ER]** runs in the Ephemeral Rollup.

---

## Admin & setup

### `initialize_config` [L1]
`fn initialize_config(ctx, params: ConfigParams)` — admin only, once.
Accounts: `admin: Signer`, `config: init PDA[b"config"]`, `usdc_mint`, `oracle_program`, `system_program`.
Logic: write all params from `state.md §1`. Emit `ConfigInitialized`.

### `create_market` [L1]
`fn create_market(ctx, symbol: [u8;16], cfg: MarketParams)` — admin only.
Accounts: `admin: Signer`, `config`, `market: init PDA[b"market", symbol]`, `pool: init PDA[b"pool", market]`, `base_feed`, `quote_feed`, `system_program`.
Logic:
1. Require `admin == config.admin`.
2. Read both feeds once; require `expo_base == expo_quote` → else `FeedMismatch`; store `expo`.
3. Store `base_feed`/`quote_feed` pubkeys. (Their bytes ARE the `feed_id` for the oracle read — no separate hex feed-id is stored; `magicblock-integration.md §5`.)
4. Init `Market` (OI=0, cum_funding=0, last_funding_ts=now, status=Active) and `LiquidityPool` (shares=0, pool_usdc=0).
5. Emit `MarketCreated`.

### `set_market_status` [L1/ER]
`fn set_market_status(ctx, status: MarketStatus)` — admin. Sets `Active`/`ReduceOnly`/`Halted`. Emit `MarketStatusChanged`. (Circuit breaker — see `edge-cases.md §8`.)

---

## Liquidity (LP side) — all [L1]

### `deposit_liquidity` [L1]
`fn deposit_liquidity(ctx, amount: u64)`
Accounts: `lp: Signer`, `config`, `market`, `pool`, `lp_position: init_if_needed PDA[b"lp", lp, pool]`, `lp_usdc_ata`, `vault` (token), `vault_auth`, `token_program`, `system_program`.
Pre: `pool` must be **undelegated** (LP ops are session-boundary; see `lifecycle.md`).
Logic:
1. `require!(amount > 0)`.
2. Compute AUM = `pool_usdc` (no open-position uPnL at L1 settle time; positions are flat between sessions in v0, or uPnL is read if pool carries it — see note). 
3. **Shares minted** (virtual-offset, `edge-cases.md §1`):
   - If `total_shares == 0`: `shares = amount − MIN_LIQUIDITY`; mint `MIN_LIQUIDITY` to a burn address (locked forever); require `amount > MIN_LIQUIDITY`.
   - Else: `shares = amount * total_shares / aum` (round **down**).
4. `token::transfer` `amount` USDC: `lp_usdc_ata → vault`.
5. `pool.pool_usdc += amount`; `pool.total_shares += shares`; `lp_position.shares += shares`.
6. Emit `LiquidityDeposited{ lp, amount, shares }`.

### `request_withdraw_liquidity` / `withdraw_liquidity` [L1]
`fn withdraw_liquidity(ctx, shares: u64)`
Logic:
1. `require!(shares <= lp_position.shares)`.
2. `aum = pool_usdc` (between sessions). `usdc_out = aum * shares / total_shares` (round **down**).
3. **Solvency gate** (`MATH.md §9`, reads `net_oi` from `market`): `require!(|net_oi| <= (pool_usdc − usdc_out) * max_net_util_bps/1e4)` → else `InsufficientLiquidity`. Between sessions `net_oi == 0`, so unconstrained.
4. Burn shares: `pool.total_shares -= shares`; `lp_position.shares -= shares`; `pool.pool_usdc -= usdc_out`.
5. `token::transfer` `usdc_out`: `vault → lp_usdc_ata` (signed by `vault_auth`).
6. Emit `LiquidityWithdrawn`.

> v0 simplification: LP deposit/withdraw require the pool **not** delegated (done before a session starts / after it commits). Mid-session LP flows are a v1 feature (needs the pool committed then re-delegated). Documented in `lifecycle.md`.

---

## Collateral (trader side) — [L1]

### `deposit_collateral` [L1]
`fn deposit_collateral(ctx, amount: u64)`
Accounts: `trader: Signer`, `config`, `user_balance: init_if_needed PDA[b"user", trader]`, `trader_usdc_ata`, `vault`, `vault_auth`, `token_program`, `system_program`.
Pre: `user_balance` undelegated.
Logic: `require!(amount > 0)`; `token::transfer amount` `trader_usdc_ata → vault`; `user_balance.free_collateral += amount`. Emit `CollateralDeposited`.

### `withdraw_collateral` [L1]
`fn withdraw_collateral(ctx, amount: u64)`
Pre: `user_balance` undelegated (committed from ER). No open `Position` may reference locked collateral (positions must be closed or their collateral is not in `free_collateral`).
Logic: `require!(amount <= user_balance.free_collateral)`; `user_balance.free_collateral -= amount`; `token::transfer amount` `vault → trader_usdc_ata` (signed by `vault_auth`). Emit `CollateralWithdrawn`.

---

## Session / delegation — see `lifecycle.md` for full flow

### `delegate_user` [L1]
Delegates `user_balance` (and is also used to delegate a fresh `position` PDA region) to the ER. Uses `ctx.accounts.delegate_pda(&payer, &[seeds], DelegateConfig{ commit_frequency_ms, validator })`. After this the account is owned by the delegation program and mutated in the ER.

### `delegate_market` / `delegate_pool` [L1]
Admin/keeper delegates the shared `Market` + `LiquidityPool` at session start.

### `commit_and_undelegate_user` [ER]
`#[commit]` context. Commits `user_balance` (+ closed `position`) state to L1 and returns ownership, so `withdraw_collateral` can run. Uses `commit_and_undelegate_accounts` (or `MagicIntentBundleBuilder::commit_and_undelegate`).

---

## Trading core — all [ER]

### `open_position` [ER]
`fn open_position(ctx, side: Side, collateral: u64, leverage: u16)`
Accounts: `trader_or_session: Signer`, `market`(UncheckedAccount, delegated), `pool`(delegated), `user_balance`(delegated), `position: init PDA[b"position", owner, market]`, `base_price`, `quote_price`. Session: optional `session_token`.
Logic:
1. Authorize: signer is `user_balance.owner` **or** a valid `session_token` whose authority == owner (manual check, `lifecycle.md §sessions`).
2. `require!(market.status == Active)` → else `MarketHalted`/`ReduceOnly`.
3. `require!(position` not already Open`)` → else `PositionExists`.
4. **Oracle**: `R_t = read_ratio(base_price, quote_price, …)` with staleness (`max_age_sec` on **both**), positivity, and confidence (`max_ratio_conf_bps`) guards (`oracle.md`). Price against the user using the **adverse** confidence bound (`edge-cases.md §2`).
5. Validate inputs: `leverage in 1..=market.max_leverage` → `LeverageTooHigh`; `collateral >= config.min_collateral` → `BelowMinCollateral`.
6. `N = collateral * leverage`; `require!(N >= config.min_position_notional)` → `DustPosition`.
7. **Fee — charged on top of margin, from free collateral** (so locked margin equals `collateral` exactly and leverage is exactly `leverage`): `open_fee = ceil(N * taker_fee_bps / 1e4)`; `require!(open_fee > 0)` → `FeeRoundsToZero`. `require!(user_balance.free_collateral >= collateral + open_fee)` → `InsufficientCollateral`.
8. **OI / solvency cap** (`MATH.md §6`): compute post-trade `long_oi`/`short_oi`; `require!(gross_oi <= oi_cap_abs)` and `|net_oi| <= pool_usdc * max_net_util_bps/1e4` → `OICapExceeded`. Single net-OI gate — there is no separate per-position reserve.
9. **Effect (state before any further CPI)**:
    - `user_balance.free_collateral -= (collateral + open_fee)`.
    - Write `Position{ side, notional: N, entry_ratio: R_t, collateral, entry_cum_funding: market.cum_funding, opened_ts: now, Open }` — full `collateral` locked.
    - `market.long_oi/short_oi += N`.
    - Route the fee: `insurance_fund += open_fee * insurance_cut_bps/1e4`; `pool_usdc += remainder`; `accrued_fees += open_fee`.
10. **Post-open guard**: compute equity at `R_t` (using the adverse confidence bound). At open `equity ≈ collateral = N/leverage = initial margin`; `require!(equity >= mmr_bps/1e4 * N)` → `WouldBeLiquidatable` (catches over-leverage when the adverse bound makes entry uPnL slightly negative).
11. Emit `PositionOpened{ owner, market, side, N, entry_ratio, collateral }`.

### `close_position` [ER]
`fn close_position(ctx)` — full close (v0 has no partial close by the user).
Accounts: like open + `position`(Open).
Logic:
1. Authorize (owner or session).
2. `require!(position.status == Open)` → `PositionNotOpen`.
3. **Oracle** → `R_t` (same guards; on stale/uncertain → reject, never misprice).
4. `uPnL = side_sign * N * (R_t − R_e) / R_e` (i128, `MATH.md §4`).
5. `funding_owed = side_sign * N * (market.cum_funding − entry_cum_funding) / 1e9` (round user's owed **up**).
6. `close_fee = ceil(N * taker_fee_bps / 1e4)`.
7. `settlement = collateral + uPnL − funding_owed − close_fee` (i128).
8. **Pool effect**: `pool_usdc -= uPnL` (pays profit / receives loss — uPnL signed); route `close_fee` (`insurance_fund += close_fee*insurance_cut_bps/1e4`, `pool_usdc += remainder`, `accrued_fees += close_fee`); `pool_usdc += funding_owed` (residual). Clamp so `pool_usdc` can't underflow (if it would, that's bad debt → insurance/socialize, see `liquidate`).
9. **Trader effect**: `user_balance.free_collateral += max(settlement, 0)`.
10. `market.long_oi/short_oi -= N`; `position.status = Closed`; `close` the account (reclaim rent) **after** commit, or mark Closed and close on undelegate.
11. Emit `PositionClosed{ owner, uPnL, funding_owed, settlement }`.

### `add_collateral` / `remove_collateral` [ER] (optional v0)
`add_collateral(amount)`: move `amount` from `free_collateral` into `position.collateral` (lowers effective leverage). `remove_collateral(amount)`: reverse, but `require!` resulting `equity >= initial_margin at current R_t` → `WouldBeLiquidatable`. Emit `PositionModified`.

---

## Funding — [ER]

### `accrue_funding` [ER] (crank or permissionless)
`fn accrue_funding(ctx)`
Accounts: `market`(delegated). (No oracle needed — funding is skew-based.)
Logic (`MATH.md §7`):
1. `dt = now − market.last_funding_ts`; if `dt == 0` return.
2. `gross = long_oi + short_oi`; if `gross == 0` { `last_funding_ts = now`; return }.
3. `skew = (long_oi − short_oi) * 1e9 / gross` (i128, ∈ [−1e9, 1e9]).
4. `rate = clamp(k_funding_bps/1e4 * skew, −f_max, +f_max)` per `FUNDING_INTERVAL`.
5. `market.cum_funding += rate * dt / FUNDING_INTERVAL` (i128, 1e9-scaled).
6. `market.last_funding_ts = now`. Emit `FundingAccrued{ skew, rate, cum_funding }`.

Registered as a `ScheduleTask` (every ~1s). Cheap: one account write, no oracle.

---

## Liquidation — [ER]

### `liquidate` [ER] (permissionless)
`fn liquidate(ctx)`
Accounts: `liquidator: Signer`, `market`, `pool`, `user_balance`(of position owner), `position`(Open), `base_price`, `quote_price`.
Logic:
1. **Oracle** → `R_t` with guards; **refuse if confidence > `liq_max_conf_bps` or stale** → `OracleUncertain` (never liquidate on bad data, `edge-cases.md §5`).
2. Compute `equity` at `R_t` incl. funding + fees, and `conf_mark = R_t × rel_conf` (`oracle.md`).
3. **Confidence-widened trigger**: `require!(equity < mmr_bps/1e4 * N − conf_mark_buffer)` → else `PositionHealthy`, where `conf_mark_buffer = conf_mark × N / R_t` shrinks the maintenance band when the composed mark is noisy — so a marginally-underwater position isn't liquidated on oracle noise. (With a confident mark the buffer ≈ 0 and this reduces to `equity < MMR·N`.)
4. `penalty = N * liq_penalty_bps / 1e4`; `liquidator_reward = penalty * liq_reward_share_bps/1e4`.
5. Settle vs pool like `close_position` using `R_t`.
6. `trader_gets = max(equity − penalty, 0)` → `user_balance.free_collateral += trader_gets`.
7. `liquidator` paid `liquidator_reward` (to their `free_collateral` or ATA); `pool.pool_usdc += penalty − liquidator_reward`.
8. **Bad debt**: the pool collects exactly `C` (capped — a trader never loses more than collateral), so physical USDC is conserved; if `equity < 0` the shortfall `d = -equity` is an automatic `aum`/NAV drop. Top up `pool_usdc` from `insurance_fund` by `min(d, insurance)`; the uncovered remainder is the socialized LP loss (lower NAV, not a `pool_usdc` burn). Emit `BadDebtIncurred{ d, from_insurance, socialized }`.
9. `market` OI `-= N`; `position.status = Liquidated`.
10. `require!(liquidator != position.owner)` → `SelfLiquidation`. Emit `Liquidated`.

### `crank_liquidations` [ER] (scheduled)
`fn crank_liquidations(ctx)` — bounded scan.
Accounts: `market`, `pool`, oracle feeds, and **up to K** `(position, user_balance)` pairs in `remaining_accounts` (validate each manually — `remaining_accounts` get no Anchor checks). **On stale/uncertain oracle it skips-and-retries** (emit `OracleStaleSkipped`, no liquidations this tick, return `Ok`) rather than failing the crank — fail-safe, not fail-loud (`oracle.md`). For each underwater position, run the `liquidate` body; skip healthy ones. K chosen to fit the ER per-tx CU budget (profile; start K=5–10). Registered as a `ScheduleTask` (~100ms–1s).

**Limitation (verified — `magicblock-integration.md §4`):** a scheduled task's embedded instruction has a **frozen account list** (no `UpdateTask`), so the crank can only sweep a **fixed, bounded** set of positions declared at schedule time; to cover a *changing* set, `CancelTask { task_id }` + re-`ScheduleTask`. Therefore the **primary** liquidation path is **permissionless `liquidate`** (a thin keeper / any searcher calls it per-underwater-position — cheap at zero ER fees); the crank is a fixed-set backstop. (Contrast: `accrue_funding` touches only `Market`, a single fixed account, so it's a clean crank with no such limitation.)

---

## Events

`ConfigInitialized`, `MarketCreated`, `MarketStatusChanged`, `LiquidityDeposited`, `LiquidityWithdrawn`, `CollateralDeposited`, `CollateralWithdrawn`, `PositionOpened`, `PositionClosed`, `PositionModified`, `FundingAccrued`, `Liquidated`, `BadDebtIncurred`, `OracleStaleSkipped`.

## Errors (`ShearError`)

`Unauthorized`, `MarketHalted`, `ReduceOnly`, `PositionExists`, `PositionNotOpen`, `PositionHealthy`, `SelfLiquidation`, `LeverageTooHigh`, `BelowMinCollateral`, `InsufficientCollateral`, `DustPosition`, `FeeRoundsToZero`, `WouldBeLiquidatable`, `OICapExceeded`, `InsufficientLiquidity`, `CloseAllFirst`, `OracleStale`, `OracleUncertain`, `FeedMismatch`, `MathOverflow`.

Discipline: a stale/uncertain oracle **rejects** the priced action (open/close/liquidate) — never prices off a bad ratio. Caller retries next tick.
