//! Liquidation (ER): permissionless `liquidate` (primary path) + `crank_liquidate_one`
//! (crank-friendly, fixed embedded accounts, skip-and-retry on stale). instructions.md §Liquidation.

use crate::constants::*;
use crate::engine_glue as glue;
use crate::error::ShearError;
use crate::events::{BadDebtIncurred, Liquidated, OracleStaleSkipped};
use crate::oracle;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
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

/// Book-wide crank (ER): read the ratio ONCE, then liquidate every underwater open slot in a
/// trader's book in a single tick. This is the target of the scheduled MagicBlock liquidation task
/// (one recurring task per trader book). Skip-and-retry on stale oracle; healthy slots are skipped.
/// Liquidator reward is routed back into the pool (no external liquidator) to preserve conservation.
#[derive(Accounts)]
pub struct CrankLiquidateBook<'info> {
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

pub fn crank_liquidate_book(ctx: Context<CrankLiquidateBook>) -> Result<()> {
    // read the ratio once for the whole book; skip the whole tick on a stale/uncertain oracle
    let (r_t, conf_bps) = match oracle::read_ratio(
        &ctx.accounts.base_price,
        &ctx.accounts.quote_price,
        ctx.accounts.market.max_age_sec,
        ctx.accounts.market.liq_max_conf_bps as u64,
    ) {
        Ok(v) => v,
        Err(_) => {
            emit!(OracleStaleSkipped { market: ctx.accounts.market.key() });
            return Ok(());
        }
    };
    let owner = ctx.accounts.position_book.owner;
    let market_key = ctx.accounts.market.key();

    let cfg = glue::cfg(&ctx.accounts.market);
    let mut em = glue::load_market(&ctx.accounts.market);
    let mut ep = glue::load_pool(&ctx.accounts.pool);
    let mut eu = glue::load_user(&ctx.accounts.user_balance);

    for i in 0..MAX_POSITIONS {
        if ctx.accounts.position_book.slots[i].status != PositionStatus::Open {
            continue;
        }
        let conf_buf = oracle::conf_buffer(ctx.accounts.position_book.slots[i].notional, conf_bps);
        let mut epos = glue::load_slot(&ctx.accounts.position_book.slots[i]);
        let mut reward: u64 = 0;
        match eng::liquidate(&cfg, &mut em, &mut ep, &mut eu, &mut reward, &mut epos, r_t, conf_buf, false) {
            Ok(s) => {
                ep.pool_usdc = ep.pool_usdc.saturating_add(reward); // reward back into the pool
                let socialized = if s.bad_debt > 0 { eng::cover_bad_debt(&mut ep, s.bad_debt) } else { 0 };
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
                    slot: i as u8,
                    liquidator: crate::ID,
                    trader_gets: s.trader_gets,
                    liquidator_reward: 0,
                    bad_debt: s.bad_debt,
                });
            }
            Err(EngineError::PositionHealthy) => {} // not underwater this tick — skip
            Err(e) => return Err(ShearError::from(e).into()),
        }
    }

    glue::store_market(&mut ctx.accounts.market, &em);
    glue::store_pool(&mut ctx.accounts.pool, &ep);
    ctx.accounts.user_balance.free_collateral = eu.free_collateral;
    Ok(())
}

/// Schedule a recurring MagicBlock task (on the ER) that calls `crank_liquidate_book` on this
/// trader's accounts every `interval_ms` for `iterations` ticks — a native, infrastructure-free
/// liquidation keeper. Mirrors `schedule_funding_crank`. Send on the ER; payer signs (fee only).
#[derive(Accounts)]
pub struct ScheduleLiquidationCrank<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
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
    /// CHECK: the MagicBlock program (Magic11111111111111111111111111111111111111)
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,
}

pub fn schedule_liquidation_crank(
    ctx: Context<ScheduleLiquidationCrank>,
    task_id: i64,
    interval_ms: i64,
    iterations: i64,
) -> Result<()> {
    // The recurring task invokes crank_liquidate_book with these exact (fixed) accounts.
    let inner = Instruction {
        program_id: crate::ID,
        accounts: vec![
            AccountMeta::new(ctx.accounts.market.key(), false),
            AccountMeta::new(ctx.accounts.pool.key(), false),
            AccountMeta::new(ctx.accounts.user_balance.key(), false),
            AccountMeta::new(ctx.accounts.position_book.key(), false),
            AccountMeta::new_readonly(ctx.accounts.base_price.key(), false),
            AccountMeta::new_readonly(ctx.accounts.quote_price.key(), false),
        ],
        data: anchor_lang::InstructionData::data(&crate::instruction::CrankLiquidateBook {}),
    };
    let data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
        task_id,
        execution_interval_millis: interval_ms,
        iterations,
        instructions: vec![inner],
    }))
    .map_err(|_| error!(ShearError::MathOverflow))?;
    let ix = Instruction::new_with_bytes(
        MAGIC_PROGRAM_ID,
        &data,
        vec![
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new(ctx.accounts.market.key(), false),
            AccountMeta::new(ctx.accounts.pool.key(), false),
            AccountMeta::new(ctx.accounts.user_balance.key(), false),
            AccountMeta::new(ctx.accounts.position_book.key(), false),
            AccountMeta::new_readonly(ctx.accounts.base_price.key(), false),
            AccountMeta::new_readonly(ctx.accounts.quote_price.key(), false),
        ],
    );
    invoke_signed(
        &ix,
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.market.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.user_balance.to_account_info(),
            ctx.accounts.position_book.to_account_info(),
            ctx.accounts.base_price.to_account_info(),
            ctx.accounts.quote_price.to_account_info(),
        ],
        &[],
    )?;
    Ok(())
}
