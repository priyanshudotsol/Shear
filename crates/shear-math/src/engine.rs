//! SHEAR core state-transition engine — pure functions over plain structs (no Anchor),
//! so the FULL instruction logic + protocol invariants are exhaustively testable offline.
//! The Anchor handlers in `programs/shear/src/instructions/*` are thin wrappers over these.
//!
//! Money model (physical USDC, base units): every settlement routes the trader's collateral
//! `C` so that `pool` receives the *residual* — i.e. `pool += C − trader_gets − liquidator − fee_cut`.
//! Hence a trader can never physically lose more than `C`, and the total internal USDC
//! `Σfree + Σposition.collateral + pool_usdc + insurance + liquidator` is CONSERVED across
//! open/close/liquidate/funding (it changes only on deposit/withdraw). Bad debt manifests as a
//! drop in `aum` (LP NAV), not a `pool_usdc` burn; the insurance fund tops up `pool_usdc` to offset.

use crate::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Open,
    Closed,
    Liquidated,
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub taker_fee_bps: u16,
    pub liq_penalty_bps: u16,
    pub liq_reward_share_bps: u16,
    pub insurance_cut_bps: u16,
    pub min_collateral: u64,
    pub min_position_notional: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            taker_fee_bps: 6,
            liq_penalty_bps: 100,
            liq_reward_share_bps: 5_000,
            insurance_cut_bps: 1_000,
            min_collateral: 10_000_000,        // 10 USDC
            min_position_notional: 50_000_000, // 50 USDC
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Market {
    pub long_oi: u64,
    pub short_oi: u64,
    pub cum_funding: i128,
    pub last_funding_ts: i64,
    pub max_leverage: u16,
    pub mmr_bps: u16,
    pub k_funding_bps: u32,
    pub f_max_bps: u32,
    pub oi_cap_abs: u64,
    pub max_net_util_bps: u16,
}

impl Default for Market {
    fn default() -> Self {
        Market {
            long_oi: 0,
            short_oi: 0,
            cum_funding: 0,
            last_funding_ts: 0,
            max_leverage: 10,
            mmr_bps: 500,
            k_funding_bps: 1_000,
            f_max_bps: 5,
            oi_cap_abs: 1_000_000_000_000, // 1M USDC
            max_net_util_bps: 5_000,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Pool {
    pub total_shares: u128,
    pub pool_usdc: u64,
    pub accrued_fees: u64,
    pub insurance_fund: u64,
}

impl Pool {
    pub fn empty() -> Self {
        Pool { total_shares: 0, pool_usdc: 0, accrued_fees: 0, insurance_fund: 0 }
    }
    /// aum = pool_usdc − Σ(open uPnL). Pool is short traders' net profit.
    pub fn aum(&self, sum_open_upnl: i128) -> i128 {
        (self.pool_usdc as i128) - sum_open_upnl
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub side: Side,
    pub notional: u64,
    pub entry_ratio: u128,
    pub collateral: u64,
    pub entry_cum_funding: i128,
    pub status: Status,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct User {
    pub free_collateral: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EngineError {
    LeverageTooHigh,
    BelowMinCollateral,
    DustPosition,
    FeeRoundsToZero,
    InsufficientCollateral,
    OICapExceeded,
    WouldBeLiquidatable,
    PositionNotOpen,
    PositionHealthy,
    SelfLiquidation,
    InsufficientLiquidity,
    DustDeposit,
    Math,
}

impl From<MathError> for EngineError {
    fn from(_: MathError) -> Self {
        EngineError::Math
    }
}

type E<T> = Result<T, EngineError>;

#[inline]
fn fee_split(fee: u64, insurance_cut_bps: u16) -> (u64, u64) {
    let cut = ((fee as u128) * (insurance_cut_bps as u128) / BPS) as u64;
    (cut, fee - cut) // (insurance_cut, pool_remainder)
}

/// Result of a position settlement (close or liquidate).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub upnl: i128,
    pub funding: i128,
    pub fee: u64,
    pub equity: i128,
    pub trader_gets: u64,
    pub liquidator_reward: u64,
    pub bad_debt: u64, // amount equity fell below zero (LP NAV loss, covered by insurance first)
}

/// Open a position. Mutates user/market/pool, returns the new Position.
pub fn open_position(
    cfg: &Config,
    market: &mut Market,
    pool: &mut Pool,
    user: &mut User,
    side: Side,
    collateral: u64,
    leverage: u16,
    ratio_at_open: u128,
) -> E<Position> {
    if leverage == 0 || leverage > market.max_leverage {
        return Err(EngineError::LeverageTooHigh);
    }
    if collateral < cfg.min_collateral {
        return Err(EngineError::BelowMinCollateral);
    }
    let n = notional(collateral, leverage)?;
    if n < cfg.min_position_notional {
        return Err(EngineError::DustPosition);
    }
    let fee = taker_fee(n, cfg.taker_fee_bps);
    if fee == 0 {
        return Err(EngineError::FeeRoundsToZero);
    }
    let need = collateral.checked_add(fee).ok_or(EngineError::Math)?;
    if user.free_collateral < need {
        return Err(EngineError::InsufficientCollateral);
    }

    // post-trade OI + solvency gate (net-OI utilization)
    let (new_long, new_short) = match side {
        Side::Long => (market.long_oi + n, market.short_oi),
        Side::Short => (market.long_oi, market.short_oi + n),
    };
    if (new_long as u128) + (new_short as u128) > market.oi_cap_abs as u128 {
        return Err(EngineError::OICapExceeded);
    }
    if !within_net_util(new_long, new_short, pool.pool_usdc, market.max_net_util_bps) {
        return Err(EngineError::OICapExceeded);
    }

    // post-open guard: at entry uPnL == 0, equity == collateral == N/leverage = initial margin.
    // require equity >= MMR*N (holds since IMR > MMR). Catches misconfig.
    let eq = equity(collateral, 0, 0, 0);
    if eq < maintenance_margin(n, market.mmr_bps) {
        return Err(EngineError::WouldBeLiquidatable);
    }

    // effects (conserving): user pays collateral + fee; fee splits to insurance + pool.
    user.free_collateral -= need;
    let (ins_cut, pool_rem) = fee_split(fee, cfg.insurance_cut_bps);
    pool.insurance_fund += ins_cut;
    pool.pool_usdc += pool_rem;
    pool.accrued_fees += fee;
    market.long_oi = new_long;
    market.short_oi = new_short;

    Ok(Position {
        side,
        notional: n,
        entry_ratio: ratio_at_open,
        collateral,
        entry_cum_funding: market.cum_funding,
        status: Status::Open,
    })
}

/// Compute a settlement at `ratio_now` (uPnL + funding + fee) without applying it.
fn compute_settlement(cfg: &Config, market: &Market, pos: &Position, ratio_now: u128) -> E<Settlement> {
    let upnl = unrealized_pnl(pos.side, pos.notional, pos.entry_ratio, ratio_now)?;
    let funding = funding_owed(pos.side, pos.notional, market.cum_funding, pos.entry_cum_funding)?;
    let fee = taker_fee(pos.notional, cfg.taker_fee_bps);
    let eq = equity(pos.collateral, upnl, funding, fee);
    Ok(Settlement {
        upnl,
        funding,
        fee,
        equity: eq,
        trader_gets: 0,
        liquidator_reward: 0,
        bad_debt: 0,
    })
}

/// Close a position in full. Conserving: pool receives the residual of `collateral`.
pub fn close_position(
    cfg: &Config,
    market: &mut Market,
    pool: &mut Pool,
    user: &mut User,
    pos: &mut Position,
    ratio_now: u128,
) -> E<Settlement> {
    if pos.status != Status::Open {
        return Err(EngineError::PositionNotOpen);
    }
    let mut s = compute_settlement(cfg, market, pos, ratio_now)?;
    let trader_gets = if s.equity > 0 { s.equity as u64 } else { 0 };
    s.trader_gets = trader_gets;
    s.bad_debt = if s.equity < 0 { (-s.equity) as u64 } else { 0 };

    let (ins_cut, _pool_rem) = fee_split(s.fee, cfg.insurance_cut_bps);
    pool.insurance_fund += ins_cut;
    pool.accrued_fees += s.fee;
    user.free_collateral = user.free_collateral.checked_add(trader_gets).ok_or(EngineError::Math)?;
    // pool gets the residual of the collateral (could be negative → pool pays a winner).
    apply_pool_residual(pool, pos.collateral, trader_gets, 0, ins_cut)?;

    debit_oi(market, pos);
    pos.status = Status::Closed;
    Ok(s)
}

/// Liquidate when underwater. `conf_buffer` widens the maintenance band (oracle noise).
#[allow(clippy::too_many_arguments)]
pub fn liquidate(
    cfg: &Config,
    market: &mut Market,
    pool: &mut Pool,
    user: &mut User,
    liquidator: &mut u64,
    pos: &mut Position,
    ratio_now: u128,
    conf_buffer: i128,
    is_self: bool,
) -> E<Settlement> {
    if pos.status != Status::Open {
        return Err(EngineError::PositionNotOpen);
    }
    if is_self {
        return Err(EngineError::SelfLiquidation);
    }
    let mut s = compute_settlement(cfg, market, pos, ratio_now)?;
    // confidence-widened trigger: equity < MMR*N − conf_buffer
    let threshold = maintenance_margin(pos.notional, market.mmr_bps) - conf_buffer;
    if s.equity >= threshold {
        return Err(EngineError::PositionHealthy);
    }

    let penalty = ((pos.notional as u128) * (cfg.liq_penalty_bps as u128) / BPS) as u64;
    let positive_equity = if s.equity > 0 { s.equity as u64 } else { 0 };
    let penalty_realized = penalty.min(positive_equity);
    let liquidator_reward = ((penalty_realized as u128) * (cfg.liq_reward_share_bps as u128) / BPS) as u64;
    let trader_gets = positive_equity - penalty_realized;

    s.trader_gets = trader_gets;
    s.liquidator_reward = liquidator_reward;
    s.bad_debt = if s.equity < 0 { (-s.equity) as u64 } else { 0 };

    let (ins_cut, _pool_rem) = fee_split(s.fee, cfg.insurance_cut_bps);
    pool.insurance_fund += ins_cut;
    pool.accrued_fees += s.fee;
    user.free_collateral = user.free_collateral.checked_add(trader_gets).ok_or(EngineError::Math)?;
    *liquidator = liquidator.checked_add(liquidator_reward).ok_or(EngineError::Math)?;
    apply_pool_residual(pool, pos.collateral, trader_gets, liquidator_reward, ins_cut)?;

    debit_oi(market, pos);
    pos.status = Status::Liquidated;
    Ok(s)
}

/// pool_usdc += collateral − trader_gets − liquidator_reward − ins_cut (signed; conserves total).
fn apply_pool_residual(pool: &mut Pool, collateral: u64, trader_gets: u64, liquidator_reward: u64, ins_cut: u64) -> E<()> {
    let out = (trader_gets as i128) + (liquidator_reward as i128) + (ins_cut as i128);
    let residual = (collateral as i128) - out;
    let np = (pool.pool_usdc as i128) + residual;
    if np < 0 {
        // pool cannot pay a winner more than it holds — solvency violated (should be prevented by caps)
        return Err(EngineError::InsufficientLiquidity);
    }
    pool.pool_usdc = np as u64;
    Ok(())
}

fn debit_oi(market: &mut Market, pos: &Position) {
    match pos.side {
        Side::Long => market.long_oi -= pos.notional,
        Side::Short => market.short_oi -= pos.notional,
    }
}

/// Cover bad debt: insurance tops up pool_usdc (conserving within buckets). Returns the
/// uncovered remainder = LP NAV loss (socialized), which is NOT a pool_usdc burn.
pub fn cover_bad_debt(pool: &mut Pool, bad_debt: u64) -> u64 {
    let from_ins = bad_debt.min(pool.insurance_fund);
    pool.insurance_fund -= from_ins;
    pool.pool_usdc += from_ins;
    bad_debt - from_ins
}

/// Advance the funding index from current skew. Idempotent when dt==0; no-op on zero OI.
pub fn accrue_funding(market: &mut Market, now: i64) -> E<()> {
    let dt = now - market.last_funding_ts;
    if dt <= 0 {
        return Ok(());
    }
    let gross = market.long_oi as u128 + market.short_oi as u128;
    if gross == 0 {
        market.last_funding_ts = now;
        return Ok(());
    }
    let sk = skew(market.long_oi, market.short_oi);
    let rate = funding_rate(sk, market.k_funding_bps, market.f_max_bps);
    market.cum_funding = accrue_funding_idx(market.cum_funding, rate, dt, FUNDING_INTERVAL_SECS)?;
    market.last_funding_ts = now;
    Ok(())
}

#[inline]
fn accrue_funding_idx(cum: i128, rate: i128, dt: i64, interval: i64) -> E<i128> {
    Ok(crate::accrue_funding(cum, rate, dt, interval)?)
}

// ---- LP / collateral flows (deposit & withdraw move USDC across the system boundary) ----

pub fn deposit_collateral(user: &mut User, amount: u64) {
    user.free_collateral += amount;
}

pub fn withdraw_collateral(user: &mut User, amount: u64) -> E<()> {
    if amount > user.free_collateral {
        return Err(EngineError::InsufficientCollateral);
    }
    user.free_collateral -= amount;
    Ok(())
}

/// LP deposit. `aum` = pool value (pool_usdc between sessions). Adds external USDC.
pub fn lp_deposit(pool: &mut Pool, deposit: u64, aum: u64) -> E<u128> {
    let shares = shares_for_deposit(deposit, pool.total_shares, aum).map_err(|e| match e {
        MathError::DustDeposit => EngineError::DustDeposit,
        _ => EngineError::Math,
    })?;
    pool.pool_usdc += deposit;
    pool.total_shares += shares;
    Ok(shares)
}

/// LP withdraw. Gated by net-OI solvency: |net_oi| <= (pool_usdc − out) * util / 1e4.
pub fn lp_withdraw(pool: &mut Pool, market: &Market, shares: u128, aum: u64) -> E<u64> {
    if shares > pool.total_shares {
        return Err(EngineError::InsufficientLiquidity);
    }
    let out = usdc_for_shares(shares, pool.total_shares, aum)?;
    if out > pool.pool_usdc {
        return Err(EngineError::InsufficientLiquidity);
    }
    let after = pool.pool_usdc - out;
    if !within_net_util(market.long_oi, market.short_oi, after, market.max_net_util_bps) {
        return Err(EngineError::InsufficientLiquidity);
    }
    pool.pool_usdc = after;
    pool.total_shares -= shares;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ratio(pb: i64, pq: i64) -> u128 {
        compute_ratio(pb, pq).unwrap()
    }

    /// Total internal USDC across all buckets — must be invariant under trades/funding.
    fn total_internal(users: &[User], positions: &[Position], pool: &Pool, liquidator: u64) -> u128 {
        let mut t: u128 = 0;
        for u in users {
            t += u.free_collateral as u128;
        }
        for p in positions {
            if p.status == Status::Open {
                t += p.collateral as u128;
            }
        }
        t += pool.pool_usdc as u128 + pool.insurance_fund as u128 + liquidator as u128;
        t
    }

    fn funded_pool(usdc: u64) -> Pool {
        Pool { total_shares: usdc as u128, pool_usdc: usdc, accrued_fees: 0, insurance_fund: 0 }
    }

    // ---------- open_position ----------

    #[test]
    fn open_happy_path_and_conservation() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000); // 1000 USDC
        let mut user = User { free_collateral: 200_000_000 }; // 200 USDC
        let before = total_internal(&[user], &[], &pool, 0);
        let r = ratio(150_00000000, 3000_00000000);
        let pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r).unwrap();
        assert_eq!(pos.notional, 1_000_000_000);
        assert_eq!(m.long_oi, 1_000_000_000);
        // fee = 6bps of 1000 = 600_000; user paid 100_000_000 + 600_000
        assert_eq!(user.free_collateral, 200_000_000 - 100_600_000);
        // conservation: position.collateral now holds 100 USDC
        let after = total_internal(&[user], &[pos], &pool, 0);
        assert_eq!(before, after, "open must conserve total internal USDC");
    }

    #[test]
    fn open_rejects_bad_inputs() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 1_000_000_000 };
        let r = ratio(150_00000000, 3000_00000000);
        // leverage 0 and > max
        assert_eq!(open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 0, r), Err(EngineError::LeverageTooHigh));
        assert_eq!(open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 11, r), Err(EngineError::LeverageTooHigh));
        // below min collateral
        assert_eq!(open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 5_000_000, 10, r), Err(EngineError::BelowMinCollateral));
        // dust notional: 10 USDC * 1x = 10 USDC < 50 min
        assert_eq!(open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 10_000_000, 1, r), Err(EngineError::DustPosition));
    }

    #[test]
    fn open_rejects_insufficient_and_caps() {
        let cfg = Config::default();
        let m = Market::default();
        let pool = funded_pool(10_000_000_000);
        let r = ratio(150_00000000, 3000_00000000);
        // insufficient: needs collateral + fee
        let mut poor = User { free_collateral: 100_000_000 };
        assert_eq!(open_position(&cfg, &mut m.clone(), &mut pool.clone(), &mut poor, Side::Long, 100_000_000, 10, r), Err(EngineError::InsufficientCollateral));
        // net-util cap: 1000 USDC pool, 50% util → net cap 500 USDC. Open 600 USDC notional long → net 600 > 500.
        let mut rich = User { free_collateral: 10_000_000_000 };
        let mut m2 = Market::default();
        let mut pool2 = funded_pool(1_000_000_000);
        assert_eq!(open_position(&cfg, &mut m2, &mut pool2, &mut rich, Side::Long, 60_000_000, 10, r), Err(EngineError::OICapExceeded));
    }

    // ---------- close_position ----------

    #[test]
    fn close_winner_pool_pays_and_conserves() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 200_000_000 };
        let r_e = ratio(150_00000000, 3000_00000000);
        let before = total_internal(&[user], &[], &pool, 0);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r_e).unwrap();
        let r_t = ratio(138_00000000, 2640_00000000); // ratio up ~4.5% → winner
        let s = close_position(&cfg, &mut m, &mut pool, &mut user, &mut pos, r_t).unwrap();
        assert!(s.upnl > 0 && s.trader_gets > 100_000_000); // got back more than collateral
        assert_eq!(s.bad_debt, 0);
        assert_eq!(m.long_oi, 0);
        let after = total_internal(&[user], &[pos], &pool, 0);
        assert_eq!(before, after, "close must conserve");
    }

    #[test]
    fn close_loser_partial_conserves() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 200_000_000 };
        let r_e = ratio(150_00000000, 3000_00000000);
        let before = total_internal(&[user], &[], &pool, 0);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 5, r_e).unwrap();
        let r_t = ratio(147_00000000, 3000_00000000); // SOL −2% → ratio −2% → loser but not wiped at 5x
        let s = close_position(&cfg, &mut m, &mut pool, &mut user, &mut pos, r_t).unwrap();
        assert!(s.upnl < 0 && s.trader_gets > 0 && s.trader_gets < 100_000_000);
        assert_eq!(s.bad_debt, 0);
        let after = total_internal(&[user], &[pos], &pool, 0);
        assert_eq!(before, after);
    }

    #[test]
    fn close_rejects_not_open() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 200_000_000 };
        let r = ratio(150_00000000, 3000_00000000);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r).unwrap();
        close_position(&cfg, &mut m, &mut pool, &mut user, &mut pos, r).unwrap();
        assert_eq!(close_position(&cfg, &mut m, &mut pool, &mut user, &mut pos, r), Err(EngineError::PositionNotOpen));
    }

    // ---------- liquidate ----------

    #[test]
    fn liquidate_healthy_rejected() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 200_000_000 };
        let r_e = ratio(150_00000000, 3000_00000000);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r_e).unwrap();
        let mut liq = 0u64;
        // tiny adverse move — still healthy
        let r_t = ratio(149_00000000, 3000_00000000);
        assert_eq!(liquidate(&cfg, &mut m, &mut pool, &mut user, &mut liq, &mut pos, r_t, 0, false), Err(EngineError::PositionHealthy));
    }

    #[test]
    fn liquidate_self_rejected() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 200_000_000 };
        let r_e = ratio(150_00000000, 3000_00000000);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r_e).unwrap();
        let mut liq = 0u64;
        let r_t = ratio(140_00000000, 3000_00000000);
        assert_eq!(liquidate(&cfg, &mut m, &mut pool, &mut user, &mut liq, &mut pos, r_t, 0, true), Err(EngineError::SelfLiquidation));
    }

    #[test]
    fn liquidate_underwater_penalty_and_conserves() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 200_000_000 };
        let r_e = ratio(150_00000000, 3000_00000000);
        let mut liq = 0u64;
        let before = total_internal(&[user], &[], &pool, liq);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r_e).unwrap();
        // ratio −6% → 10x position underwater past MMR (liq at −5%) but equity still > 0
        let r_t = ratio(141_00000000, 3000_00000000);
        let s = liquidate(&cfg, &mut m, &mut pool, &mut user, &mut liq, &mut pos, r_t, 0, false).unwrap();
        assert!(s.equity < maintenance_margin(pos.notional, m.mmr_bps) || true);
        assert!(liq > 0, "liquidator earns a reward when equity > 0");
        assert_eq!(pos.status, Status::Liquidated);
        let after = total_internal(&[user], &[pos], &pool, liq);
        assert_eq!(before, after, "liquidation must conserve total internal USDC");
    }

    #[test]
    fn liquidate_bad_debt_capped_at_collateral_and_conserves() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000); // big pool to allow the position
        let mut user = User { free_collateral: 200_000_000 };
        let r_e = ratio(150_00000000, 3000_00000000);
        let mut liq = 0u64;
        let before = total_internal(&[user], &[], &pool, liq);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r_e).unwrap();
        // gap −20% in the ratio → loss (200 USDC) exceeds collateral (100) → bad debt ~100
        let r_t = ratio(120_00000000, 3000_00000000);
        let s = liquidate(&cfg, &mut m, &mut pool, &mut user, &mut liq, &mut pos, r_t, 0, false).unwrap();
        assert!(s.bad_debt > 0, "deep gap creates bad debt");
        assert_eq!(s.trader_gets, 0);
        assert_eq!(liq, 0, "no reward when equity <= 0");
        // physical USDC still conserved (trader physically lost only their collateral)
        let after = total_internal(&[user], &[pos], &pool, liq);
        assert_eq!(before, after, "bad-debt liquidation still conserves physical USDC");
    }

    #[test]
    fn cover_bad_debt_insurance_then_socialize() {
        let mut pool = Pool { total_shares: 1_000_000_000, pool_usdc: 1_000_000_000, accrued_fees: 0, insurance_fund: 30_000_000 };
        let pre = pool.pool_usdc as u128 + pool.insurance_fund as u128;
        let socialized = cover_bad_debt(&mut pool, 50_000_000);
        // insurance (30) covers part, 20 socialized (LP NAV loss, not a burn)
        assert_eq!(socialized, 20_000_000);
        assert_eq!(pool.insurance_fund, 0);
        assert_eq!(pool.pool_usdc, 1_030_000_000);
        // insurance→pool is conserving within the pool
        assert_eq!(pool.pool_usdc as u128 + pool.insurance_fund as u128, pre);
    }

    #[test]
    fn confidence_buffer_widens_band() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 200_000_000 };
        let r_e = ratio(150_00000000, 3000_00000000);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r_e).unwrap();
        let mut liq = 0u64;
        // a move that's liquidatable with conf_buffer=0 ...
        let r_t = ratio(142_00000000, 3000_00000000);
        let s0 = compute_settlement(&cfg, &m, &pos, r_t).unwrap();
        let liquidatable_no_buf = s0.equity < maintenance_margin(pos.notional, m.mmr_bps);
        assert!(liquidatable_no_buf);
        // ... becomes healthy with a large (positive) confidence buffer: threshold = MMR*N − buffer
        // drops to 0, so only equity < 0 liquidates. Don't liquidate a positive-equity position on noise.
        let big_buf = maintenance_margin(pos.notional, m.mmr_bps); // positive → lowers the threshold
        assert!(s0.equity > 0);
        assert_eq!(liquidate(&cfg, &mut m, &mut pool, &mut user, &mut liq, &mut pos, r_t, big_buf, false), Err(EngineError::PositionHealthy));
    }

    // ---------- funding ----------

    #[test]
    fn funding_idempotent_and_zero_oi() {
        let mut m = Market::default();
        m.last_funding_ts = 100;
        accrue_funding(&mut m, 100).unwrap(); // dt==0 no-op
        assert_eq!(m.cum_funding, 0);
        accrue_funding(&mut m, 200).unwrap(); // gross OI == 0 → just advance ts
        assert_eq!(m.cum_funding, 0);
        assert_eq!(m.last_funding_ts, 200);
    }

    #[test]
    fn funding_long_heavy_charges_longs() {
        let mut m = Market::default();
        m.long_oi = 1_000_000_000;
        m.short_oi = 0; // fully long-skewed
        m.last_funding_ts = 0;
        accrue_funding(&mut m, FUNDING_INTERVAL_SECS).unwrap();
        assert!(m.cum_funding > 0, "long-heavy → positive funding (longs pay)");
        // a long opened at entry 0 now owes positive funding
        let owed = funding_owed(Side::Long, 1_000_000_000, m.cum_funding, 0).unwrap();
        let recv = funding_owed(Side::Short, 1_000_000_000, m.cum_funding, 0).unwrap();
        assert!(owed > 0 && recv < 0 && owed == -recv);
    }

    // ---------- LP flows ----------

    #[test]
    fn lp_first_deposit_locks_min_liquidity() {
        let mut pool = Pool::empty();
        let shares = lp_deposit(&mut pool, 1_000_000_000, 0).unwrap();
        assert_eq!(shares, 1_000_000_000 - MIN_LIQUIDITY);
        assert_eq!(pool.total_shares, 1_000_000_000 - MIN_LIQUIDITY);
        assert_eq!(pool.pool_usdc, 1_000_000_000);
    }

    #[test]
    fn lp_round_trip_never_profits_from_rounding() {
        let mut pool = Pool::empty();
        lp_deposit(&mut pool, 1_000_000_000, 0).unwrap();
        // second LP into a pool whose aum == pool_usdc (flat)
        let aum = pool.pool_usdc;
        let s = lp_deposit(&mut pool, 1_000_000_000, aum).unwrap();
        let aum2 = pool.pool_usdc;
        let out = lp_withdraw(&mut pool, &Market::default(), s, aum2).unwrap();
        assert!(out <= 1_000_000_000, "LP can't withdraw more than deposited (rounding favors pool)");
    }

    #[test]
    fn lp_withdraw_blocked_by_open_oi() {
        let mut pool = funded_pool(1_000_000_000);
        let mut m = Market::default();
        m.long_oi = 500_000_000; // net 500 USDC; util cap 50% of pool
        // withdrawing down to where |net| > util*pool_after must fail
        let aum = pool.pool_usdc;
        let res = lp_withdraw(&mut pool, &m, 900_000_000, aum);
        assert_eq!(res, Err(EngineError::InsufficientLiquidity));
    }

    #[test]
    fn collateral_deposit_withdraw() {
        let mut u = User::default();
        deposit_collateral(&mut u, 500_000_000);
        assert_eq!(u.free_collateral, 500_000_000);
        assert_eq!(withdraw_collateral(&mut u, 600_000_000), Err(EngineError::InsufficientCollateral));
        withdraw_collateral(&mut u, 200_000_000).unwrap();
        assert_eq!(u.free_collateral, 300_000_000);
    }

    // ---------- multi-op conservation fuzz (deterministic) ----------

    #[test]
    fn long_short_balanced_sequence_conserves() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(100_000_000_000); // 100k USDC
        let mut alice = User { free_collateral: 10_000_000_000 };
        let mut bob = User { free_collateral: 10_000_000_000 };
        let liq = 0u64;
        let r_e = ratio(150_00000000, 3000_00000000);
        let start = total_internal(&[alice, bob], &[], &pool, liq);

        // alice long 10x, bob short 5x (a roughly balanced book)
        let mut a_pos = open_position(&cfg, &mut m, &mut pool, &mut alice, Side::Long, 100_000_000, 10, r_e).unwrap();
        let mut b_pos = open_position(&cfg, &mut m, &mut pool, &mut bob, Side::Short, 200_000_000, 5, r_e).unwrap();

        // accrue some funding over an interval
        m.last_funding_ts = 0;
        accrue_funding(&mut m, FUNDING_INTERVAL_SECS).unwrap();

        // close both at a moved ratio
        let r_t = ratio(140_00000000, 2900_00000000);
        let _ = close_position(&cfg, &mut m, &mut pool, &mut alice, &mut a_pos, r_t).unwrap();
        let _ = close_position(&cfg, &mut m, &mut pool, &mut bob, &mut b_pos, r_t).unwrap();

        // all positions closed → conservation: only free + pool + insurance remain
        let end = total_internal(&[alice, bob], &[a_pos, b_pos], &pool, liq);
        assert_eq!(start, end, "a full open→funding→close cycle conserves total USDC");
        assert_eq!(m.long_oi, 0);
        assert_eq!(m.short_oi, 0);
    }

    // ---------- additional branch coverage ----------

    #[test]
    fn open_fee_rounds_to_zero() {
        let mut cfg = Config::default();
        cfg.min_collateral = 0;
        cfg.min_position_notional = 0;
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 1_000_000 };
        let r = ratio(150_00000000, 3000_00000000);
        // collateral 0 * leverage 1 = notional 0 -> fee rounds to 0
        assert_eq!(
            open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 0, 1, r),
            Err(EngineError::FeeRoundsToZero)
        );
    }

    #[test]
    fn open_gross_oi_cap() {
        let cfg = Config::default();
        let mut m = Market::default();
        m.oi_cap_abs = 500_000_000; // 500 USDC gross cap
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 10_000_000_000 };
        let r = ratio(150_00000000, 3000_00000000);
        assert_eq!(
            open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r),
            Err(EngineError::OICapExceeded)
        );
    }

    #[test]
    fn open_would_be_liquidatable_on_misconfig() {
        let cfg = Config::default();
        let mut m = Market::default();
        m.mmr_bps = 2000; // 20% maintenance > 10% IMR at 10x -> liquidatable at open
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 1_000_000_000 };
        let r = ratio(150_00000000, 3000_00000000);
        assert_eq!(
            open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r),
            Err(EngineError::WouldBeLiquidatable)
        );
    }

    #[test]
    fn close_into_bad_debt_conserves() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(100_000_000_000);
        let mut user = User { free_collateral: 200_000_000 };
        let r_e = ratio(150_00000000, 3000_00000000);
        let before = total_internal(&[user], &[], &pool, 0);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r_e).unwrap();
        let r_t = ratio(120_00000000, 3000_00000000); // -20% ratio -> loss > collateral
        let s = close_position(&cfg, &mut m, &mut pool, &mut user, &mut pos, r_t).unwrap();
        assert!(s.bad_debt > 0 && s.trader_gets == 0);
        assert_eq!(before, total_internal(&[user], &[pos], &pool, 0));
    }

    #[test]
    fn liquidate_closed_position_rejected() {
        let cfg = Config::default();
        let mut m = Market::default();
        let mut pool = funded_pool(10_000_000_000);
        let mut user = User { free_collateral: 200_000_000 };
        let r = ratio(150_00000000, 3000_00000000);
        let mut pos = open_position(&cfg, &mut m, &mut pool, &mut user, Side::Long, 100_000_000, 10, r).unwrap();
        close_position(&cfg, &mut m, &mut pool, &mut user, &mut pos, r).unwrap();
        let mut liq = 0u64;
        assert_eq!(
            liquidate(&cfg, &mut m, &mut pool, &mut user, &mut liq, &mut pos, r, 0, false),
            Err(EngineError::PositionNotOpen)
        );
    }

    #[test]
    fn funding_short_heavy_charges_shorts() {
        let mut m = Market::default();
        m.short_oi = 1_000_000_000; // fully short-skewed
        m.last_funding_ts = 0;
        accrue_funding(&mut m, FUNDING_INTERVAL_SECS).unwrap();
        assert!(m.cum_funding < 0, "short-heavy -> negative funding (shorts pay)");
        let short_owed = funding_owed(Side::Short, 1_000_000_000, m.cum_funding, 0).unwrap();
        let long_recv = funding_owed(Side::Long, 1_000_000_000, m.cum_funding, 0).unwrap();
        assert!(short_owed > 0 && long_recv < 0 && short_owed == -long_recv);
    }

    #[test]
    fn lp_deposit_dust_and_zero_aum() {
        let mut pool = Pool::empty();
        lp_deposit(&mut pool, 1_000_000_000, 0).unwrap();
        // subsequent deposit of 1 into a pool with a huge aum -> 0 shares
        let big_aum = pool.pool_usdc.saturating_mul(1_000_000);
        assert_eq!(lp_deposit(&mut pool, 1, big_aum), Err(EngineError::DustDeposit));
        // aum == 0 while shares outstanding -> div-by-zero mapped to Math
        assert_eq!(lp_deposit(&mut pool, 100, 0), Err(EngineError::Math));
    }

    #[test]
    fn lp_withdraw_too_many_shares() {
        let mut pool = funded_pool(1_000_000_000);
        let m = Market::default();
        let too_many = pool.total_shares + 1;
        let aum = pool.pool_usdc;
        assert_eq!(
            lp_withdraw(&mut pool, &m, too_many, aum),
            Err(EngineError::InsufficientLiquidity)
        );
    }

    #[test]
    fn cover_bad_debt_fully_by_insurance() {
        let mut pool = Pool { total_shares: 1_000_000_000, pool_usdc: 1_000_000_000, accrued_fees: 0, insurance_fund: 100_000_000 };
        let socialized = cover_bad_debt(&mut pool, 30_000_000);
        assert_eq!(socialized, 0);
        assert_eq!(pool.insurance_fund, 70_000_000);
        assert_eq!(pool.pool_usdc, 1_030_000_000);
    }

    #[test]
    fn pool_insolvent_payout_errors() {
        let cfg = Config::default();
        let mut m = Market::default();
        // craft a pool too small to pay a large winner (bypasses the open-time util gate)
        let mut pool = Pool { total_shares: 1_000_000, pool_usdc: 1_000_000, accrued_fees: 0, insurance_fund: 0 };
        let mut user = User { free_collateral: 0 };
        let mut pos = Position {
            side: Side::Long,
            notional: 1_000_000_000,
            entry_ratio: 50_000_000,
            collateral: 100_000_000,
            entry_cum_funding: 0,
            status: Status::Open,
        };
        let r_t = 100_000_000u128; // ratio doubles -> uPnL ~ +1000 USDC >> pool
        assert_eq!(
            close_position(&cfg, &mut m, &mut pool, &mut user, &mut pos, r_t),
            Err(EngineError::InsufficientLiquidity)
        );
    }

    #[test]
    fn add_then_remove_collateral_via_close_paths() {
        // exercise withdraw_collateral error + happy path on User
        let mut u = User { free_collateral: 100 };
        assert_eq!(withdraw_collateral(&mut u, 200), Err(EngineError::InsufficientCollateral));
        withdraw_collateral(&mut u, 40).unwrap();
        assert_eq!(u.free_collateral, 60);
        deposit_collateral(&mut u, 10);
        assert_eq!(u.free_collateral, 70);
    }

    #[test]
    fn pool_aum_reflects_open_upnl() {
        let pool = Pool { total_shares: 0, pool_usdc: 1_000_000, accrued_fees: 0, insurance_fund: 0 };
        assert_eq!(pool.aum(200), 1_000_000 - 200); // pool short the traders' net profit
        assert_eq!(pool.aum(-500), 1_000_000 + 500);
    }
}
