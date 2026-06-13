# SHEAR — State / Account Layouts

Every on-chain account: fields, types, byte size, PDA seeds, and where it lives (L1 vs delegated to the ER). Sizes use Anchor's `#[derive(InitSpace)]` rules (`space = 8 discriminator + INIT_SPACE`). Type sizes: `bool/u8 = 1`, `u16 = 2`, `u32/i32 = 4`, `u64/i64 = 8`, `u128/i128 = 16`, `Pubkey = 32`, `enum = 1 + largest variant`, `[u8;32] = 32`.

## Where state lives (the L1 ↔ ER split)

The single most important architecture decision (from the MagicBlock token-settlement research):

- **Real USDC never enters the ER.** All deposited USDC (LP + trader collateral) sits in **one L1-resident token account** (`ShearVault`). The ER only ever mutates **synthetic `u64`/`i128` balances** in delegated PDAs. Value is conserved because every payout is bounded by the vault's physical balance (LP deposits + trader collateral).
- **Shared accounts** (`Market`, `LiquidityPool`) are delegated to the ER once (by admin/keeper at session start) and stay delegated for the whole trading session.
- **Per-user accounts** (`UserBalance`, `Position`) are delegated by the user when they start trading and committed+undelegated when they withdraw.
- **L1-only accounts** (`GlobalConfig`, `LpPosition`, `ShearVault`) are never delegated.

| Account | Lives | Delegated to ER? | Mutated in ER? |
|---|---|---|---|
| `GlobalConfig` | L1 | No | No (params copied into `Market`) |
| `ShearVault` (token acct) | L1 | No | No (real USDC custody) |
| `Market` | L1 → ER | Yes (session) | Yes (OI, funding) |
| `LiquidityPool` | L1 → ER | Yes (session) | Yes (pool_usdc, fees) |
| `LpPosition` | L1 | No | No (LP ops are L1) |
| `UserBalance` | L1 → ER | Yes (per user) | Yes (free collateral) |
| `Position` | L1 → ER | Yes (per user) | Yes (the trade) |

> Delegated PDAs change owner to the delegation program while delegated. In handlers that run in the ER, the delegated account is taken as `UncheckedAccount` and manually deserialized (Anchor would otherwise re-serialize stale data) — see `lifecycle.md`.

## Enums

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Side { Long, Short }            // Long => +1, Short => -1 ; size 1

pub enum MarketStatus { Active, ReduceOnly, Halted }   // size 1
pub enum PositionStatus { Open, Closed, Liquidated }   // size 1
```

`side_sign(side) -> i128 { Long => 1, Short => -1 }` is the only place the ± mapping lives.

## 1. `GlobalConfig` (L1, singleton)

Admin + global params. Seeds: `[b"config"]`.

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `admin` | Pubkey | 32 | multisig in prod |
| `usdc_mint` | Pubkey | 32 | collateral mint |
| `oracle_program` | Pubkey | 32 | MagicBlock ephemeral-oracle program id |
| `taker_fee_bps` | u16 | 2 | default 6 |
| `liq_penalty_bps` | u16 | 2 | default 100 (1%) |
| `liq_reward_share_bps` | u16 | 2 | default 5000 (50%) |
| `insurance_cut_bps` | u16 | 2 | share of fees → insurance fund, default 1000 (10%) |
| `min_collateral` | u64 | 8 | default 10_000_000 (10 USDC) |
| `min_position_notional` | u64 | 8 | dust floor, default 50_000_000 (50 USDC) |
| `max_age_sec` | u64 | 8 | oracle staleness, default 2 |
| `max_ratio_conf_bps` | u16 | 2 | default 50 |
| `liq_max_conf_bps` | u16 | 2 | refuse liquidation above this, default 100 |
| `paused` | bool | 1 | global kill switch |
| `bump` | u8 | 1 | |

INIT_SPACE = 32·3 + 2·6 + 8·3 + 1 + 1 = **134**; account = 8 + 134 = **142 bytes**.

## 2. `Market` (L1 → ER, one per pair)

Self-contained trading params (copied from `GlobalConfig` at `create_market` so the ER needs no `GlobalConfig` read). Seeds: `[b"market", symbol]` where `symbol` is a fixed `[u8;16]` (e.g. `"SOL-ETH"`).

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `symbol` | [u8;16] | 16 | market id seed |
| `base_feed` | Pubkey | 32 | BASE/USD oracle account (its bytes ARE the `feed_id` — `magicblock-integration.md §5`) |
| `quote_feed` | Pubkey | 32 | QUOTE/USD oracle account (its bytes ARE the `feed_id`) |
| `expo` | i32 | 4 | asserted equal on both feeds |
| `max_leverage` | u16 | 2 | default 10 |
| `mmr_bps` | u16 | 2 | maintenance margin, default 500 (5%) |
| `k_funding_bps` | u32 | 4 | funding coeff, default 1000 (10%/hr at full skew) |
| `f_max_bps` | u32 | 4 | funding cap, default 5 (0.05%/hr) |
| `oi_cap_abs` | u64 | 8 | gross OI cap (USDC) |
| `max_net_util_bps` | u16 | 2 | default 5000 (50%) |
| `long_oi` | u64 | 8 | Σ notional long (USDC) |
| `short_oi` | u64 | 8 | Σ notional short (USDC) |
| `cum_funding` | i128 | 16 | signed cumulative funding index (1e9) |
| `last_funding_ts` | i64 | 8 | last accrual time |
| `status` | MarketStatus | 1 | Active/ReduceOnly/Halted |
| `bump` | u8 | 1 | |

INIT_SPACE = 16 + 32·2 + 4 + 2·2 + 4·2 + 8 + 2 + 8·2 + 16 + 8 + 1 + 1 = **148**; account = **156 bytes**. (Two `[u8;32]` feed-id fields dropped — feed_id = the feed account's pubkey bytes.)

## 3. `LiquidityPool` (L1 → ER, one per market)

Synthetic pool accounting. The real USDC is in `ShearVault`. Seeds: `[b"pool", market]`.

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `market` | Pubkey | 32 | |
| `total_shares` | u128 | 16 | LP shares outstanding |
| `pool_usdc` | u64 | 8 | synthetic LP balance (counterparty capital) |
| `accrued_fees` | u64 | 8 | cumulative trading fees (already in pool_usdc; tracked for metrics) |
| `insurance_fund` | u64 | 8 | bad-debt backstop, fed by `insurance_cut_bps` of fees |
| `bump` | u8 | 1 | |

INIT_SPACE = 32 + 16 + 8·3 + 1 = **73**; account = 8 + 73 = **81 bytes**.

There is **no stored `reserved` field** — the pool's directional risk is `net_oi` (read from `Market`), and both the open-gate and withdraw-gate are computed live as `|net_oi| <= pool_usdc * MAX_NET_UTIL_BPS / BPS` (`MATH.md §6, §9`). `MIN_LIQUIDITY` (a constant, e.g. 1 USDC-share) is permanently locked on the first deposit (`edge-cases.md §1`) — not a stored field.

## 4. `LpPosition` (L1, one per LP per pool)

Seeds: `[b"lp", owner, pool]`. Only touched on L1 LP deposit/withdraw.

| Field | Type | Bytes |
|---|---|---|
| `owner` | Pubkey | 32 |
| `pool` | Pubkey | 32 |
| `shares` | u128 | 16 |
| `bump` | u8 | 1 |

INIT_SPACE = **81**; account = **89 bytes**.

## 5. `UserBalance` (L1 → ER, one per trader)

Free (unlocked) collateral. Seeds: `[b"user", owner]`.

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `owner` | Pubkey | 32 | |
| `free_collateral` | u64 | 8 | USDC available for margin / withdrawal |
| `session_authority` | Pubkey | 32 | session-key signer allowed to trade (or default = owner) |
| `bump` | u8 | 1 | |

INIT_SPACE = **73**; account = **81 bytes**.

## 6. `Position` (L1 → ER, one per trader per market in v0)

Seeds: `[b"position", owner, market]`. v0 = one open position per (owner, market); re-opening while `Open` errors (`PositionExists`). On full close the account is closed (`close` constraint) so the seed is reusable next time.

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `owner` | Pubkey | 32 | |
| `market` | Pubkey | 32 | |
| `side` | Side | 1 | |
| `notional` | u64 | 8 | N (USDC) |
| `entry_ratio` | u128 | 16 | R_e scaled 1e9 |
| `collateral` | u64 | 8 | C locked (USDC) |
| `entry_cum_funding` | i128 | 16 | funding index at open/last-settle |
| `opened_ts` | i64 | 8 | |
| `status` | PositionStatus | 1 | |
| `bump` | u8 | 1 | |

INIT_SPACE = 32·2 + 1 + 8 + 16 + 8 + 16 + 8 + 1 + 1 = **123**; account = **131 bytes**.

## 7. `ShearVault` (L1, the real USDC custody)

Not a custom struct — a single SPL token account (USDC) whose authority is a PDA `[b"vault_auth"]`. Holds **all** physical USDC: LP deposits + trader collateral. Every real token transfer (`deposit_collateral`, `withdraw_collateral`, `deposit_liquidity`, `withdraw_liquidity`) moves USDC in/out of this one account via `token::transfer` CPI signed by the vault-authority PDA. Synthetic accounting (`pool_usdc`, `free_collateral`) decides who owns what.

**Invariant:** `vault.amount == Σ free_collateral + Σ position.collateral + pool_usdc + insurance_fund` (within fees in transit). See `edge-cases.md` Invariants.

## Account-count budget (per trade tx in the ER)

`open_position` touches: `Market`, `LiquidityPool`, `UserBalance`, `Position`, `base_price`, `quote_price`, signer (+ session token) ≈ 8 accounts — well within limits. Liquidation crank scans positions in bounded batches (see `instructions.md` `crank_liquidations`).

## PDA seed summary

| Account | Seeds |
|---|---|
| `GlobalConfig` | `[b"config"]` |
| `Market` | `[b"market", symbol(16)]` |
| `LiquidityPool` | `[b"pool", market]` |
| `LpPosition` | `[b"lp", owner, pool]` |
| `UserBalance` | `[b"user", owner]` |
| `Position` | `[b"position", owner, market]` |
| vault authority | `[b"vault_auth"]` |

All bumps are canonical (Anchor `bump` constraint, stored in-account, never user-supplied).
