//! SHEAR program errors (from `instructions.md`). Map 1:1 from `shear_math::engine::EngineError`
//! plus the on-chain-only checks (auth, market state, oracle).

use anchor_lang::prelude::*;

#[error_code]
pub enum ShearError {
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("market is halted")]
    MarketHalted,
    #[msg("market is reduce-only")]
    ReduceOnly,
    #[msg("an open position already exists in this slot")]
    PositionExists,
    #[msg("position slot index out of range")]
    InvalidSlot,
    #[msg("position is not open")]
    PositionNotOpen,
    #[msg("position is not liquidatable")]
    PositionHealthy,
    #[msg("a position cannot be liquidated by its owner")]
    SelfLiquidation,
    #[msg("leverage exceeds the market maximum")]
    LeverageTooHigh,
    #[msg("collateral below the minimum")]
    BelowMinCollateral,
    #[msg("insufficient free collateral")]
    InsufficientCollateral,
    #[msg("notional below the dust floor")]
    DustPosition,
    #[msg("fee rounds to zero")]
    FeeRoundsToZero,
    #[msg("position would be immediately liquidatable")]
    WouldBeLiquidatable,
    #[msg("open interest or net-utilization cap exceeded")]
    OICapExceeded,
    #[msg("insufficient pool liquidity")]
    InsufficientLiquidity,
    #[msg("close all open positions before withdrawing")]
    CloseAllFirst,
    #[msg("an oracle feed is stale")]
    OracleStale,
    #[msg("oracle confidence is too wide")]
    OracleUncertain,
    #[msg("oracle feed does not match the market binding")]
    FeedMismatch,
    #[msg("arithmetic overflow")]
    MathOverflow,
}

impl From<shear_math::engine::EngineError> for ShearError {
    fn from(e: shear_math::engine::EngineError) -> Self {
        use shear_math::engine::EngineError as G;
        match e {
            G::LeverageTooHigh => ShearError::LeverageTooHigh,
            G::BelowMinCollateral => ShearError::BelowMinCollateral,
            G::DustPosition => ShearError::DustPosition,
            G::FeeRoundsToZero => ShearError::FeeRoundsToZero,
            G::InsufficientCollateral => ShearError::InsufficientCollateral,
            G::OICapExceeded => ShearError::OICapExceeded,
            G::WouldBeLiquidatable => ShearError::WouldBeLiquidatable,
            G::PositionNotOpen => ShearError::PositionNotOpen,
            G::PositionHealthy => ShearError::PositionHealthy,
            G::SelfLiquidation => ShearError::SelfLiquidation,
            G::InsufficientLiquidity => ShearError::InsufficientLiquidity,
            G::DustDeposit => ShearError::DustPosition,
            G::Math => ShearError::MathOverflow,
        }
    }
}
