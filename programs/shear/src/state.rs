//! SHEAR account layouts — the real on-chain state (from `state.md`).
//!
//! NOTE: this is for the FULL program. The walking-skeleton `lib.rs` does not `mod state;`
//! it (so the spike builds standalone). Wire it in when fleshing out the real instructions.
//! The numeric LOGIC that operates on these accounts lives in the `shear-math` crate's
//! `engine` module (plain mirrors of these structs), which is exhaustively unit-tested offline.

use anchor_lang::prelude::*;

// ----------------------------------------------------------------------------- enums

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Default)]
pub enum Side {
    #[default]
    Long,
    Short,
}

impl Side {
    /// The only place the ± mapping lives.
    pub fn sign(self) -> i128 {
        match self {
            Side::Long => 1,
            Side::Short => -1,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Active,
    ReduceOnly,
    Halted,
}

/// Closed is variant 0 so a zero-initialized position slot is "available" (not Open).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Default)]
pub enum PositionStatus {
    #[default]
    Closed,
    Open,
    Liquidated,
}

// ----------------------------------------------------------------------------- accounts

/// Singleton global config. Seeds: `[b"config"]`. L1-only.  (8 + 134 = 142 bytes)
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub oracle_program: Pubkey,
    pub taker_fee_bps: u16,          // default 6
    pub liq_penalty_bps: u16,        // default 100 (1%)
    pub liq_reward_share_bps: u16,   // default 5000 (50%)
    pub insurance_cut_bps: u16,      // default 1000 (10%)
    pub min_collateral: u64,         // default 10_000_000 (10 USDC)
    pub min_position_notional: u64,  // default 50_000_000 (50 USDC)
    pub max_age_sec: u64,            // oracle staleness, default 2
    pub max_ratio_conf_bps: u16,     // default 50
    pub liq_max_conf_bps: u16,       // default 100
    pub paused: bool,
    pub bump: u8,
}

/// One per pair. Self-contained trading params (copied from GlobalConfig at create_market
/// so the ER needs no GlobalConfig read). Seeds: `[b"market", symbol]`. L1 → ER.  (8 + 148 = 156 bytes)
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub symbol: [u8; 16],            // market id seed, e.g. "SOL-ETH"
    pub base_feed: Pubkey,           // BASE/USD oracle account; its bytes ARE the feed_id
    pub quote_feed: Pubkey,          // QUOTE/USD oracle account; its bytes ARE the feed_id
    pub expo: i32,                   // asserted equal on both feeds
    pub max_leverage: u16,           // default 10
    pub mmr_bps: u16,                // maintenance margin, default 500 (5%)
    pub k_funding_bps: u32,          // funding coeff, default 1000 (10%/hr at full skew)
    pub f_max_bps: u32,              // funding cap, default 5 (0.05%/hr)
    pub oi_cap_abs: u64,             // gross OI cap (USDC)
    pub max_net_util_bps: u16,       // default 5000 (50%)
    // --- config snapshot copied from GlobalConfig at create_market so the ER is self-contained
    //     (the ER cannot read GlobalConfig — it isn't delegated). [added during implementation] ---
    pub taker_fee_bps: u16,
    pub liq_penalty_bps: u16,
    pub liq_reward_share_bps: u16,
    pub insurance_cut_bps: u16,
    pub min_collateral: u64,
    pub min_position_notional: u64,
    pub max_age_sec: u64,            // oracle staleness for execution paths
    pub max_ratio_conf_bps: u16,     // composite ratio confidence gate
    pub liq_max_conf_bps: u16,       // refuse liquidation above this confidence
    // --- volatility amplification (relative-value index): R_amp = ref_ratio + amp_bps/1e4 * (R_raw - ref_ratio) ---
    pub ref_ratio: u128,             // R_0 anchor (1e9-scaled); set at create + re-anchorable by admin
    pub amp_bps: u32,                // deviation multiplier (1e4 = 1x identity; e.g. 100_000 = 10x)
    // --- live state ---
    pub long_oi: u64,                // Σ notional long (USDC)
    pub short_oi: u64,               // Σ notional short (USDC)
    pub cum_funding: i128,           // signed cumulative funding index (1e9)
    pub last_funding_ts: i64,
    pub status: MarketStatus,
    pub bump: u8,
}

/// One per market. Synthetic pool accounting (real USDC is in the vault). Seeds: `[b"pool", market]`.
/// Pool risk is gated live by `net_oi` (no stored `reserved`). L1 → ER.  (8 + 73 = 81 bytes)
#[account]
#[derive(InitSpace)]
pub struct LiquidityPool {
    pub market: Pubkey,
    pub total_shares: u128,
    pub pool_usdc: u64,              // synthetic LP balance (counterparty capital)
    pub accrued_fees: u64,           // cumulative fees (already in pool_usdc; metrics only)
    pub insurance_fund: u64,         // bad-debt backstop, fed by insurance_cut_bps of fees
    pub bump: u8,
}

/// One per (LP, pool). Seeds: `[b"lp", owner, pool]`. L1-only.  (8 + 81 = 89 bytes)
#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub shares: u128,
    pub bump: u8,
}

/// One per trader. Free (unlocked) collateral. Seeds: `[b"user", owner]`. L1 → ER.  (8 + 73 = 81 bytes)
#[account]
#[derive(InitSpace)]
pub struct UserBalance {
    pub owner: Pubkey,
    pub free_collateral: u64,        // USDC available for margin / withdrawal
    pub session_authority: Pubkey,   // session-key signer allowed to trade (or = owner)
    pub bump: u8,
}

/// Max concurrent positions a trader can hold per market (the on-chain slot cap).
pub const MAX_POSITIONS: usize = 8;

/// One isolated-margin position. Lives inside a `PositionBook` slot. Each is independent
/// (own side / notional / entry / collateral); they share the trader's free collateral.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default)]
pub struct PositionSlot {
    pub side: Side,
    pub notional: u64,               // N (USDC)
    pub entry_ratio: u128,           // R_e scaled 1e9
    pub collateral: u64,             // C locked (USDC)
    pub entry_cum_funding: i128,     // funding index at open / last settle
    pub opened_ts: i64,
    pub status: PositionStatus,      // Closed slot = available
}

/// One per (trader, market). Holds up to `MAX_POSITIONS` independent positions so a trader can run
/// several longs/shorts at once. Seeds: `[b"position", owner, market]`. L1 → ER.
#[account]
#[derive(InitSpace)]
pub struct PositionBook {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub slots: [PositionSlot; MAX_POSITIONS],
    pub bump: u8,
}

// PDA seeds (single source of truth):
//   GlobalConfig  [b"config"]
//   Market        [b"market", symbol(16)]
//   LiquidityPool [b"pool", market]
//   LpPosition    [b"lp", owner, pool]
//   UserBalance   [b"user", owner]
//   Position      [b"position", owner, market]
//   vault auth    [b"vault_auth"]   (authority of the single program-owned USDC token account)
