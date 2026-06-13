# SHEAR — Edge Cases, Security & Invariants

Build defensively from this list. Format: **Risk → Mitigation**. Grounded in real incidents (Mango oracle manip ~$110M Oct-2022; GMX v1 reentrancy $42M Jul-2025; Hyperliquid POPCAT bad debt $4.9M Nov-2025; ERC-4626 inflation attack) and standards (OpenZeppelin virtual shares, Pyth confidence guidance, Anchor/Solana security checklists). Every item maps to a check in `instructions.md`.

## Protocol invariants (assert in tests; some on-chain)

1. **Custody:** `ShearVault.amount == Σ free_collateral + Σ Position.collateral + pool_usdc + insurance_fund` (± fees in transit). The vault always physically covers every claim.
2. **Conservation:** across any open→close/liquidate sequence, `Δ(all trader free_collateral) + Δ(pool_usdc) + Δ(insurance_fund) == 0` except for fees credited to the pool. No value created/destroyed.
3. **Market neutrality:** common price factor `m` on both legs ⇒ `uPnL == 0` exactly (`MATH.md §13.1`).
4. **Solvency:** `|net_oi| <= pool_usdc * MAX_NET_UTIL_BPS/1e4` at all times ⇒ the pool's directional exposure is always covered by its capital.
5. **Funding zero-sum-to-pool:** `Σ funding_owed == −Δ pool funding residual` (`MATH.md §13.4`).
6. **No negative balances:** `free_collateral`, `pool_usdc`, `total_shares` are `u64/u128` and every mutation is `checked_*` — underflow panics rather than wraps.

## 1. LP vault share inflation / first-depositor attack

- **Inflation/donation attack** (ERC-4626): attacker mints 1 share, donates USDC to the pool so `aum ≫ shares`, later deposits round down to 0 shares and are stolen. → **Three-layer defense**: (a) **virtual offset** — compute shares with `aum + 1` and `total_shares + VIRTUAL` (OZ pattern); (b) **MIN_LIQUIDITY** permanently locked on first deposit (Uniswap-style, burned); (c) **protocol seeds the first deposit** so no external LP is ever the first at a manipulable rate.
- **First-depositor monopoly / 0-share mint** → reject any deposit that would mint 0 shares (`SharesRoundToZero`); first deposit requires `amount > MIN_LIQUIDITY`.
- **Donation via direct USDC transfer to the vault** → AUM is computed from **accounted** `pool_usdc`, **not** `ShearVault.amount` (raw token balance). A stray transfer can't move share price. (This also satisfies invariant 1's tolerance.)
- **Rounding** → shares minted round **down**, USDC redeemed rounds **down** (favor the pool).

## 2. Oracle (two-feed ratio R = BASE/QUOTE)

- **Stale price** → `get_price_no_older_than(clock, max_age_sec, feed_id)` on **both** feeds; reject if either is stale (`OracleStale`). Perps need seconds, not minutes.
- **One leg stale, other fresh** (the relative-value trap) → the ratio is only as fresh as the **older** leg; never validate legs independently then combine. Both must pass the same `max_age`.
- **Zero / negative price** → reject `price <= 0` on each leg before dividing (prevents div-by-zero and sign flips).
- **Wide confidence** → reject fills if composite `conf/price > max_ratio_conf_bps` (default 50bps); **refuse liquidation** if `> liq_max_conf_bps` (default 100bps). For the ratio, composite ≈ `conf_b/p_b + conf_q/p_q`.
- **Confidence direction (adverse bound)** → when valuing the user's position against them, use the unfavorable bound: opening a long uses upper bound of BASE / lower bound of QUOTE; valuing a liability uses the opposite (Pyth guidance). v0 may simplify to mid + a confidence *gate*, but document the adverse-bound upgrade.
- **Oracle manipulation** (Mango) → rely on Pyth's aggregate (not one thin venue); cap per-market OI so manipulation can't be monetized; optional mark-vs-TWAP divergence band as a circuit breaker.
- **Exponent mismatch** → assert `expo_base == expo_quote` (stored at `create_market`); reject otherwise (`FeedMismatch`). Apply expo to price **and** conf before combining.
- **Extreme ratio / precision** → compute `R = base * 1e9 / quote` in `u128`, multiply-before-divide, divide last; clamp R to sane `[R_MIN, R_MAX]`; reject if a leg is below a price floor.
- **Feed substitution** → bind `base_price.key() == market.base_feed` (Anchor `address =` constraint); a misrouted feed errors instead of mispricing.

## 3. Fixed-point math

- **Round against the user, always** → fees `ceil`, payouts `floor`, margin requirement `ceil`, funding-owed `ceil` / funding-received `floor`.
- **Divide-before-multiply** → never; always `(a*b)/c` with `u128/i128` intermediates. Critical for `N*(R_t−R_e)/R_e` and `N*R/1e9`.
- **Overflow** → `N` (u64) × `R` (1e9) exceeds u64; use `i128`/`u128` intermediates, `checked_*` everywhere, and set `overflow-checks = true` in `Cargo.toml` (release builds skip checks by default).
- **Signed vs unsigned** → `uPnL`, `funding_owed`, `equity`, `cum_funding` are **`i128`** (can be negative). `free_collateral`, `pool_usdc`, `shares` are unsigned. Never subtract into a `u64` without a checked guard.
- **Funding index precision** → accumulate at 1e9; settle as `(idx_now − idx_entry)*N/1e9`. Truncation per-tick bleeds value — accumulate, don't realize each tick.
- **Dust** → enforce `min_collateral`, `min_position_notional`, and reject ops where fee or shares round to zero.

## 4. Funding manipulation

- **Self-trade to move skew / farm funding** (open long+short across two accounts to tilt skew) → the **taker fee on every fill** makes round-trip self-trading net-negative; this is the primary deterrent. Plus OI caps + funding clamp `f_max` bound the payoff.
- **Wash trading to fake OI** → fees + the fact that funding is based on **net skew of real open OI**, not volume.
- **Same-block funding snapshot gaming** → funding accrues on the crank cadence (decoupled from individual fills); a position opened this instant has `entry_cum_funding == cum_funding` so it owes 0 until the next tick.
- **`accrue_funding` called twice in one slot** → idempotent: `dt = now − last_funding_ts == 0` produces no index change. Safe to over-call.
- **First trade in a brand-new market** → `entry_cum_funding` defaults to the current `cum_funding` at open; **no retroactive funding** for time before the position existed.
- **Open then immediate close, no tick crossed** → `cum_funding` unchanged ⇒ `funding_owed == 0`. Correct; no free funding either way.

## 5. Liquidation

- **Liquidating a healthy position** → recompute `equity < MMR·N` atomically with a fresh, in-confidence oracle read in the same instruction; never trust caller-supplied health.
- **Liquidation on stale/wide-confidence oracle** → **refuse** (`OracleUncertain`) above `liq_max_conf_bps` or if stale. Liquidating on bad data wrongs the trader and creates bad debt (Drift pauses liquidations under oracle error).
- **Bad debt when equity < 0** (gap-through) → liquidate **early** (MMR > 0 gives a buffer); the per-block crank catches positions before they cross zero. The pool collects only the trader's collateral `C` (capped → physical USDC conserved); the shortfall is an automatic `aum`/NAV drop, offset by `insurance_fund` top-up, remainder socialized as lower NAV (**not** a `pool_usdc` burn). No ADL in v0. *(Conservation proven in `shear-math::engine` tests.)*
- **Structural mitigant (a real advantage)** → a ratio mark moves only as much as the two legs move *relative* to each other, so for the same leverage SHEAR liquidations are gentler and bad debt is rarer than on single-asset perps (`concept.md` → "less bad debt").
- **Same price source** → use the **same** `R_t` for the liquidation health check and the settlement PnL (a mismatch makes the judgment false).
- **Dust positions** → `min_position_notional` at open ensures the `liquidator_reward` covers the keeper's cost so positions don't linger as bad debt; below dust, full close only (no partial).
- **Liquidator reward gaming** → reward is a **% of penalty** (capped), not a flat bounty; `require!(liquidator != position.owner)` (`SelfLiquidation`).
- **Racing liquidators / MEV** → bounded reward + (v1) partial liquidation shrink extractable value; under the volatility breaker, liquidation-only mode limits the window.
- **Partial vs full** → v0 is **full close** for simplicity. v1: partial, closing only enough to restore `equity >= MMR·N` (Drift), throttled across slots.

## 6. Position / account (Anchor)

- **Reentrancy / CPI** → checks-effects-interactions: mutate all state **before** any `token::transfer` CPI. Solana blocks indirect reentrancy, but GMX showed cross-program callback abuse — never CPI into an unvalidated program.
- **PDA seed collision** → distinct prefixes per type (`b"market"`, `b"pool"`, `b"position"`, `b"user"`, `b"lp"`, `b"config"`, `b"vault_auth"`) + discriminating keys (owner, market). Always the **canonical** Anchor `bump` (stored), never user-supplied.
- **Account validation** → typed `Account<'info,T>` (owner + discriminator auto-checked); `Signer` for authority; `Program` to pin program ids; `address =`/`constraint =` to bind feeds and pool. **`remaining_accounts` (crank) get no Anchor checks** — validate owner, discriminator, and key relationships manually.
- **Multiple / reused positions** → v0 one Open position per (owner, market); reopening while Open errors. On full close use Anchor `close` (writes closed discriminator, drains rent) so stale data can't be re-read.
- **Closing an already-closed position** → `require!(status == Open)` (`PositionNotOpen`).
- **Session-token abuse** → verify session `authority == owner`, unexpired, and signer == session key; scope to trading instructions only (never withdraw).

## 7. Economic

- **Pool insolvency** → the `|net_oi| <= pool_usdc * MAX_NET_UTIL_BPS/1e4` gate + the gross-OI cap bound the pool's directional exposure to a fraction of its capital. The pool is the only counterparty, so unbounded OI = guaranteed insolvency.
- **Fee rounds to zero** → reject (`FeeRoundsToZero`); enforce `min_position_notional` so a nonzero notional always pays a nonzero fee (else free wash/funding farming).
- **Opening already-liquidatable / leverage at exactly max** → validate `equity >= initial_margin` (initial > maintenance) at open using the adverse bound, and reject if immediately liquidatable post-open (`WouldBeLiquidatable`) — off-by-one at the boundary is a classic audit finding.
- **LP withdraw stranding open positions** → the solvency gate (`|net_oi| <= (pool_usdc − usdc_out) * MAX_NET_UTIL_BPS/1e4`) prevents LPs pulling capital that backs open trades.
- **AUM from raw token balance** → never; AUM uses accounted `pool_usdc`, immune to donation (see §1).

## 8. Pause / circuit breakers

- **Global + per-market pause** → `config.paused` (global kill) and `Market.status` (`Active`/`ReduceOnly`/`Halted`), independently gating opens, fills, and (separately) withdrawals so you can stop new risk without trapping users.
- **Oracle-triggered auto-pause** → on staleness / wide confidence, instructions reject naturally; an admin can flip `Halted`. Liquidations also refuse under oracle error.
- **OI / insolvency breaker** → block new opens when `|net_oi|` approaches the utilization cap or `insurance_fund` falls below a floor.
- **Volatility breaker (v1)** → normal → all orders; high vol → liquidation-only; extreme → reject all — bounds bad debt and the MEV window.

## What v0 deliberately does NOT do (documented gaps, not oversights)

- No partial liquidation (full close only).
- No ADL (insurance fund → LP socialization instead).
- No mid-session LP/collateral deposits (session-boundary only).
- No cross-margin (isolated margin per position).
- Adverse-confidence-bound pricing simplified to mid + confidence gate (upgrade noted in §2).
- These are scope cuts for a weekend, each with a clear v1 path — not hidden risk.
