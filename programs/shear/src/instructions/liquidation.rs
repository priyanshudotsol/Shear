//! Liquidation (ER): permissionless `liquidate` (primary path) + `crank_liquidate_one`
//! (crank-friendly, fixed embedded accounts, skip-and-retry on stale). instructions.md §Liquidation.

use crate::constants::*;
use crate::engine_glue as glue;
use crate::error::ShearError;
use crate::events::{BadDebtIncurred, Liquidated, OracleStaleSkipped};
use crate::oracle;
use crate::state::*;
use anchor_lang::prelude::*;
use shear_math::engine::{self as eng, EngineError};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [POOL_SEED, market.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, LiquidityPool>,
    /// the position owner's balance (receives any dust returned)
    #[account(mut, seeds = [USER_SEED, position_book.owner.as_ref()], bump = user_balance.bump,
              constraint = user_balance.owner == position_book.owner @ ShearError::Unauthorized)]
    pub user_balance: Account<'info, UserBalance>,
    /// the liquidator's balance (receives the reward)
    #[account(mut, seeds = [USER_SEED, liquidator.key().as_ref()], bump = liquidator_balance.bump,
              constraint = liquidator_balance.owner == liquidator.key() @ ShearError::Unauthorized)]
    pub liquidator_balance: Account<'info, UserBalance>,
    #[account(mut, seeds = [POSITION_SEED, position_book.owner.as_ref(), market.key().as_ref()], bump = position_book.bump)]
    pub position_book: Box<Account<'info, PositionBook>>,
    /// CHECK: BASE feed bound to market
    #[account(address = market.base_feed @ ShearError::FeedMismatch)]
    pub base_price: AccountInfo<'info>,
    /// CHECK: QUOTE feed bound to market
    #[account(address = market.quote_feed @ ShearError::FeedMismatch)]
    pub quote_price: AccountInfo<'info>,
}

pub fn liquidate(ctx: Context<Liquidate>, slot: u8) -> Result<()> {
    let i = slot as usize;
    require!(i < MAX_POSITIONS, ShearError::InvalidSlot);
    require!(ctx.accounts.position_book.slots[i].status == PositionStatus::Open, ShearError::PositionNotOpen);

    // allow up to liq_max_conf_bps confidence, then widen the maintenance band by it
    let (r_t, conf_bps) = oracle::read_ratio(
        &ctx.accounts.base_price,
        &ctx.accounts.quote_price,
        ctx.accounts.market.max_age_sec,
        ctx.accounts.market.liq_max_conf_bps as u64,
        ctx.accounts.market.ref_ratio,
        ctx.accounts.market.amp_bps,
    )?;
    let owner = ctx.accounts.position_book.owner;
    let market_key = ctx.accounts.market.key();
    let conf_buf = oracle::conf_buffer(ctx.accounts.position_book.slots[i].notional, conf_bps);
    let is_self = ctx.accounts.liquidator.key() == owner;

    let cfg = glue::cfg(&ctx.accounts.market);
    let mut em = glue::load_market(&ctx.accounts.market);
    let mut ep = glue::load_pool(&ctx.accounts.pool);
    let mut eu = glue::load_user(&ctx.accounts.user_balance);
    let mut epos = glue::load_slot(&ctx.accounts.position_book.slots[i]);
    let mut liq_bal = ctx.accounts.liquidator_balance.free_collateral;

    let s = eng::liquidate(&cfg, &mut em, &mut ep, &mut eu, &mut liq_bal, &mut epos, r_t, conf_buf, is_self)
        .map_err(ShearError::from)?;
    let socialized = if s.bad_debt > 0 { eng::cover_bad_debt(&mut ep, s.bad_debt) } else { 0 };

    glue::store_market(&mut ctx.accounts.market, &em);
    glue::store_pool(&mut ctx.accounts.pool, &ep);
    ctx.accounts.user_balance.free_collateral = eu.free_collateral;
    ctx.accounts.liquidator_balance.free_collateral = liq_bal;
    glue::store_slot(&mut ctx.accounts.position_book.slots[i], &epos);

    if s.bad_debt > 0 {
        emit!(BadDebtIncurred {
            market: market_key,
            amount: s.bad_debt,
            from_insurance: s.bad_debt - socialized,
            socialized,
        });
    }
    emit!(Liquidated {
        owner,
        market: market_key,
        slot,
        liquidator: ctx.accounts.liquidator.key(),
        trader_gets: s.trader_gets,
        liquidator_reward: s.liquidator_reward,
        bad_debt: s.bad_debt,
    });
    Ok(())
}

/// Crank path: liquidate a specific slot in a trader's book. Skip-and-retry on stale oracle; skip if
/// healthy. The liquidator reward is routed back into the pool (no external liquidator).
#[derive(Accounts)]
pub struct CrankLiquidateOne<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [POOL_SEED, market.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(mut, seeds = [USER_SEED, position_book.owner.as_ref()], bump = user_balance.bump,
              constraint = user_balance.owner == position_book.owner @ ShearError::Unauthorized)]
    pub user_balance: Account<'info, UserBalance>,
    #[account(mut, seeds = [POSITION_SEED, position_book.owner.as_ref(), market.key().as_ref()], bump = position_book.bump)]
    pub position_book: Box<Account<'info, PositionBook>>,
    /// CHECK: BASE feed bound to market
    #[account(address = market.base_feed @ ShearError::FeedMismatch)]
    pub base_price: AccountInfo<'info>,
    /// CHECK: QUOTE feed bound to market
    #[account(address = market.quote_feed @ ShearError::FeedMismatch)]
    pub quote_price: AccountInfo<'info>,
}

pub fn crank_liquidate_one(ctx: Context<CrankLiquidateOne>, slot: u8) -> Result<()> {
    let i = slot as usize;
    if i >= MAX_POSITIONS || ctx.accounts.position_book.slots[i].status != PositionStatus::Open {
        return Ok(());
    }
    // skip-and-retry on stale/uncertain oracle (fail-safe, not fail-loud)
    let (r_t, conf_bps) = match oracle::read_ratio(
        &ctx.accounts.base_price,
        &ctx.accounts.quote_price,
        ctx.accounts.market.max_age_sec,
        ctx.accounts.market.liq_max_conf_bps as u64,
        ctx.accounts.market.ref_ratio,
        ctx.accounts.market.amp_bps,
    ) {
        Ok(v) => v,
        Err(_) => {
            emit!(OracleStaleSkipped { market: ctx.accounts.market.key() });
            return Ok(());
        }
    };
    let owner = ctx.accounts.position_book.owner;
    let market_key = ctx.accounts.market.key();
    let conf_buf = oracle::conf_buffer(ctx.accounts.position_book.slots[i].notional, conf_bps);

    let cfg = glue::cfg(&ctx.accounts.market);
    let mut em = glue::load_market(&ctx.accounts.market);
    let mut ep = glue::load_pool(&ctx.accounts.pool);
    let mut eu = glue::load_user(&ctx.accounts.user_balance);
    let mut epos = glue::load_slot(&ctx.accounts.position_book.slots[i]);
    let mut reward: u64 = 0;

    match eng::liquidate(&cfg, &mut em, &mut ep, &mut eu, &mut reward, &mut epos, r_t, conf_buf, false) {
        Ok(s) => {
            // route the reward back into the pool (no external liquidator) — keeps conservation
            ep.pool_usdc = ep.pool_usdc.saturating_add(reward);
            let socialized = if s.bad_debt > 0 { eng::cover_bad_debt(&mut ep, s.bad_debt) } else { 0 };
            glue::store_market(&mut ctx.accounts.market, &em);
            glue::store_pool(&mut ctx.accounts.pool, &ep);
            ctx.accounts.user_balance.free_collateral = eu.free_collateral;
            glue::store_slot(&mut ctx.accounts.position_book.slots[i], &epos);
            if s.bad_debt > 0 {
                emit!(BadDebtIncurred {
                    market: market_key,
                    amount: s.bad_debt,
                    from_insurance: s.bad_debt - socialized,
                    socialized,
                });
            }
            emit!(Liquidated {
                owner,
                market: market_key,
                slot,
                liquidator: crate::ID,
                trader_gets: s.trader_gets,
                liquidator_reward: 0,
                bad_debt: s.bad_debt,
            });
            Ok(())
        }
        Err(EngineError::PositionHealthy) => Ok(()), // not underwater this tick — skip
        Err(e) => Err(ShearError::from(e).into()),
    }
}
