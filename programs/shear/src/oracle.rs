//! Two-feed ratio read (oracle.md / magicblock-integration.md §5). Uses the vendored
//! `PriceUpdateV2`; feed_id == the price account's own pubkey bytes. Guards on BOTH legs.

use crate::error::ShearError;
use crate::vendored_pyth::PriceUpdateV2;
use anchor_lang::prelude::*;

/// Returns (raw ratio R scaled 1e9, composite confidence in bps).
/// Rejects: stale (either leg), non-positive price, exponent mismatch, confidence > max.
///
/// The single read path for every priced action, so entry, mark, PnL, and liquidation all use the
/// same raw SOL/ETH ratio frame. (Volatility amplification is intentionally not applied on-chain.)
pub fn read_ratio(
    base_ai: &AccountInfo,
    quote_ai: &AccountInfo,
    max_age: u64,
    max_conf_bps: u64,
) -> Result<(u128, u64)> {
    let clock = Clock::get()?;
    let base = PriceUpdateV2::try_deserialize_unchecked(&mut (*base_ai.data.borrow()).as_ref())?;
    let quote = PriceUpdateV2::try_deserialize_unchecked(&mut (*quote_ai.data.borrow()).as_ref())?;

    // staleness + feed binding on BOTH (feed_id = the account's own key bytes)
    let pb = base.get_price_no_older_than(&clock, max_age, &base_ai.key().to_bytes())?;
    let pq = quote.get_price_no_older_than(&clock, max_age, &quote_ai.key().to_bytes())?;

    require!(pb.price > 0 && pq.price > 0, ShearError::OracleStale);
    require!(pb.exponent == pq.exponent, ShearError::FeedMismatch);

    // composite ratio confidence (bps), additive = conservative upper bound
    let conf_bps = (pb.conf as u128) * 10_000 / (pb.price as u128)
        + (pq.conf as u128) * 10_000 / (pq.price as u128);
    require!(conf_bps <= max_conf_bps as u128, ShearError::OracleUncertain);

    let r = shear_math::compute_ratio(pb.price, pq.price)
        .map_err(|_| error!(ShearError::OracleStale))?;
    Ok((r, conf_bps as u64))
}

/// Confidence-widened liquidation buffer = N * conf_bps / 1e4  (in USDC), per MATH.md §5.
pub fn conf_buffer(notional: u64, conf_bps: u64) -> i128 {
    ((notional as u128) * (conf_bps as u128) / 10_000) as i128
}
