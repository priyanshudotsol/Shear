//! SHEAR — relative-value (ratio) perpetuals on MagicBlock Ephemeral Rollups.
//!
//! Architecture: every handler is a THIN WRAPPER over the tested `shear_math::engine`
//! (read oracle -> authorize -> load engine structs -> call engine -> store back -> emit).
//! The math/accounting/conservation lives in `shear-math` (offline unit-tested, 30 tests).
//! Build: Path A (anchor 1.0.2 + ephemeral-rollups-sdk 0.14.3); see SPIKE.md / magicblock-integration.md §0.
//!
//! Spike note: the old walking-skeleton lib.rs is preserved at `_spike_reference.rs.txt`.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod engine_glue;
pub mod error;
pub mod events;
pub mod instructions;
pub mod oracle;
pub mod state;
pub mod vendored_pyth;

// Module names for qualified handler calls (e.g. `admin::initialize_config`).
use instructions::{admin, collateral, funding, liquidation, liquidity, session, trade};
// Re-export each instruction module's Accounts structs + generated __client_accounts_* modules
// to the crate root so the #[program] macro resolves them (Context types below are unqualified).
pub use instructions::{
    admin::*, collateral::*, funding::*, liquidation::*, liquidity::*, session::*, trade::*,
};
use state::{MarketStatus, Side};

declare_id!("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");

#[ephemeral]
#[program]
pub mod shear {
    use super::*;

    // ---- admin (L1) ----
    pub fn initialize_config(ctx: Context<InitializeConfig>, p: admin::InitConfigParams) -> Result<()> {
        admin::initialize_config(ctx, p)
    }
    pub fn create_market(ctx: Context<CreateMarket>, p: admin::CreateMarketParams) -> Result<()> {
        admin::create_market(ctx, p)
    }
    pub fn set_market_status(ctx: Context<SetMarketStatus>, status: MarketStatus) -> Result<()> {
        admin::set_market_status(ctx, status)
    }
    pub fn set_market_risk(ctx: Context<SetMarketStatus>, p: admin::MarketRiskParams) -> Result<()> {
        admin::set_market_risk(ctx, p)
    }
    pub fn set_market_vol(ctx: Context<SetMarketStatus>, ref_ratio: u128, amp_bps: u32) -> Result<()> {
        admin::set_market_vol(ctx, ref_ratio, amp_bps)
    }
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        admin::set_paused(ctx, paused)
    }

    // ---- collateral (L1) ----
    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        collateral::deposit_collateral(ctx, amount)
    }
    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        collateral::withdraw_collateral(ctx, amount)
    }
    pub fn faucet(ctx: Context<Faucet>) -> Result<()> {
        collateral::faucet(ctx)
    }

    // ---- liquidity (L1, session-boundary) ----
    pub fn deposit_liquidity(ctx: Context<DepositLiquidity>, amount: u64) -> Result<()> {
        liquidity::deposit_liquidity(ctx, amount)
    }
    pub fn withdraw_liquidity(ctx: Context<WithdrawLiquidity>, shares: u128) -> Result<()> {
        liquidity::withdraw_liquidity(ctx, shares)
    }

    // ---- delegation / session boundary ----
    pub fn init_position(ctx: Context<InitPosition>) -> Result<()> {
        session::init_position(ctx)
    }
    pub fn delegate_market(ctx: Context<DelegateMarket>, symbol: [u8; 16]) -> Result<()> {
        session::delegate_market(ctx, symbol)
    }
    pub fn delegate_pool(ctx: Context<DelegatePool>) -> Result<()> {
        session::delegate_pool(ctx)
    }
    pub fn delegate_user_balance(ctx: Context<DelegateUserBalance>) -> Result<()> {
        session::delegate_user_balance(ctx)
    }
    pub fn delegate_position(ctx: Context<DelegatePosition>) -> Result<()> {
        session::delegate_position(ctx)
    }
    pub fn commit_trader(ctx: Context<CommitTrader>) -> Result<()> {
        session::commit_trader(ctx)
    }
    pub fn undelegate_trader(ctx: Context<CommitTrader>) -> Result<()> {
        session::undelegate_trader(ctx)
    }
    pub fn undelegate_user(ctx: Context<CommitUser>) -> Result<()> {
        session::undelegate_user(ctx)
    }
    pub fn commit_shared(ctx: Context<CommitShared>) -> Result<()> {
        session::commit_shared(ctx)
    }
    pub fn undelegate_shared(ctx: Context<CommitShared>) -> Result<()> {
        session::undelegate_shared(ctx)
    }

    // ---- trading (ER) ----
    pub fn open_position(ctx: Context<Trade>, slot: u8, side: Side, collateral: u64, leverage: u16) -> Result<()> {
        trade::open_position(ctx, slot, side, collateral, leverage)
    }
    pub fn close_position(ctx: Context<Trade>, slot: u8) -> Result<()> {
        trade::close_position(ctx, slot)
    }
    pub fn add_collateral(ctx: Context<ModifyCollateral>, slot: u8, amount: u64) -> Result<()> {
        trade::add_collateral(ctx, slot, amount)
    }
    pub fn set_session_key(ctx: Context<SetSessionKey>, session_key: Pubkey) -> Result<()> {
        trade::set_session_key(ctx, session_key)
    }
    pub fn remove_collateral(ctx: Context<ModifyCollateral>, slot: u8, amount: u64) -> Result<()> {
        trade::remove_collateral(ctx, slot, amount)
    }

    // ---- funding + crank (ER) ----
    pub fn accrue_funding(ctx: Context<AccrueFunding>) -> Result<()> {
        funding::accrue_funding(ctx)
    }
    pub fn schedule_funding_crank(ctx: Context<ScheduleFundingCrank>, task_id: i64, interval_ms: i64, iterations: i64) -> Result<()> {
        funding::schedule_funding_crank(ctx, task_id, interval_ms, iterations)
    }
    pub fn cancel_crank(ctx: Context<CancelCrank>, task_id: i64) -> Result<()> {
        funding::cancel_crank(ctx, task_id)
    }

    // ---- liquidation (ER) ----
    pub fn liquidate(ctx: Context<Liquidate>, slot: u8) -> Result<()> {
        liquidation::liquidate(ctx, slot)
    }
    pub fn crank_liquidate_one(ctx: Context<CrankLiquidateOne>, slot: u8) -> Result<()> {
        liquidation::crank_liquidate_one(ctx, slot)
    }
}
