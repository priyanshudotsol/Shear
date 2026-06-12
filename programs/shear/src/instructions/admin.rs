//! Admin: initialize_config, create_market, set_market_status (instructions.md §Admin).

use crate::constants::*;
use crate::error::ShearError;
use crate::events::MarketCreated;
use crate::state::*;
use crate::vendored_pyth::PriceUpdateV2;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitConfigParams {
    pub taker_fee_bps: u16,
    pub liq_penalty_bps: u16,
    pub liq_reward_share_bps: u16,
    pub insurance_cut_bps: u16,
    pub min_collateral: u64,
    pub min_position_notional: u64,
    pub max_age_sec: u64,
    pub max_ratio_conf_bps: u16,
    pub liq_max_conf_bps: u16,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + GlobalConfig::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GlobalConfig>,
    pub usdc_mint: Account<'info, Mint>,
    /// CHECK: PDA authority of the single program-owned USDC vault.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    /// The one vault holding ALL physical USDC (LP + trader collateral). Authority = vault_auth.
    #[account(init, payer = admin, seeds = [VAULT_SEED], bump, token::mint = usdc_mint, token::authority = vault_auth)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the MagicBlock oracle program id (stored for reference; feeds are bound per-market)
    pub oracle_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_config(ctx: Context<InitializeConfig>, p: InitConfigParams) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.oracle_program = ctx.accounts.oracle_program.key();
    c.taker_fee_bps = p.taker_fee_bps;
    c.liq_penalty_bps = p.liq_penalty_bps;
    c.liq_reward_share_bps = p.liq_reward_share_bps;
    c.insurance_cut_bps = p.insurance_cut_bps;
    c.min_collateral = p.min_collateral;
    c.min_position_notional = p.min_position_notional;
    c.max_age_sec = p.max_age_sec;
    c.max_ratio_conf_bps = p.max_ratio_conf_bps;
    c.liq_max_conf_bps = p.liq_max_conf_bps;
    c.paused = false;
    c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateMarketParams {
    pub symbol: [u8; 16],
    pub max_leverage: u16,
    pub mmr_bps: u16,
    pub k_funding_bps: u32,
    pub f_max_bps: u32,
    pub oi_cap_abs: u64,
    pub max_net_util_bps: u16,
}

#[derive(Accounts)]
#[instruction(p: CreateMarketParams)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ ShearError::Unauthorized)]
    pub config: Account<'info, GlobalConfig>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [MARKET_SEED, p.symbol.as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = admin, space = 8 + LiquidityPool::INIT_SPACE, seeds = [POOL_SEED, market.key().as_ref()], bump)]
    pub pool: Account<'info, LiquidityPool>,
    /// CHECK: BASE/USD PriceUpdateV2 oracle account; its bytes are the feed_id
    pub base_feed: UncheckedAccount<'info>,
    /// CHECK: QUOTE/USD PriceUpdateV2 oracle account
    pub quote_feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_market(ctx: Context<CreateMarket>, p: CreateMarketParams) -> Result<()> {
    // read both feeds to bind the exponent (asserted equal)
    let base = PriceUpdateV2::try_deserialize_unchecked(&mut (*ctx.accounts.base_feed.data.borrow()).as_ref())?;
    let quote = PriceUpdateV2::try_deserialize_unchecked(&mut (*ctx.accounts.quote_feed.data.borrow()).as_ref())?;
    require!(
        base.price_message.exponent == quote.price_message.exponent,
        ShearError::FeedMismatch
    );

    let cfg = &ctx.accounts.config;
    let m = &mut ctx.accounts.market;
    m.symbol = p.symbol;
    m.base_feed = ctx.accounts.base_feed.key();
    m.quote_feed = ctx.accounts.quote_feed.key();
    m.expo = base.price_message.exponent;
    m.max_leverage = p.max_leverage;
    m.mmr_bps = p.mmr_bps;
    m.k_funding_bps = p.k_funding_bps;
    m.f_max_bps = p.f_max_bps;
    m.oi_cap_abs = p.oi_cap_abs;
    m.max_net_util_bps = p.max_net_util_bps;
    // snapshot config params so the ER is self-contained
    m.taker_fee_bps = cfg.taker_fee_bps;
    m.liq_penalty_bps = cfg.liq_penalty_bps;
    m.liq_reward_share_bps = cfg.liq_reward_share_bps;
    m.insurance_cut_bps = cfg.insurance_cut_bps;
    m.min_collateral = cfg.min_collateral;
    m.min_position_notional = cfg.min_position_notional;
    m.max_age_sec = cfg.max_age_sec;
    m.max_ratio_conf_bps = cfg.max_ratio_conf_bps;
    m.liq_max_conf_bps = cfg.liq_max_conf_bps;
    // anchor the volatility index at the live ratio; 1x (identity) until admin dials it up
    m.ref_ratio = shear_math::compute_ratio(base.price_message.price, quote.price_message.price)
        .map_err(|_| error!(ShearError::OracleStale))?;
    m.amp_bps = shear_math::BPS as u32;
    m.long_oi = 0;
    m.short_oi = 0;
    m.cum_funding = 0;
    m.last_funding_ts = Clock::get()?.unix_timestamp;
    m.status = MarketStatus::Active;
    m.bump = ctx.bumps.market;

    let pool = &mut ctx.accounts.pool;
    pool.market = m.key();
    pool.total_shares = 0;
    pool.pool_usdc = 0;
    pool.accrued_fees = 0;
    pool.insurance_fund = 0;
    pool.bump = ctx.bumps.pool;

    emit!(MarketCreated { market: m.key(), symbol: p.symbol });
    Ok(())
}

#[derive(Accounts)]
pub struct SetMarketStatus<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ ShearError::Unauthorized)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

pub fn set_market_status(ctx: Context<SetMarketStatus>, status: MarketStatus) -> Result<()> {
    ctx.accounts.market.status = status;
    Ok(())
}

/// Admin: tune the market's risk params (e.g. relax the pool-utilization cap / minimums for a
/// small devnet pool). Must run while the market is on L1 (undelegate the session first).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MarketRiskParams {
    pub max_leverage: u16,
    pub mmr_bps: u16,
    pub max_net_util_bps: u16,
    pub oi_cap_abs: u64,
    pub min_collateral: u64,
    pub min_position_notional: u64,
}

pub fn set_market_risk(ctx: Context<SetMarketStatus>, p: MarketRiskParams) -> Result<()> {
    let m = &mut ctx.accounts.market;
    m.max_leverage = p.max_leverage;
    m.mmr_bps = p.mmr_bps;
    m.max_net_util_bps = p.max_net_util_bps;
    m.oi_cap_abs = p.oi_cap_abs;
    m.min_collateral = p.min_collateral;
    m.min_position_notional = p.min_position_notional;
    Ok(())
}

/// Admin: set the volatility-amplification index for a market (relative-value perp). Re-anchors
/// `ref_ratio` (R_0) and sets `amp_bps` (1e4 = 1x identity; e.g. 100_000 = 10x). Pass the *current*
/// raw ratio (1e9-scaled) read off-chain so the index is symmetric around now. `amp_bps == 1e4`
/// (or `ref_ratio == 0`) disables amplification. Must run while the market is on L1 (undelegate first).
pub fn set_market_vol(ctx: Context<SetMarketStatus>, ref_ratio: u128, amp_bps: u32) -> Result<()> {
    let m = &mut ctx.accounts.market;
    m.ref_ratio = ref_ratio;
    m.amp_bps = amp_bps;
    Ok(())
}

/// Global pause / unpause kill switch.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ ShearError::Unauthorized)]
    pub config: Account<'info, GlobalConfig>,
}

pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
