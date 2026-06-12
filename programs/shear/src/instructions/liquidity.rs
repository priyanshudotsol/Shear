//! LP liquidity: deposit/withdraw (instructions.md §Liquidity). Session-boundary (pool on L1).
//! Share math + solvency gate come from the tested engine. AUM uses accounted pool_usdc
//! (donation immunity) — never the raw vault token balance.

use crate::constants::*;
use crate::engine_glue as glue;
use crate::error::ShearError;
use crate::events::{LiquidityDeposited, LiquidityWithdrawn};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use shear_math::engine as eng;

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [POOL_SEED, market.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(
        init_if_needed,
        payer = lp,
        space = 8 + LpPosition::INIT_SPACE,
        seeds = [LP_SEED, lp.key().as_ref(), pool.key().as_ref()],
        bump
    )]
    pub lp_position: Account<'info, LpPosition>,
    #[account(
        mut,
        constraint = lp_usdc.mint == config.usdc_mint @ ShearError::Unauthorized,
        constraint = lp_usdc.owner == lp.key() @ ShearError::Unauthorized
    )]
    pub lp_usdc: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_liquidity(ctx: Context<DepositLiquidity>, amount: u64) -> Result<()> {
    require!(amount > 0, ShearError::InsufficientLiquidity);
    // real USDC into the vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.lp_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.lp.to_account_info(),
            },
        ),
        amount,
    )?;

    let pool = &mut ctx.accounts.pool;
    let mut ep = glue::load_pool(pool);
    let aum = ep.pool_usdc; // flat between sessions; accounted, not the raw vault balance
    let shares = eng::lp_deposit(&mut ep, amount, aum).map_err(ShearError::from)?;
    glue::store_pool(pool, &ep);

    let lp = &mut ctx.accounts.lp_position;
    if lp.owner == Pubkey::default() {
        lp.owner = ctx.accounts.lp.key();
        lp.pool = pool.key();
        lp.bump = ctx.bumps.lp_position;
    }
    lp.shares = lp.shares.checked_add(shares).ok_or(ShearError::MathOverflow)?;
    emit!(LiquidityDeposited { lp: lp.owner, amount, shares });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawLiquidity<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [POOL_SEED, market.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(
        mut,
        seeds = [LP_SEED, lp.key().as_ref(), pool.key().as_ref()],
        bump = lp_position.bump,
        constraint = lp_position.owner == lp.key() @ ShearError::Unauthorized
    )]
    pub lp_position: Account<'info, LpPosition>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: vault authority PDA
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = lp_usdc.mint == config.usdc_mint @ ShearError::Unauthorized,
        constraint = lp_usdc.owner == lp.key() @ ShearError::Unauthorized
    )]
    pub lp_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn withdraw_liquidity(ctx: Context<WithdrawLiquidity>, shares: u128) -> Result<()> {
    require!(shares > 0, ShearError::InsufficientLiquidity);
    let lp = &mut ctx.accounts.lp_position;
    require!(shares <= lp.shares, ShearError::InsufficientLiquidity);

    let em = glue::load_market(&ctx.accounts.market);
    let pool = &mut ctx.accounts.pool;
    let mut ep = glue::load_pool(pool);
    let aum = ep.pool_usdc;
    let out = eng::lp_withdraw(&mut ep, &em, shares, aum).map_err(ShearError::from)?;
    glue::store_pool(pool, &ep);
    lp.shares -= shares; // effect before external CPI

    let bump = ctx.bumps.vault_auth;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_AUTH_SEED, &[bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.lp_usdc.to_account_info(),
                authority: ctx.accounts.vault_auth.to_account_info(),
            },
            signer_seeds,
        ),
        out,
    )?;
    emit!(LiquidityWithdrawn { lp: lp.owner, shares, amount: out });
    Ok(())
}
