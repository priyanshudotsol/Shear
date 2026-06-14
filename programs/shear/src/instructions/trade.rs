//! Trading core (ER): open/close/add/remove (instructions.md §Trading). Thin wrappers over the
//! tested `shear_math::engine`: read oracle -> authorize (owner or session) -> load engine structs
//! -> call engine -> store back -> emit. NOTE: market/pool/user_balance/position are delegated in
//! the ER (the runtime makes this program the effective owner, so typed Account<T> works — as in
//! the dummy-token-transfer example).

use crate::constants::*;
use crate::engine_glue as glue;
use crate::error::ShearError;
use crate::events::{PositionClosed, PositionModified, PositionOpened};
use crate::oracle;
use crate::state::*;
use anchor_lang::prelude::*;
use session_keys::SessionTokenV2;
use shear_math::engine as eng;

/// Owner-or-session authorization for a delegated trade account. Three accepted signers:
///   1. the owner directly,
///   2. the owner's registered `session_authority` (a local "session key" set via `set_session_key`)
///      — this is the gasless path: a browser-local keypair signs ER trades, NOT the wallet,
///   3. a session-keys `SessionTokenV2` (kept for compatibility).
fn authorize(
    signer: &Pubkey,
    owner: &Pubkey,
    session_authority: &Pubkey,
    session: &Option<Account<SessionTokenV2>>,
    now: i64,
) -> Result<()> {
    if signer == owner {
        return Ok(());
    }
    // registered session key (must be explicitly set; default Pubkey never matches a real signer)
    if signer == session_authority && *session_authority != Pubkey::default() {
        return Ok(());
    }
    if let Some(tok) = session {
        // typed Account<SessionTokenV2> already enforces owner == session program + discriminator
        require!(tok.authority == *owner, ShearError::Unauthorized);
        require!(&tok.session_signer == signer, ShearError::Unauthorized);
        require!(tok.target_program == crate::ID, ShearError::Unauthorized);
        require!(tok.valid_until > now, ShearError::Unauthorized);
        return Ok(());
    }
    Err(error!(ShearError::Unauthorized))
}

/// L1: the owner registers a local session key that may sign ER trades on their behalf.
/// Must run while `UserBalance` is on L1 (before delegation). Pass `Pubkey::default()` to revoke.
#[derive(Accounts)]
pub struct SetSessionKey<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump = user_balance.bump,
        constraint = user_balance.owner == owner.key() @ ShearError::Unauthorized
    )]
    pub user_balance: Account<'info, UserBalance>,
}

pub fn set_session_key(ctx: Context<SetSessionKey>, session_key: Pubkey) -> Result<()> {
    ctx.accounts.user_balance.session_authority = session_key;
    Ok(())
}

#[derive(Accounts)]
pub struct Trade<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [POOL_SEED, market.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, LiquidityPool>,
    #[account(mut, seeds = [USER_SEED, user_balance.owner.as_ref()], bump = user_balance.bump)]
    pub user_balance: Account<'info, UserBalance>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position_book.owner.as_ref(), market.key().as_ref()],
        bump = position_book.bump,
        constraint = position_book.owner == user_balance.owner @ ShearError::Unauthorized
    )]
    pub position_book: Box<Account<'info, PositionBook>>,
    /// CHECK: BASE feed, bound to the market
    #[account(address = market.base_feed @ ShearError::FeedMismatch)]
    pub base_price: AccountInfo<'info>,
    /// CHECK: QUOTE feed, bound to the market
    #[account(address = market.quote_feed @ ShearError::FeedMismatch)]
    pub quote_price: AccountInfo<'info>,
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

/// Open a new position in slot `slot` (must be currently Closed). A trader can hold up to
/// MAX_POSITIONS at once; all share the trader's free collateral.
pub fn open_position(ctx: Context<Trade>, slot: u8, side: Side, collateral: u64, leverage: u16) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let i = slot as usize;
    require!(i < MAX_POSITIONS, ShearError::InvalidSlot);
    require!(ctx.accounts.market.status == MarketStatus::Active, ShearError::MarketHalted);
    require!(ctx.accounts.position_book.slots[i].status != PositionStatus::Open, ShearError::PositionExists);
    authorize(&ctx.accounts.signer.key(), &ctx.accounts.user_balance.owner, &ctx.accounts.user_balance.session_authority, &ctx.accounts.session_token, now)?;

    let market_key = ctx.accounts.market.key();
    let (r_t, _conf_bps) = oracle::read_ratio(
        &ctx.accounts.base_price,
        &ctx.accounts.quote_price,
        ctx.accounts.market.max_age_sec,
        ctx.accounts.market.max_ratio_conf_bps as u64,
    )?;

    let cfg = glue::cfg(&ctx.accounts.market);
    let mut em = glue::load_market(&ctx.accounts.market);
    let mut ep = glue::load_pool(&ctx.accounts.pool);
    let mut eu = glue::load_user(&ctx.accounts.user_balance);

    let newpos = eng::open_position(&cfg, &mut em, &mut ep, &mut eu, glue::side_to_engine(side), collateral, leverage, r_t)
        .map_err(ShearError::from)?;

    glue::store_market(&mut ctx.accounts.market, &em);
    glue::store_pool(&mut ctx.accounts.pool, &ep);
    ctx.accounts.user_balance.free_collateral = eu.free_collateral;
    let owner = ctx.accounts.position_book.owner;
    let book = &mut ctx.accounts.position_book;
    glue::store_slot(&mut book.slots[i], &newpos);
    book.slots[i].opened_ts = now;

    emit!(PositionOpened {
        owner,
        market: market_key,
        slot,
        side,
        notional: newpos.notional,
        entry_ratio: newpos.entry_ratio,
        collateral: newpos.collateral,
    });
    Ok(())
}

/// Close the position in slot `slot`. Settled equity returns to the trader's free collateral.
pub fn close_position(ctx: Context<Trade>, slot: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let i = slot as usize;
    require!(i < MAX_POSITIONS, ShearError::InvalidSlot);
    require!(ctx.accounts.position_book.slots[i].status == PositionStatus::Open, ShearError::PositionNotOpen);
    authorize(&ctx.accounts.signer.key(), &ctx.accounts.user_balance.owner, &ctx.accounts.user_balance.session_authority, &ctx.accounts.session_token, now)?;

    let market_key = ctx.accounts.market.key();
    let (r_t, _conf_bps) = oracle::read_ratio(
        &ctx.accounts.base_price,
        &ctx.accounts.quote_price,
        ctx.accounts.market.max_age_sec,
        ctx.accounts.market.max_ratio_conf_bps as u64,
    )?;

    let cfg = glue::cfg(&ctx.accounts.market);
    let mut em = glue::load_market(&ctx.accounts.market);
    let mut ep = glue::load_pool(&ctx.accounts.pool);
    let mut eu = glue::load_user(&ctx.accounts.user_balance);
    let mut epos = glue::load_slot(&ctx.accounts.position_book.slots[i]);

    let s = eng::close_position(&cfg, &mut em, &mut ep, &mut eu, &mut epos, r_t).map_err(ShearError::from)?;

    glue::store_market(&mut ctx.accounts.market, &em);
    glue::store_pool(&mut ctx.accounts.pool, &ep);
    ctx.accounts.user_balance.free_collateral = eu.free_collateral;
    let owner = ctx.accounts.position_book.owner;
    glue::store_slot(&mut ctx.accounts.position_book.slots[i], &epos);

    emit!(PositionClosed {
        owner,
        market: market_key,
        slot,
        upnl: s.upnl,
        funding_owed: s.funding,
        settlement: s.trader_gets,
    });
    Ok(())
}

/// Add/remove collateral on one open position slot.
#[derive(Accounts)]
pub struct ModifyCollateral<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [USER_SEED, user_balance.owner.as_ref()], bump = user_balance.bump)]
    pub user_balance: Account<'info, UserBalance>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position_book.owner.as_ref(), market.key().as_ref()],
        bump = position_book.bump,
        constraint = position_book.owner == user_balance.owner @ ShearError::Unauthorized
    )]
    pub position_book: Box<Account<'info, PositionBook>>,
    /// CHECK: BASE feed (only used by remove_collateral)
    #[account(address = market.base_feed @ ShearError::FeedMismatch)]
    pub base_price: AccountInfo<'info>,
    /// CHECK: QUOTE feed
    #[account(address = market.quote_feed @ ShearError::FeedMismatch)]
    pub quote_price: AccountInfo<'info>,
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

pub fn add_collateral(ctx: Context<ModifyCollateral>, slot: u8, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let i = slot as usize;
    require!(i < MAX_POSITIONS, ShearError::InvalidSlot);
    require!(ctx.accounts.position_book.slots[i].status == PositionStatus::Open, ShearError::PositionNotOpen);
    authorize(&ctx.accounts.signer.key(), &ctx.accounts.user_balance.owner, &ctx.accounts.user_balance.session_authority, &ctx.accounts.session_token, now)?;
    require!(amount <= ctx.accounts.user_balance.free_collateral, ShearError::InsufficientCollateral);
    ctx.accounts.user_balance.free_collateral -= amount;
    let market_key = ctx.accounts.market.key();
    let owner = ctx.accounts.position_book.owner;
    let book = &mut ctx.accounts.position_book;
    book.slots[i].collateral = book.slots[i].collateral.checked_add(amount).ok_or(ShearError::MathOverflow)?;
    emit!(PositionModified { owner, market: market_key, slot, collateral: book.slots[i].collateral });
    Ok(())
}

pub fn remove_collateral(ctx: Context<ModifyCollateral>, slot: u8, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let i = slot as usize;
    require!(i < MAX_POSITIONS, ShearError::InvalidSlot);
    require!(ctx.accounts.position_book.slots[i].status == PositionStatus::Open, ShearError::PositionNotOpen);
    authorize(&ctx.accounts.signer.key(), &ctx.accounts.user_balance.owner, &ctx.accounts.user_balance.session_authority, &ctx.accounts.session_token, now)?;
    let pos = ctx.accounts.position_book.slots[i]; // Copy
    require!(amount < pos.collateral, ShearError::InsufficientCollateral);

    // health check at the current ratio: resulting equity must stay comfortably above maintenance.
    let (r_t, _c) = oracle::read_ratio(
        &ctx.accounts.base_price,
        &ctx.accounts.quote_price,
        ctx.accounts.market.max_age_sec,
        ctx.accounts.market.max_ratio_conf_bps as u64,
    )?;
    let new_collateral = pos.collateral - amount;
    let upnl = shear_math::unrealized_pnl(glue::side_to_engine(pos.side), pos.notional, pos.entry_ratio, r_t)
        .map_err(|_| error!(ShearError::MathOverflow))?;
    let funding = shear_math::funding_owed(glue::side_to_engine(pos.side), pos.notional, ctx.accounts.market.cum_funding, pos.entry_cum_funding)
        .map_err(|_| error!(ShearError::MathOverflow))?;
    let equity = shear_math::equity(new_collateral, upnl, funding, 0);
    let maint = shear_math::maintenance_margin(pos.notional, ctx.accounts.market.mmr_bps);
    require!(equity >= maint.saturating_mul(2), ShearError::WouldBeLiquidatable);

    let market_key = ctx.accounts.market.key();
    let owner = ctx.accounts.position_book.owner;
    ctx.accounts.position_book.slots[i].collateral = new_collateral;
    ctx.accounts.user_balance.free_collateral = ctx.accounts.user_balance.free_collateral.checked_add(amount).ok_or(ShearError::MathOverflow)?;
    emit!(PositionModified { owner, market: market_key, slot, collateral: new_collateral });
    Ok(())
}
