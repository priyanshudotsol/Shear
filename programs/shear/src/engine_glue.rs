//! Conversions between the Anchor account structs (`state`) and the pure, tested
//! `shear_math::engine` plain structs. The handlers load -> call engine -> store back.
//! This is the ONLY place the two representations meet; the math/accounting is the engine's.

use crate::state;
use shear_math::engine as eng;
use shear_math::Side as MSide;

pub fn side_to_engine(s: state::Side) -> MSide {
    match s {
        state::Side::Long => MSide::Long,
        state::Side::Short => MSide::Short,
    }
}

pub fn side_from_engine(s: MSide) -> state::Side {
    match s {
        MSide::Long => state::Side::Long,
        MSide::Short => state::Side::Short,
    }
}

pub fn status_from_engine(s: eng::Status) -> state::PositionStatus {
    match s {
        eng::Status::Open => state::PositionStatus::Open,
        eng::Status::Closed => state::PositionStatus::Closed,
        eng::Status::Liquidated => state::PositionStatus::Liquidated,
    }
}

/// Engine `Config` from the market's self-contained param snapshot.
pub fn cfg(m: &state::Market) -> eng::Config {
    eng::Config {
        taker_fee_bps: m.taker_fee_bps,
        liq_penalty_bps: m.liq_penalty_bps,
        liq_reward_share_bps: m.liq_reward_share_bps,
        insurance_cut_bps: m.insurance_cut_bps,
        min_collateral: m.min_collateral,
        min_position_notional: m.min_position_notional,
    }
}

pub fn load_market(m: &state::Market) -> eng::Market {
    eng::Market {
        long_oi: m.long_oi,
        short_oi: m.short_oi,
        cum_funding: m.cum_funding,
        last_funding_ts: m.last_funding_ts,
        max_leverage: m.max_leverage,
        mmr_bps: m.mmr_bps,
        k_funding_bps: m.k_funding_bps,
        f_max_bps: m.f_max_bps,
        oi_cap_abs: m.oi_cap_abs,
        max_net_util_bps: m.max_net_util_bps,
    }
}

pub fn store_market(dst: &mut state::Market, src: &eng::Market) {
    dst.long_oi = src.long_oi;
    dst.short_oi = src.short_oi;
    dst.cum_funding = src.cum_funding;
    dst.last_funding_ts = src.last_funding_ts;
}

pub fn load_pool(p: &state::LiquidityPool) -> eng::Pool {
    eng::Pool {
        total_shares: p.total_shares,
        pool_usdc: p.pool_usdc,
        accrued_fees: p.accrued_fees,
        insurance_fund: p.insurance_fund,
    }
}

pub fn store_pool(dst: &mut state::LiquidityPool, src: &eng::Pool) {
    dst.total_shares = src.total_shares;
    dst.pool_usdc = src.pool_usdc;
    dst.accrued_fees = src.accrued_fees;
    dst.insurance_fund = src.insurance_fund;
}

pub fn load_user(u: &state::UserBalance) -> eng::User {
    eng::User { free_collateral: u.free_collateral }
}

pub fn load_slot(p: &state::PositionSlot) -> eng::Position {
    eng::Position {
        side: side_to_engine(p.side),
        notional: p.notional,
        entry_ratio: p.entry_ratio,
        collateral: p.collateral,
        entry_cum_funding: p.entry_cum_funding,
        status: match p.status {
            state::PositionStatus::Open => eng::Status::Open,
            state::PositionStatus::Closed => eng::Status::Closed,
            state::PositionStatus::Liquidated => eng::Status::Liquidated,
        },
    }
}

pub fn store_slot(dst: &mut state::PositionSlot, src: &eng::Position) {
    dst.side = side_from_engine(src.side);
    dst.notional = src.notional;
    dst.entry_ratio = src.entry_ratio;
    dst.collateral = src.collateral;
    dst.entry_cum_funding = src.entry_cum_funding;
    dst.status = status_from_engine(src.status);
}
