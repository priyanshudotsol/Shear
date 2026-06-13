# SHEAR — Math & Mechanics

The single source of truth for every formula in the program. `PROGRAM.md` references this; if a number disagrees anywhere, this file wins. All math is integer/fixed-point — no floats on-chain.

## 0. The instrument in one line

A SHEAR market is a **single synthetic perpetual on the ratio** `R = price(BASE) / price(QUOTE)`, both legs priced in USD from the oracle. You go long or short the ratio with USDC collateral and leverage. Long `SOL-ETH` profits when SOL outperforms ETH.

We deliberately do **not** open two real perp legs (that's what Pear does, and the legs drift in notional so the position is only first-order market-neutral). A single ratio instrument gives **exact, path-independent** PnL — see §8.

## 1. Fixed-point conventions

| Quantity | Unit | Type | Scale |
|---|---|---|---|
| USD prices (from oracle) | USD | `i64` + `expo` | Pyth native (`expo` ~ −8) |
| **Ratio** `R` | dimensionless | `u128` | `RATIO_PRECISION = 1e9` |
| Notional `N`, collateral `C`, equity `E` | USDC | `u64` / `i128` (signed for equity) | `USDC = 1e6` (6 decimals) |
| Funding cumulative index | dimensionless rate | `i128` | `FUNDING_PRECISION = 1e9` |
| Rates, ratios (IMR, MMR, fees) | fraction | `u64` | `BPS = 1e4` (1 bp = 0.01%) |
| Side `s` | ±1 | enum `Side` | Long=+1, Short=−1 |

Rules: never divide before multiplying when it loses precision; use `u128`/`i128` intermediates; `checked_*` everywhere; divide last. PnL and equity are **signed** (`i128`); balances are unsigned (`u64`).

## 2. The ratio `R` (computed on-chain from two feeds)

Read two Pyth `PriceUpdateV2` accounts (BASE/USD and QUOTE/USD). Each gives `(price: i64, expo: i32, conf: u64)`. Normalize both to a common scale, then:

```
R = (price_BASE * 10^(expo_BASE)) / (price_QUOTE * 10^(expo_QUOTE))   // conceptual
```

Implemented without floats, producing `R` scaled by `RATIO_PRECISION`:

```
// bring both prices to positive integers at their own expo, then:
R_e9 = (price_BASE as u128 * RATIO_PRECISION * 10^(expo_QUOTE - expo_BASE adjust)) / price_QUOTE
```

In practice both crypto/USD feeds share `expo = -8`, so the `10^Δexpo` term is 1 and:

```
R_e9 = price_BASE * RATIO_PRECISION / price_QUOTE      // u128 math, divide last
```

**Guards (all mandatory — see `oracle.md`):**
- Both feeds fresh: `get_price_no_older_than(clock, MAX_AGE, feed_id)` on **each**; if either is stale → reject with `OracleStale`.
- `price_BASE > 0` and `price_QUOTE > 0`.
- Confidence: relative confidence of the ratio `≈ conf_BASE/price_BASE + conf_QUOTE/price_QUOTE`. If it exceeds `MAX_RATIO_CONF_BPS` → reject with `OracleUncertain`.

## 3. Position sizing, margin, leverage

A position is opened with collateral `C` (USDC) and leverage `L`:

```
N (notional)     = C * L                       // USDC
IMR (initial)    = 1 / L                        // initial margin ratio
```

Constraints at open:
```
L <= market.max_leverage           (default 10  → IMR_min = 10%)
C >= MIN_COLLATERAL                (default 10 USDC)
N <= remaining OI capacity         (§6)
```

Maintenance margin ratio `MMR` is a market parameter, `MMR < IMR_min`:
```
MMR (default)    = 5%   (0.05 == 500 bps)
```

So a 10x position (IMR 10%) is liquidated once equity falls below 5% of notional — a 5% adverse *ratio* move, before funding/fees.

## 4. Unrealized PnL (the core formula)

```
uPnL = s * N * (R_t / R_e − 1)
```

In fixed-point (`R` at 1e9, `N` in USDC base units, result signed USDC):

```
uPnL_usdc = s * (N as i128) * ((R_t as i128) − (R_e as i128)) / (R_e as i128)
```

- `s = +1` (long): profit when `R_t > R_e` (BASE outperformed QUOTE).
- `s = −1` (short): profit when `R_t < R_e`.

Equivalent "units" view (sanity check): define `q = N / R_e` (ratio-units). Then `uPnL = s * q * (R_t − R_e)`. Identical to the above. We store `R_e` and `N`; `q` is implicit.

## 5. Equity, health, and liquidation

```
funding_owed = s * N * (cumFunding_now − cumFunding_entry) / FUNDING_PRECISION    // signed; see §7
equity (E)   = C + uPnL − funding_owed − fees_accrued                              // signed i128
```

Margin ratio of a live position:
```
margin_ratio = E / N
```

**Liquidation condition:**
```
liquidatable  ⇔  E < MMR * N        (i.e. margin_ratio < MMR)
```

**Confidence-widened band (live liquidation only).** To avoid liquidating on oracle noise, the on-chain trigger shrinks the maintenance band by the composed oracle confidence:
```
liquidatable  ⇔  E < MMR * N − conf_buffer,   conf_buffer = conf_mark * N / R_t
```
where `conf_mark = R_t * rel_conf` (`oracle.md`). With a confident mark `conf_buffer ≈ 0` and this reduces to `E < MMR*N`. The displayed `R_liq` below ignores `conf_buffer` (the UI draws a band, not a line).

**Liquidation ratio** (the `R_t` at which `E = MMR*N`, ignoring funding/fees for the displayed estimate). Solve `C + s*N*(R_liq/R_e − 1) = MMR*N`:

```
R_liq = R_e * ( 1 + s * (MMR − C/N) )
      = R_e * ( 1 + s * (MMR − IMR) )      // since C/N = 1/L = IMR at open
```

- Long (`s=+1`): `R_liq = R_e * (1 − (IMR − MMR))` → below entry. e.g. L=10 (IMR 10%), MMR 5% → `R_liq = 0.95 * R_e` (a 5% ratio drop).
- Short (`s=−1`): `R_liq = R_e * (1 + (IMR − MMR))` → above entry.

The frontend shows `R_liq`; the program checks the live `E < MMR*N` condition (which also accounts for accrued funding/fees), not the cached `R_liq`.

## 6. Open interest, pool risk, caps

`Market` tracks `long_oi` and `short_oi` (sum of notionals per side, USDC). The LP pool is the counterparty to the **net** trader position:

```
net_oi      = long_oi − short_oi          // signed; pool is short this
gross_oi    = long_oi + short_oi
```

Caps (protect the pool; see §9). The pool's only directional risk is `net_oi`, so that is the single risk measure — no separate per-position reserve:
```
gross_oi <= OI_CAP_ABS                                (per-market absolute cap)
|net_oi|  <= pool_usdc * MAX_NET_UTIL_BPS / BPS       (default MAX_NET_UTIL = 50%)
```

A new position that would breach either cap is rejected with `OICapExceeded`. Balanced books (long_oi ≈ short_oi) carry almost no pool risk — funding (§7) actively pushes toward balance.

## 7. Funding — skew-based, continuous

Because mark = oracle index here (no order-book premium to measure), we use **skew/imbalance funding**: the heavier side pays the lighter side, which pulls OI back toward balance and compensates the pool for carrying `net_oi`.

```
skew          = (long_oi − short_oi) / max(gross_oi, 1)          // ∈ [−1, +1]
funding_rate  = clamp(K_FUNDING * skew, −F_MAX, +F_MAX)          // per FUNDING_INTERVAL
```

Defaults:
```
FUNDING_INTERVAL = 1 hour
K_FUNDING        = 0.10   (10%/hr at full one-sided skew, pre-clamp)
F_MAX            = 0.05%  per hour cap (== 50 bps/hr)  // tune in testing
```

Sign convention: `funding_rate > 0` ⇔ longs heavier ⇔ **longs pay, shorts receive**.

**Continuous accrual via a cumulative index.** Each crank tick (interval `dt` seconds) advances a per-market signed accumulator:

```
cumFunding += funding_rate * dt / FUNDING_INTERVAL              // i128, FUNDING_PRECISION scaled
```

Lazy per-position settlement (Drift-style — no per-position writes each tick):

```
funding_owed = s * N * (cumFunding_now − position.cumFunding_entry) / FUNDING_PRECISION
```

- Long in a long-heavy market (`s=+1`, `cumFunding` rising): `funding_owed > 0` → reduces equity (you pay).
- Short in that market (`s=−1`): `funding_owed < 0` → increases equity (you receive).
- `position.cumFunding_entry` is snapshotted at open and reset to `cumFunding_now` after each settlement (open/close/modify/liquidate).

**Residual to the pool.** Because `long_oi ≠ short_oi`, payers and receivers don't net to zero; the difference flows to/from the LP pool. This is correct — the pool is paid for carrying `net_oi` risk; the residual is folded into `pool_usdc` at each settlement (no separate accrual field).

## 8. Why a single ratio instrument (not two legs)

Two-leg netting (Pear) with equal notional `N/2` per leg:
```
pnl_2leg = (N/2)*s*(P_BASE,t/P_BASE,e − 1) + (N/2)*(−s)*(P_QUOTE,t/P_QUOTE,e − 1)
```
This is **not** a pure function of `R = P_BASE/P_QUOTE`; the leg notionals drift as prices move, so it's only first-order market-neutral and is path-dependent.

Single ratio instrument:
```
pnl_shear = s * N * (R_t/R_e − 1),  R = P_BASE/P_QUOTE
```
If both legs move by a common factor `(1+m)`: `R_t = R_e` ⇒ `pnl = 0`, **exactly**, for any `m`. Pure, path-independent market neutrality. This is the whole reason SHEAR is its own instrument and not a UI over two perps.

## 9. LP pool accounting (oracle-priced, JLP/GMX-v1 style)

One shared USDC pool is the counterparty to all traders. Trades fill at the oracle ratio — no order book, no price impact. The real USDC lives in `ShearVault` (L1); `pool_usdc` is the synthetic accounting balance.

**Pool value (AUM)** — computed from *accounted* state, never the raw vault token balance (donation immunity, `edge-cases.md §1`):
```
aum = pool_usdc − Σ over open positions ( uPnL_i )      // pool is short traders' net profit
```
Trading fees and funding residual are folded into `pool_usdc` at settlement, so they're already in `aum`.

**Shares — mint on deposit, burn on withdraw** (JLP/GMX, hardened against the inflation attack):
```
first deposit (total_shares == 0):
    require deposit > MIN_LIQUIDITY
    shares = deposit − MIN_LIQUIDITY                 // MIN_LIQUIDITY locked/burned forever
subsequent deposit:
    shares = deposit * total_shares / aum            // round DOWN; reject if shares == 0
withdraw:
    usdc_out = aum * shares_burned / total_shares    // round DOWN
nav_per_share = aum / total_shares
```
Compute the divisions with a **virtual offset** (`aum + 1`, `total_shares + VIRTUAL`) to neutralize the first-depositor inflation attack, and have the **protocol seed the first deposit** (`edge-cases.md §1`).

**Withdrawal solvency gate** — a withdrawal cannot pull capital backing open net exposure:
```
require:  |net_oi| <= (pool_usdc − usdc_out) * MAX_NET_UTIL_BPS / BPS    // else InsufficientLiquidity
```
Between sessions `net_oi == 0`, so withdrawals are unconstrained; during a session it binds.

**Insurance fund** — `insurance_cut_bps` of every fee is routed to `insurance_fund` (not `pool_usdc`). It is the first backstop for liquidation bad debt (§10), before LP socialization.

**Pool revenue:** trading fees (§10) + funding residual (§7) + net trader losses. **Pool risk:** net trader profit, bounded by the OI/util caps in §6.

## 10. Fees

```
TAKER_FEE   = 6 bps of notional, charged on open AND on close      (default 0.0006)
LIQ_PENALTY = 1% of notional                                       (default 0.01)
```

```
open_fee   = N_open  * TAKER_FEE / BPS
close_fee  = N_close * TAKER_FEE / BPS
```
Fees debit the trader's settlement and credit `pool.accrued_fees` (a protocol cut can be split out later; v0 keeps it all in the pool).

**Liquidation payout:**
```
penalty          = N * LIQ_PENALTY / BPS
liquidator_reward = penalty * LIQ_REWARD_SHARE      (default 50%)
pool_gets         = penalty − liquidator_reward + max(remaining_collateral, 0)
trader_gets       = max(E − penalty, 0)             // dust returned; 0 if insolvent
```
If `E < penalty` (gap-through), `trader_gets = 0`. If `E < 0` (underwater past collateral), the shortfall `d = −E` is **bad debt**. Key fact (proven by the engine's conservation tests): a trader can never *physically* lose more than their collateral `C` — settlement is routed so the **pool collects exactly `C`** (capped), so physical USDC is always conserved. But that `C` is less than the marked uPnL the pool was carrying, so **`aum` / LP NAV drops by `d` automatically**. The **insurance fund** (fee-funded) then tops up `pool_usdc` by `min(d, insurance)` to offset the NAV hit; any uncovered remainder is the socialized LP loss — a *lower NAV*, **not** a `pool_usdc` burn. No ADL in v0. Bad debt is bounded by MMR + OI caps + the per-block liquidation crank. *(Implemented + conservation-tested in `shear-math::engine`; see `cover_bad_debt`.)*

## 11. Worked example (the demo trade)

Market `SOL-ETH`. Entry: `P_SOL = $150`, `P_ETH = $3000` → `R_e = 0.05` (`50_000_000` at 1e9).
Trader opens **long**, `C = 100 USDC`, `L = 10` → `N = 1000 USDC`, IMR = 10%, MMR = 5%.

Market dumps: `P_SOL = $138` (−8%), `P_ETH = $2640` (−12%). New ratio `R_t = 138/2640 = 0.05227` (`52_272_727`).

```
ratio return = R_t/R_e − 1 = 0.05227/0.05 − 1 = +4.545%
uPnL = +1 * 1000 * 0.04545 = +$45.45
equity ≈ 100 + 45.45 = $145.45   (+45% on collateral, before tiny funding/fees)
```

A **directional** long-SOL 10x over the same move: SOL −8% → uPnL = `1000 * (−0.08) = −$80` on $100 collateral → equity $20 < MMR·N ($50) → **liquidated**. **Same correct thesis (SOL beats ETH), opposite outcome.** That contrast is the demo. (At a gentler 5x the directional long is −40% — deep red but not yet liquidated; 10x is the degen scenario that wipes out.)

Liquidation ratio for the SHEAR position (long, IMR 10%, MMR 5%):
```
R_liq = R_e * (1 − (0.10 − 0.05)) = 0.05 * 0.95 = 0.0475   // SOL/ETH would need to fall 5% to liquidate
```

## 12. Parameter table (defaults — single source of truth)

| Param | Symbol | Default | Where set |
|---|---|---|---|
| Ratio precision | `RATIO_PRECISION` | `1e9` | const |
| Funding precision | `FUNDING_PRECISION` | `1e9` | const |
| USDC decimals | — | `1e6` | const |
| BPS precision | `BPS` | `1e4` | const |
| Max leverage | `max_leverage` | `10` | Market |
| Maintenance margin | `MMR` | `5%` (500 bps) | Market |
| Min collateral | `MIN_COLLATERAL` | `10 USDC` | GlobalConfig |
| Taker fee | `TAKER_FEE` | `6 bps` | GlobalConfig |
| Liquidation penalty | `LIQ_PENALTY` | `1%` (100 bps) | GlobalConfig |
| Liquidator reward share | `LIQ_REWARD_SHARE` | `50%` | GlobalConfig |
| Funding interval | `FUNDING_INTERVAL` | `1 hour` | GlobalConfig |
| Funding coefficient | `K_FUNDING` | `0.10 /hr` | Market |
| Funding cap | `F_MAX` | `0.05% /hr` | Market |
| Gross OI cap | `OI_CAP_ABS` | per-market | Market |
| Max net utilization | `MAX_NET_UTIL` | `50%` | Market |
| Min position notional | `min_position_notional` | `50 USDC` | GlobalConfig |
| Insurance cut of fees | `insurance_cut_bps` | `10%` | GlobalConfig |
| Oracle max age (exec) | `MAX_AGE` | `2 s` | GlobalConfig |
| Max ratio confidence | `MAX_RATIO_CONF_BPS` | `50 bps` | GlobalConfig |
| Max liq confidence | `liq_max_conf_bps` | `100 bps` | GlobalConfig |
| LP min locked liquidity | `MIN_LIQUIDITY` | `1 USDC-share` | const |

## 13. Property tests (write these before wiring Anchor — `src/math.rs`)

1. **Market neutrality.** For any common factor `m`, `P_BASE,t = P_BASE,e*(1+m)` and `P_QUOTE,t = P_QUOTE,e*(1+m)` ⇒ `uPnL == 0` (exact, within 1 rounding unit).
2. **PnL sign.** Long uPnL > 0 ⇔ `R_t > R_e`; short is the mirror.
3. **Liquidation consistency.** At `R_t = R_liq`, `equity == MMR*N` (within rounding), and `liquidatable` flips exactly there.
4. **Funding conservation.** Net funding settled across all positions == net funding flow into `pool_usdc` (within rounding) — no value created or destroyed.
5. **Pool conservation.** Σ(trader settlements) + pool_usdc delta == 0 across any open/close sequence (no value created/destroyed except fees→pool).
6. **No-float determinism.** Same inputs → identical outputs across runs (integer math only).
7. **Overflow safety.** Max notional × max ratio swing stays within `i128`.
