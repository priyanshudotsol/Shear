//! Collateral: deposit/withdraw USDC across the L1 boundary (instructions.md §Collateral).
//! Real token::transfer happens only here; trades mutate the synthetic free_collateral.

use crate::constants::*;
use crate::error::ShearError;
use crate::events::{CollateralDeposited, CollateralWithdrawn};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init_if_needed,
        payer = trader,
        space = 8 + UserBalance::INIT_SPACE,
        seeds = [USER_SEED, trader.key().as_ref()],
        bump
    )]
    pub user_balance: Account<'info, UserBalance>,
    #[account(
        mut,
        constraint = trader_usdc.mint == config.usdc_mint @ ShearError::Unauthorized,
        constraint = trader_usdc.owner == trader.key() @ ShearError::Unauthorized
    )]
    pub trader_usdc: Account<'info, TokenAccount>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, ShearError::InsufficientCollateral);
    // move real USDC into the single vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.trader_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        amount,
    )?;
    let ub = &mut ctx.accounts.user_balance;
    if ub.owner == Pubkey::default() {
        ub.owner = ctx.accounts.trader.key();
        ub.session_authority = ctx.accounts.trader.key();
        ub.bump = ctx.bumps.user_balance;
    }
    ub.free_collateral = ub
        .free_collateral
        .checked_add(amount)
        .ok_or(ShearError::MathOverflow)?;
    emit!(CollateralDeposited { owner: ub.owner, amount });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [USER_SEED, trader.key().as_ref()],
        bump = user_balance.bump,
        constraint = user_balance.owner == trader.key() @ ShearError::Unauthorized
    )]
    pub user_balance: Account<'info, UserBalance>,
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: vault authority PDA
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = trader_usdc.mint == config.usdc_mint @ ShearError::Unauthorized,
        constraint = trader_usdc.owner == trader.key() @ ShearError::Unauthorized
    )]
    pub trader_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ----------------------------------------------------------------------------- faucet
// Devnet-only: hand out real, transferable test-USDC of the program's own mint so any wallet
// can deposit / LP / trade and later withdraw real tokens. The mint authority is the `vault_auth`
// PDA (set in setup after seeding), so the program signs the mint. Capped per-wallet to curb spam.
// The recipient's ATA is created client-side (idempotent) and passed in.
#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, address = config.usdc_mint @ ShearError::Unauthorized)]
    pub usdc_mint: Account<'info, Mint>,
    /// CHECK: PDA that owns mint + vault authority.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = recipient_usdc.mint == config.usdc_mint @ ShearError::Unauthorized,
        constraint = recipient_usdc.owner == recipient.key() @ ShearError::Unauthorized
    )]
    pub recipient_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn faucet(ctx: Context<Faucet>) -> Result<()> {
    require!(
        ctx.accounts.recipient_usdc.amount < FAUCET_BALANCE_CAP,
        ShearError::Unauthorized
    );
    let bump = ctx.bumps.vault_auth;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_AUTH_SEED, &[bump]]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.recipient_usdc.to_account_info(),
                authority: ctx.accounts.vault_auth.to_account_info(),
            },
            signer_seeds,
        ),
        FAUCET_MINT_AMOUNT,
    )?;
    Ok(())
}

pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    // Free collateral never includes funds locked in an open position (moved out at open),
    // so withdrawing it is always safe; it only succeeds when UserBalance is undelegated (on L1).
    let ub = &mut ctx.accounts.user_balance;
    require!(amount <= ub.free_collateral, ShearError::InsufficientCollateral);
    ub.free_collateral -= amount; // effect before the external CPI (checks-effects-interactions)

    let bump = ctx.bumps.vault_auth;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_AUTH_SEED, &[bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.trader_usdc.to_account_info(),
                authority: ctx.accounts.vault_auth.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;
    emit!(CollateralWithdrawn { owner: ub.owner, amount });
    Ok(())
}
