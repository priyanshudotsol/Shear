//! Delegation / session boundary (lifecycle.md). Delegate accounts to the ER (same validator),
//! commit periodically, and commit+undelegate to settle back to L1.
//!
//! Position is a PERSISTENT slot: created on L1 (init_position), delegated, then opened/closed
//! in the ER repeatedly — avoids creating accounts inside the ER.

use crate::constants::*;
use crate::error::ShearError;
use crate::events::{DepositClaimed, WithdrawRequested};
use crate::state::*;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

const COMMIT_FREQ_MS: u32 = 30_000;

fn cfg(remaining: &[AccountInfo]) -> DelegateConfig {
    DelegateConfig {
        commit_frequency_ms: COMMIT_FREQ_MS,
        validator: remaining.first().map(|a| a.key()),
    }
}

/// L1: create the persistent PositionBook (all slots Closed/available) for (owner, market).
#[derive(Accounts)]
pub struct InitPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: market pubkey only — used for the book seed and stored on the book. NOT deserialized,
    /// so a trader can create their book even while the market is delegated to the ER (a live
    /// session). `Account<Market>` here would fail on L1 mid-session.
    pub market: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + PositionBook::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub position_book: Account<'info, PositionBook>,
    pub system_program: Program<'info, System>,
}

pub fn init_position(ctx: Context<InitPosition>) -> Result<()> {
    let b = &mut ctx.accounts.position_book;
    b.owner = ctx.accounts.owner.key();
    b.market = ctx.accounts.market.key();
    b.bump = ctx.bumps.position_book;
    // `slots` is zero-initialized by `init` → every slot is Closed (PositionStatus::Closed == 0).
    Ok(())
}

// ---- delegate (admin: market/pool ; trader: user_balance/position) ----

#[delegate]
#[derive(Accounts)]
pub struct DelegateMarket<'info> {
    pub payer: Signer<'info>,
    /// CHECK: delegated PDA
    #[account(mut, del)]
    pub market: AccountInfo<'info>,
}
pub fn delegate_market(ctx: Context<DelegateMarket>, symbol: [u8; 16]) -> Result<()> {
    ctx.accounts
        .delegate_market(&ctx.accounts.payer, &[MARKET_SEED, &symbol], cfg(ctx.remaining_accounts))?;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePool<'info> {
    pub payer: Signer<'info>,
    /// CHECK: market key, for the pool seed
    pub market: AccountInfo<'info>,
    /// CHECK: delegated PDA
    #[account(mut, del)]
    pub pool: AccountInfo<'info>,
}
pub fn delegate_pool(ctx: Context<DelegatePool>) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    ctx.accounts
        .delegate_pool(&ctx.accounts.payer, &[POOL_SEED, market_key.as_ref()], cfg(ctx.remaining_accounts))?;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateUserBalance<'info> {
    pub payer: Signer<'info>,
    /// CHECK: delegated PDA
    #[account(mut, del)]
    pub user_balance: AccountInfo<'info>,
}
pub fn delegate_user_balance(ctx: Context<DelegateUserBalance>) -> Result<()> {
    let owner = ctx.accounts.payer.key();
    ctx.accounts
        .delegate_user_balance(&ctx.accounts.payer, &[USER_SEED, owner.as_ref()], cfg(ctx.remaining_accounts))?;
    Ok(())
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePosition<'info> {
    pub payer: Signer<'info>,
    /// CHECK: market key for the position seed
    pub market: AccountInfo<'info>,
    /// CHECK: delegated PDA
    #[account(mut, del)]
    pub position: AccountInfo<'info>,
}
pub fn delegate_position(ctx: Context<DelegatePosition>) -> Result<()> {
    let owner = ctx.accounts.payer.key();
    let market_key = ctx.accounts.market.key();
    ctx.accounts.delegate_position(
        &ctx.accounts.payer,
        &[POSITION_SEED, owner.as_ref(), market_key.as_ref()],
        cfg(ctx.remaining_accounts),
    )?;
    Ok(())
}

// ---- commit / undelegate the trader's accounts (user_balance + position) ----

#[commit]
#[derive(Accounts)]
pub struct CommitTrader<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub user_balance: Account<'info, UserBalance>,
    #[account(mut)]
    pub position: Box<Account<'info, PositionBook>>,
}

pub fn commit_trader(ctx: Context<CommitTrader>) -> Result<()> {
    ctx.accounts.user_balance.exit(&crate::ID)?;
    ctx.accounts.position.exit(&crate::ID)?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[
        ctx.accounts.user_balance.to_account_info(),
        ctx.accounts.position.to_account_info(),
    ])
    .build_and_invoke()?;
    Ok(())
}

pub fn undelegate_trader(ctx: Context<CommitTrader>) -> Result<()> {
    ctx.accounts.user_balance.exit(&crate::ID)?;
    ctx.accounts.position.exit(&crate::ID)?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[
        ctx.accounts.user_balance.to_account_info(),
        ctx.accounts.position.to_account_info(),
    ])
    .build_and_invoke()?;
    Ok(())
}

// ---- collateral shuttle: move USDC in/out of free_collateral WITHOUT undelegating positions ----
//
// The trading unit (UserBalance + PositionBook) stays continuously delegated. To add or pull
// collateral mid-session we bounce a SEPARATE per-trader `CollateralShuttle` through the ER:
//   L1 deposit_collateral -> delegate_shuttle -> ER claim_deposit / request_withdraw
//      -> undelegate_shuttle -> L1 settle_withdraw.
// `claim_deposit`/`request_withdraw` run on the ER and touch BOTH the (already-delegated) UserBalance
// and the (just-delegated) shuttle, so both must be pinned to the same validator as the market.

#[delegate]
#[derive(Accounts)]
pub struct DelegateShuttle<'info> {
    pub payer: Signer<'info>,
    /// CHECK: delegated PDA
    #[account(mut, del)]
    pub shuttle: AccountInfo<'info>,
}
pub fn delegate_shuttle(ctx: Context<DelegateShuttle>) -> Result<()> {
    let owner = ctx.accounts.payer.key();
    ctx.accounts
        .delegate_shuttle(&ctx.accounts.payer, &[SHUTTLE_SEED, owner.as_ref()], cfg(ctx.remaining_accounts))?;
    Ok(())
}

/// ER context: both accounts are delegated, so the program is their effective owner here.
#[derive(Accounts)]
pub struct ShuttleMove<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [USER_SEED, user_balance.owner.as_ref()], bump = user_balance.bump)]
    pub user_balance: Account<'info, UserBalance>,
    #[account(
        mut,
        seeds = [SHUTTLE_SEED, shuttle.owner.as_ref()],
        bump = shuttle.bump,
        constraint = shuttle.owner == user_balance.owner @ ShearError::Unauthorized
    )]
    pub shuttle: Account<'info, CollateralShuttle>,
}

fn authorize_shuttle(ub: &UserBalance, signer: &Pubkey) -> Result<()> {
    require!(
        *signer == ub.owner || (*signer == ub.session_authority && ub.session_authority != Pubkey::default()),
        ShearError::Unauthorized
    );
    Ok(())
}

/// ER: fold staged deposit into spendable free_collateral.
pub fn claim_deposit(ctx: Context<ShuttleMove>) -> Result<()> {
    authorize_shuttle(&ctx.accounts.user_balance, &ctx.accounts.signer.key())?;
    let amount = ctx.accounts.shuttle.deposit_amt;
    if amount == 0 {
        return Ok(());
    }
    ctx.accounts.user_balance.free_collateral = ctx
        .accounts
        .user_balance
        .free_collateral
        .checked_add(amount)
        .ok_or(ShearError::MathOverflow)?;
    ctx.accounts.shuttle.deposit_amt = 0;
    emit!(DepositClaimed { owner: ctx.accounts.shuttle.owner, amount });
    Ok(())
}

/// ER: debit free_collateral and stage it for payout on L1. Free collateral never includes funds
/// locked in an open position (moved out at open), so withdrawing it is always solvent.
pub fn request_withdraw(ctx: Context<ShuttleMove>, amount: u64) -> Result<()> {
    authorize_shuttle(&ctx.accounts.user_balance, &ctx.accounts.signer.key())?;
    require!(amount > 0, ShearError::InsufficientCollateral);
    require!(amount <= ctx.accounts.user_balance.free_collateral, ShearError::InsufficientCollateral);
    ctx.accounts.user_balance.free_collateral -= amount;
    ctx.accounts.shuttle.withdraw_amt = ctx
        .accounts
        .shuttle
        .withdraw_amt
        .checked_add(amount)
        .ok_or(ShearError::MathOverflow)?;
    emit!(WithdrawRequested { owner: ctx.accounts.shuttle.owner, amount });
    Ok(())
}

/// ER -> L1: commit the shuttle's latest deposit_amt/withdraw_amt and return it to L1 so the trader
/// can `settle_withdraw` (or `deposit_collateral` again). Leaves UserBalance + PositionBook delegated.
#[commit]
#[derive(Accounts)]
pub struct CommitShuttle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub shuttle: Account<'info, CollateralShuttle>,
}
pub fn undelegate_shuttle(ctx: Context<CommitShuttle>) -> Result<()> {
    ctx.accounts.shuttle.exit(&crate::ID)?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.shuttle.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

// ---- commit / undelegate the SHARED accounts (market + pool) back to L1 ----
//
// The shared market+pool are delegated to the ER for trading (open/close mutate the pool).
// LP deposit/withdraw and collateral settlement, however, are L1-only (they move real USDC in
// the vault). Without this path the pool can NEVER return to L1, so liquidity provision is
// permanently bricked while a session is live. `undelegate_shared` ends a trading session and
// returns ownership to L1; `delegate_market`/`delegate_pool` re-open one.
//
// NOTE: permissionless, mirroring `undelegate_trader` (the ER runtime + the pinned validator are
// the real gate). For production, gate on the config admin by storing `admin` on the Market.

#[commit]
#[derive(Accounts)]
pub struct CommitShared<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub pool: Account<'info, LiquidityPool>,
}

/// Checkpoint the shared market+pool to L1 without ending the session.
pub fn commit_shared(ctx: Context<CommitShared>) -> Result<()> {
    ctx.accounts.market.exit(&crate::ID)?;
    ctx.accounts.pool.exit(&crate::ID)?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[
        ctx.accounts.market.to_account_info(),
        ctx.accounts.pool.to_account_info(),
    ])
    .build_and_invoke()?;
    Ok(())
}

/// End the session: commit the latest market+pool state and return ownership to L1 (unblocks LP).
pub fn undelegate_shared(ctx: Context<CommitShared>) -> Result<()> {
    ctx.accounts.market.exit(&crate::ID)?;
    ctx.accounts.pool.exit(&crate::ID)?;
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[
        ctx.accounts.market.to_account_info(),
        ctx.accounts.pool.to_account_info(),
    ])
    .build_and_invoke()?;
    Ok(())
}

// silence unused import in some configurations
#[allow(unused_imports)]
use ShearError as _ShearError;
