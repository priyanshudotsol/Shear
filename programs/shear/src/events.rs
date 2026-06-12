//! SHEAR events (from `instructions.md`). Emitted by the full-program instruction handlers.

use anchor_lang::prelude::*;
use crate::state::Side;

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub symbol: [u8; 16],
}

#[event]
pub struct CollateralDeposited {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CollateralWithdrawn {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PositionModified {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub slot: u8,
    pub collateral: u64,
}

#[event]
pub struct PositionOpened {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub slot: u8,
    pub side: Side,
    pub notional: u64,
    pub entry_ratio: u128,
    pub collateral: u64,
}

#[event]
pub struct PositionClosed {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub slot: u8,
    pub upnl: i128,
    pub funding_owed: i128,
    pub settlement: u64,
}

#[event]
pub struct Liquidated {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub slot: u8,
    pub liquidator: Pubkey,
    pub trader_gets: u64,
    pub liquidator_reward: u64,
    pub bad_debt: u64,
}

#[event]
pub struct FundingAccrued {
    pub market: Pubkey,
    pub skew: i128,
    pub funding_rate: i128,
    pub cum_funding: i128,
}

#[event]
pub struct LiquidityDeposited {
    pub lp: Pubkey,
    pub amount: u64,
    pub shares: u128,
}

#[event]
pub struct LiquidityWithdrawn {
    pub lp: Pubkey,
    pub shares: u128,
    pub amount: u64,
}

#[event]
pub struct BadDebtIncurred {
    pub market: Pubkey,
    pub amount: u64,
    pub from_insurance: u64,
    pub socialized: u64,
}

#[event]
pub struct OracleStaleSkipped {
    pub market: Pubkey,
}
