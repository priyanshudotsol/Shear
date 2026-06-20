//! Collateral: move real USDC across the L1 boundary via a per-trader staging shuttle.
//!
//! Real `token::transfer` happens ONLY in this file. Trades on the ER mutate the synthetic
//! `free_collateral`. The shuttle (`CollateralShuttle`) lets a trader deposit/withdraw WITHOUT
//! undelegating their live trading accounts (UserBalance + PositionBook):
//!
//!   deposit (L1):  USDC -> vault,            shuttle.deposit_amt  += amount   (shuttle on L1)
//!   claim   (ER):  free_collateral += d,     shuttle.deposit_amt   = 0        (session.rs)
//!   request (ER):  free_collateral -= a,     shuttle.withdraw_amt += a        (session.rs)
//!   settle  (L1):  vault -> trader,          shuttle.withdraw_amt  = 0
//!
//! Invariant (see state.rs): vault == Σ free_collateral + Σ position.collateral + pool_usdc
//!   + insurance_fund + Σ shuttle.deposit_amt + Σ shuttle.withdraw_amt.

use crate::constants::*;
use crate::error::ShearError;
use crate::events::{CollateralDeposited, CollateralWithdrawn};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

// ----------------------------------------------------------------------------- init user balance
// Create the trader's UserBalance ONCE, on L1, before delegation. Kept separate from deposit so
// deposits keep working after UserBalance is delegated to the ER (Anchor cannot take a delegated
// account as a writable `Account<UserBalance>` on L1).
#[derive(Accounts)]
pub struct InitUserBalance<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(
        init,
        payer = trader,
        space = 8 + UserBalance::INIT_SPACE,
        seeds = [USER_SEED, trader.key().as_ref()],
        bump
    )]
    pub user_balance: Account<'info, UserBalance>,
    pub system_program: Program<'info, System>,
}

pub fn init_user_balance(ctx: Context<InitUserBalance>) -> Result<()> {
    let ub = &mut ctx.accounts.user_balance;
    ub.owner = ctx.accounts.trader.key();
    ub.session_authority = ctx.accounts.trader.key(); // self until a session key is registered
    ub.free_collateral = 0; // credited on the ER via claim_deposit
    ub.bump = ctx.bumps.user_balance;
    Ok(())
}

// ----------------------------------------------------------------------------- deposit (stage)
#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init_if_needed,
        payer = trader,
        space = 8 + CollateralShuttle::INIT_SPACE,
        seeds = [SHUTTLE_SEED, trader.key().as_ref()],
        bump
    )]
    pub shuttle: Account<'info, CollateralShuttle>,
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

/// L1: pull real USDC into the vault and stage it on the trader's shuttle. Works whether or not the
/// trader's UserBalance is currently delegated — the shuttle is a separate account. The staged
/// amount becomes spendable `free_collateral` only after `claim_deposit` runs on the ER.
pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, ShearError::InsufficientCollateral);
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
    let s = &mut ctx.accounts.shuttle;
    if s.owner == Pubkey::default() {
        s.owner = ctx.accounts.trader.key();
        s.bump = ctx.bumps.shuttle;
    }
    s.deposit_amt = s.deposit_amt.checked_add(amount).ok_or(ShearError::MathOverflow)?;
    emit!(CollateralDeposited { owner: s.owner, amount });
    Ok(())
}

// ----------------------------------------------------------------------------- settle withdraw
#[derive(Accounts)]
pub struct SettleWithdraw<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [SHUTTLE_SEED, trader.key().as_ref()],
        bump = shuttle.bump,
        constraint = shuttle.owner == trader.key() @ ShearError::Unauthorized
    )]
    pub shuttle: Account<'info, CollateralShuttle>,
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

/// L1: pay out everything the trader debited from `free_collateral` via `request_withdraw` on the ER.
/// The shuttle must be on L1 (undelegated) and already carry the committed `withdraw_amt`.
pub fn settle_withdraw(ctx: Context<SettleWithdraw>) -> Result<()> {
    let amount = ctx.accounts.shuttle.withdraw_amt;
    require!(amount > 0, ShearError::InsufficientCollateral);
    ctx.accounts.shuttle.withdraw_amt = 0; // effect before the external CPI (checks-effects-interactions)

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
    emit!(CollateralWithdrawn { owner: ctx.accounts.shuttle.owner, amount });
    Ok(())
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
