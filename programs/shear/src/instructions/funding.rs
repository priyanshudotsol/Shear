//! Funding (ER): accrue_funding (crank-scheduled) + the crank registration (instructions.md §Funding).
//! Skew-based; no oracle. accrue_funding touches only Market, so it's a clean crank (single fixed acct).

use crate::constants::*;
use crate::engine_glue as glue;
use crate::error::ShearError;
use crate::events::FundingAccrued;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
use shear_math::engine as eng;

#[derive(Accounts)]
pub struct AccrueFunding<'info> {
    // No signer — the crank invokes this with only [market].
    #[account(mut)]
    pub market: Account<'info, Market>,
}

pub fn accrue_funding(ctx: Context<AccrueFunding>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    let mut em = glue::load_market(m);
    eng::accrue_funding(&mut em, now).map_err(ShearError::from)?;
    glue::store_market(m, &em);
    emit!(FundingAccrued {
        market: m.key(),
        skew: shear_math::skew(m.long_oi, m.short_oi),
        funding_rate: shear_math::funding_rate(shear_math::skew(m.long_oi, m.short_oi), m.k_funding_bps, m.f_max_bps),
        cum_funding: m.cum_funding,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ScheduleFundingCrank<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// CHECK: the MagicBlock program (Magic11111111111111111111111111111111111111)
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,
}

pub fn schedule_funding_crank(
    ctx: Context<ScheduleFundingCrank>,
    task_id: i64,
    interval_ms: i64,
    iterations: i64,
) -> Result<()> {
    let inner = Instruction {
        program_id: crate::ID,
        accounts: vec![AccountMeta::new(ctx.accounts.market.key(), false)],
        data: anchor_lang::InstructionData::data(&crate::instruction::AccrueFunding {}),
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
        ],
    );
    invoke_signed(
        &ix,
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.market.to_account_info(),
        ],
        &[],
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelCrank<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: MagicBlock program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,
    /// CHECK: the task context account (see crank-counter)
    #[account(mut)]
    pub task_context: AccountInfo<'info>,
}

pub fn cancel_crank(ctx: Context<CancelCrank>, task_id: i64) -> Result<()> {
    let data = bincode::serialize(&MagicBlockInstruction::CancelTask { task_id })
        .map_err(|_| error!(ShearError::MathOverflow))?;
    let ix = Instruction::new_with_bytes(
        MAGIC_PROGRAM_ID,
        &data,
        vec![
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new(ctx.accounts.task_context.key(), false),
        ],
    );
    invoke_signed(
        &ix,
        &[
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.task_context.to_account_info(),
        ],
        &[],
    )?;
    Ok(())
}
